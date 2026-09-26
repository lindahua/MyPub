import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Catalog } from "./catalog.js";
import { auditRepository, duplicateJsonKeys } from "./audit.js";
import { addAuthor, configureOwner } from "./identities.js";
import { importScholarSnapshot, linkScholar } from "./scholar.js";
import { catalogFiles } from "./paths.js";
import { spawnSync } from "node:child_process";
import { acknowledgeAuditWarning } from "./reviews.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mypub-audit-")); const c = new Catalog({ root }); await c.initialize();
  const author = await addAuthor(c, { author_key: "self", preferred_name: "Jane Doe" }); await configureOwner(c, author.id, "profile");
  const p = await c.add({ citation_key: "paper", type: "preprint", title: "New title", authors: [{ name: "Jane Doe", author_id: author.id }], publication_date: "2024-01-01", submission_date: "2024-01-01", identifiers: { arxiv: "2401.00001", doi: "10.48550/arxiv.2401.00001" }, arxiv_versions: [{ version: 1, submission_date: "2024-01-01", title: "Old title", authors: ["Jane Doe"], abstract: "Old" }, { version: 2, submission_date: "2024-02-01", title: "New title", authors: ["Jane Doe"], abstract: "New" }] });
  const input = join(root, "capture.json"); await writeFile(input, JSON.stringify({ profile_id: "profile", captured_at: "2025-01-01T00:00:00Z", coverage: "partial", entries: [{ scholar_id: "entry", title: "Old title", authors: ["J. Doe"], authors_completeness: "partial", year: 2024, citation_count: null }] }));
  await importScholarSnapshot(c, input);
  const g = (await c.read()).gscholar_entries[0]!;
  await c.change(s => { s.gscholar_entries[0]!.pub_type = "preprint"; });
  await linkScholar(c, p.id, g.id);
  const files = catalogFiles(await c.read());
  const path = (id: string) => join(root, [...files].find(([, v]) => (v as { id?: string }).id === id)![0]);
  return { root, c, p, g, path };
}
const cli = (root: string, ...args: string[]) => spawnSync(process.execPath, [new URL("../cli/main.js", import.meta.url).pathname, "--root", root, "audit", ...args], { encoding: "utf8" });

test("duplicate JSON keys are found recursively including escaped keys", () => {
  assert.deepEqual(duplicateJsonKeys('{"a":1,"\\u0061":2,"x":[{"z":0,"z":1}],"b":{"a":3}}'), ["/a", "/x/0/z"]);
});

test("audit recognizes title history and partial initials and leaves all files unchanged", async () => {
  const f = await fixture(); try {
    const listing = await readdir(f.root, { recursive: true });
    const paths = listing.filter(p => p.endsWith(".json") || p.endsWith(".sqlite"));
    const before = await Promise.all(paths.map(p => readFile(join(f.root, p))));
    const r = await f.c.audit();
    assert.equal(r.complete, true); assert.equal(r.errors, 0, JSON.stringify(r.findings)); assert.ok(r.warnings > 0);
    assert.equal(r.statistics.links, 1); assert.deepEqual(r.cross_tab, [{ publication_type: "preprint", scholar_pub_type: "preprint", count: 1 }]);
    assert.ok(!r.findings.some(x => ["LINK_TITLE", "LINK_AUTHORS", "CITATION_CONFLICT"].includes(x.code)));
    assert.deepEqual(await readdir(f.root, { recursive: true }), listing);
    for (let i = 0; i < paths.length; i++) assert.deepEqual(await readFile(join(f.root, paths[i]!)), before[i]);
    const out = cli(f.root, "--json"); assert.equal(out.status, 0, out.stderr); assert.equal(JSON.parse(out.stdout).errors, 0);
    assert.match(cli(f.root, "--details").stdout, /Coverage:|SCHOLAR_AUTHORS_PARTIAL/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("accepted review records acknowledge an exact audit warning", async () => {
  const f = await fixture(); try {
    const before = await f.c.audit();
    const finding = before.findings.find(x => x.code === "SCHOLAR_AUTHORS_PARTIAL")!;
    const review = await acknowledgeAuditWarning(f.c, finding.fingerprint, "Scholar exposes a truncated byline; no correction is available.");
    assert.equal(review.state, "accepted"); assert.equal(review.evidence?.provider, "mypub-audit");
    const after = await f.c.audit();
    assert.equal(after.warnings, before.warnings - 1); assert.equal(after.acknowledged_warnings, 1);
    assert.equal(after.findings.find(x => x.fingerprint === finding.fingerprint)?.acknowledged_by, review.id);
    const normal = cli(f.root); assert.doesNotMatch(normal.stdout, /WARNING SCHOLAR_AUTHORS_PARTIAL/);
    const details = cli(f.root, "--details"); assert.match(details.stdout, new RegExp(`Acknowledged by: ${review.id}`));
    const repeated = cli(f.root, "acknowledge", finding.fingerprint, "--reason", "again"); assert.notEqual(repeated.status, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("publications without DOIs are admitted and audited as warnings", async () => {
  const f = await fixture(); try {
    const p = await f.c.add({ citation_key: "no-doi", type: "conference", title: "No assigned DOI yet", authors: [{ name: "Jane Doe" }] });
    let result = await f.c.audit();
    const finding = result.findings.find(x => x.code === "PUB_MISSING_DOI" && x.record_ids.includes(p.id));
    assert.equal(finding?.severity, "warning");
    assert.equal(result.errors, 0);
    assert.equal(cli(f.root).status, 0);
    await f.c.archive(p.id);
    result = await f.c.audit();
    assert.ok(!result.findings.some(x => x.code === "PUB_MISSING_DOI" && x.record_ids.includes(p.id)));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("active ICLR papers use OpenReview forum IDs in place of DOI warnings", async () => {
  const f = await fixture(); try {
    const venue = { name: "International Conference on Learning Representations" };
    const identified = await f.c.add({ citation_key: "iclr-forum", type: "conference", title: "ICLR paper", authors: [{ name: "Jane Doe" }], venue, identifiers: { openreview: "xI71dsS3o4" }, official_url: "https://proceedings.iclr.cc/paper_files/paper/2025/hash/example-Abstract-Conference.html" });
    const unresolved = await f.c.add({ citation_key: "iclr-unresolved", type: "conference", title: "Another ICLR paper", authors: [{ name: "Jane Doe" }], venue });
    let findings = (await f.c.audit()).findings;
    assert.ok(!findings.some(x => x.record_ids.includes(identified.id) && ["PUB_MISSING_DOI", "PUB_MISSING_OPENREVIEW"].includes(x.code)));
    assert.ok(findings.some(x => x.record_ids.includes(unresolved.id) && x.code === "PUB_MISSING_OPENREVIEW"));
    assert.ok(!findings.some(x => x.record_ids.includes(unresolved.id) && x.code === "PUB_MISSING_DOI"));
    await f.c.archive(unresolved.id); findings = (await f.c.audit()).findings;
    assert.ok(!findings.some(x => x.record_ids.includes(unresolved.id) && ["PUB_MISSING_DOI", "PUB_MISSING_OPENREVIEW"].includes(x.code)));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("audit checks ICLR paper URLs against the correct proceedings source by year", async () => {
  const f = await fixture(); try {
    const venue = { name: "International Conference on Learning Representations", event_year: 2025 };
    const outside = await f.c.add({ citation_key: "iclr-outside", type: "conference", title: "Outside PDF", authors: [{ name: "Jane Doe" }], venue, identifiers: { openreview: "outside123" }, paper_url: "https://openreview.net/pdf?id=outside123" });
    const proceedings = await f.c.add({ citation_key: "iclr-proceedings", type: "conference", title: "Proceedings PDF", authors: [{ name: "Jane Doe" }], venue, identifiers: { openreview: "proceedings123" }, paper_url: "https://proceedings.iclr.cc/paper_files/paper/2025/file/example-Paper-Conference.pdf" });
    const older = await f.c.add({ citation_key: "iclr-older", type: "conference", title: "Older PDF", authors: [{ name: "Jane Doe" }], venue: { ...venue, event_year: 2022 }, identifiers: { openreview: "older123" }, paper_url: "https://openreview.net/pdf?id=older123" });
    let findings = (await f.c.audit()).findings;
    assert.ok(findings.some(x => x.record_ids.includes(outside.id) && x.code === "ICLR_PAPER_URL_SOURCE"));
    assert.ok(!findings.some(x => x.record_ids.includes(proceedings.id) && x.code === "ICLR_PAPER_URL_SOURCE"));
    assert.ok(!findings.some(x => x.record_ids.includes(older.id) && x.code === "ICLR_PAPER_URL_SOURCE"));
    await f.c.change(s => { s.publications.find(p => p.id === older.id)!.paper_url = "https://openreview.net/pdf?id=some_other_paper"; });
    findings = (await f.c.audit()).findings;
    assert.ok(findings.some(x => x.record_ids.includes(older.id) && x.code === "ICLR_PAPER_URL_SOURCE"));
    await f.c.archive(outside.id);
    findings = (await f.c.audit()).findings;
    assert.ok(!findings.some(x => x.record_ids.includes(outside.id) && x.code === "ICLR_PAPER_URL_SOURCE"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("audit accepts PMLR page PDFs for CoRL, including PMLR's GitHub files", async () => {
  const f = await fixture(); try {
    const venue = { name: "Conference on Robot Learning" };
    const direct = await f.c.add({ citation_key: "corl-direct", type: "conference", title: "Direct PDF", authors: [{ name: "Jane Doe" }], venue, paper_url: "https://proceedings.mlr.press/v164/wang22i/wang22i.pdf" });
    const github = await f.c.add({ citation_key: "corl-github", type: "conference", title: "GitHub PDF", authors: [{ name: "Jane Doe" }], venue, paper_url: "https://raw.githubusercontent.com/mlresearch/v270/main/assets/xu25c/xu25c.pdf" });
    const other = await f.c.add({ citation_key: "corl-other", type: "conference", title: "Other PDF", authors: [{ name: "Jane Doe" }], venue, paper_url: "https://arxiv.org/pdf/2410.13860" });
    let findings = (await f.c.audit()).findings;
    assert.ok(!findings.some(x => [direct.id, github.id].some(id => x.record_ids.includes(id)) && x.code === "CORL_PAPER_URL_SOURCE"));
    assert.ok(findings.some(x => x.record_ids.includes(other.id) && x.code === "CORL_PAPER_URL_SOURCE"));
    await f.c.archive(other.id);
    findings = (await f.c.audit()).findings;
    assert.ok(!findings.some(x => x.record_ids.includes(other.id) && x.code === "CORL_PAPER_URL_SOURCE"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("audit checks active IJCV paper URLs against the Springer PDF for their DOI", async () => {
  const f = await fixture(); try {
    const venue = { name: "International Journal of Computer Vision" };
    const identifiers = { doi: "10.1007/s11263-025-02428-0" };
    const correct = await f.c.add({ citation_key: "ijcv-correct", type: "journal", title: "Correct IJCV PDF", authors: [{ name: "Jane Doe" }], venue, identifiers, paper_url: "https://link.springer.com/content/pdf/10.1007/s11263-025-02428-0.pdf" });
    const missing = await f.c.add({ citation_key: "ijcv-missing", type: "journal", title: "Missing IJCV PDF", authors: [{ name: "Jane Doe" }], venue });
    const preprint = await f.c.add({ citation_key: "ijcv-preprint", type: "journal", title: "Preprint URL", authors: [{ name: "Jane Doe" }], venue, paper_url: "https://arxiv.org/pdf/2401.07641" });
    let findings = (await f.c.audit()).findings;
    assert.ok(!findings.some(x => x.record_ids.includes(correct.id) && x.code === "IJCV_PAPER_URL_SOURCE"));
    assert.ok(findings.some(x => x.record_ids.includes(missing.id) && x.code === "IJCV_PAPER_URL_SOURCE"));
    assert.ok(findings.some(x => x.record_ids.includes(preprint.id) && x.code === "IJCV_PAPER_URL_SOURCE"));
    await f.c.archive(preprint.id);
    findings = (await f.c.audit()).findings;
    assert.ok(!findings.some(x => x.record_ids.includes(preprint.id) && x.code === "IJCV_PAPER_URL_SOURCE"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("audit requires IEEE Transactions paper URLs to match official PDF buttons", async () => {
  const f = await fixture(); try {
    const base = { type: "journal" as const, authors: [{ name: "Jane Doe" }], venue: { name: "IEEE Transactions on Pattern Analysis and Machine Intelligence" }, official_url: "https://ieeexplore.ieee.org/document/4775283/" };
    const correct = await f.c.add({ ...base, citation_key: "ieee-correct", title: "Publisher PDF button", paper_url: "https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=4775283" });
    const author = await f.c.add({ ...base, citation_key: "ieee-author", title: "Author PDF URL", paper_url: "https://author.example/paper.pdf" });
    const wrong = await f.c.add({ ...base, citation_key: "ieee-wrong", title: "Wrong document", paper_url: "https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=1234567" });
    let findings = (await f.c.audit()).findings.filter(x => x.code === "IEEE_TRANSACTIONS_PAPER_URL_SOURCE");
    assert.ok(!findings.some(x => x.record_ids.includes(correct.id)));
    assert.ok(findings.some(x => x.record_ids.includes(author.id)));
    assert.ok(findings.some(x => x.record_ids.includes(wrong.id)));
    await f.c.archive(author.id);
    findings = (await f.c.audit()).findings.filter(x => x.code === "IEEE_TRANSACTIONS_PAPER_URL_SOURCE");
    assert.ok(!findings.some(x => x.record_ids.includes(author.id)));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("audit checks SIGGRAPH paper URLs against their ACM View PDF links", async () => {
  const f = await fixture(); try {
    const venue = { name: "ACM SIGGRAPH 2026 Conference Papers" };
    const correct = await f.c.add({ citation_key: "siggraph-correct", type: "conference", title: "SIGGRAPH PDF", authors: [{ name: "Jane Doe" }], venue, identifiers: { doi: "10.1145/3799902.3811054" }, paper_url: "https://dl.acm.org/doi/pdf/10.1145/3799902.3811054" });
    const preprint = await f.c.add({ citation_key: "siggraph-preprint", type: "conference", title: "SIGGRAPH preprint", authors: [{ name: "Jane Doe" }], venue, identifiers: { doi: "10.1145/3721238.3730643" }, paper_url: "https://arxiv.org/pdf/2408.13252" });
    const missing = await f.c.add({ citation_key: "siggraph-missing", type: "conference", title: "SIGGRAPH without PDF", authors: [{ name: "Jane Doe" }], venue });
    let findings = (await f.c.audit()).findings;
    assert.ok(!findings.some(x => x.record_ids.includes(correct.id) && x.code === "SIGGRAPH_PAPER_URL_SOURCE"));
    assert.ok(findings.some(x => x.record_ids.includes(preprint.id) && x.code === "SIGGRAPH_PAPER_URL_SOURCE"));
    assert.ok(findings.some(x => x.record_ids.includes(missing.id) && x.code === "SIGGRAPH_PAPER_URL_SOURCE"));
    await f.c.archive(preprint.id);
    findings = (await f.c.audit()).findings;
    assert.ok(!findings.some(x => x.record_ids.includes(preprint.id) && x.code === "SIGGRAPH_PAPER_URL_SOURCE"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("audit checks ACM Digital Library paper URLs for active non-SIGGRAPH records", async () => {
  const f = await fixture(); try {
    const base = { type: "conference" as const, authors: [{ name: "Jane Doe" }], venue: { name: "ACM Conference" } };
    const good = await f.c.add({ ...base, citation_key: "acm-pdf", title: "Publisher PDF", identifiers: { doi: "10.1145/1234.5678" }, official_url: "https://dl.acm.org/doi/10.1145/1234.5678", paper_url: "https://dl.acm.org/doi/pdf/10.1145/1234.5678" });
    const reader = await f.c.add({ ...base, citation_key: "acm-reader", title: "Publisher reader", identifiers: { doi: "10.1145/1234.5679" }, official_url: "https://dl.acm.org/doi/10.1145/1234.5679", paper_url: "https://dl.acm.org/doi/epdf/10.1145/1234.5679" });
    const wrong = await f.c.add({ ...base, citation_key: "acm-wrong", title: "Wrong PDF", identifiers: { doi: "10.1145/1234.5680" }, official_url: "https://dl.acm.org/doi/10.1145/1234.5680", paper_url: "https://dl.acm.org/doi/pdf/10.1145/1234.5678" });
    const missing = await f.c.add({ ...base, citation_key: "acm-missing", title: "No PDF", identifiers: { doi: "10.1145/1234.5681" }, official_url: "https://dl.acm.org/doi/10.1145/1234.5681" });
    let findings = (await f.c.audit()).findings.filter(x => x.code === "ACM_PAPER_URL_SOURCE");
    assert.ok(!findings.some(x => x.record_ids.includes(good.id) || x.record_ids.includes(reader.id)));
    assert.ok(findings.some(x => x.record_ids.includes(wrong.id)));
    assert.ok(findings.some(x => x.record_ids.includes(missing.id)));
    await f.c.archive(wrong.id);
    findings = (await f.c.audit()).findings.filter(x => x.code === "ACM_PAPER_URL_SOURCE");
    assert.ok(!findings.some(x => x.record_ids.includes(wrong.id)));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("active ICML conference papers may omit a DOI without a warning", async () => {
  const f = await fixture(); try {
    const icml = await f.c.add({ citation_key: "icml-no-doi", type: "conference", title: "ICML paper", authors: [{ name: "Jane Doe" }], venue: { name: "International Conference on Machine Learning" } });
    const workshop = await f.c.add({ citation_key: "icml-workshop-no-doi", type: "workshop", title: "ICML workshop paper", authors: [{ name: "Jane Doe" }], venue: { name: "International Conference on Machine Learning" } });
    const findings = (await f.c.audit()).findings;
    assert.ok(!findings.some(x => x.record_ids.includes(icml.id) && x.code === "PUB_MISSING_DOI"));
    assert.ok(findings.some(x => x.record_ids.includes(workshop.id) && x.code === "PUB_MISSING_DOI"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("audit distinguishes unknown from known-partial Scholar author lists", async () => {
  const f = await fixture(); try {
    let findings = (await f.c.audit()).findings;
    assert.ok(findings.some(item => item.code === "SCHOLAR_AUTHORS_PARTIAL"));
    assert.ok(!findings.some(item => item.code === "SCHOLAR_AUTHORS_UNKNOWN"));
    await f.c.change(state => { state.gscholar_entries[0]!.authors_completeness = "unknown"; });
    findings = (await f.c.audit()).findings;
    assert.ok(findings.some(item => item.code === "SCHOLAR_AUTHORS_UNKNOWN"));
    assert.ok(!findings.some(item => item.code === "SCHOLAR_AUTHORS_PARTIAL"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("cardinality and type errors do not change write-time validation", async () => {
  const f = await fixture(); try {
    const p = await f.c.add({ citation_key: "second", type: "journal", title: "Old title", authors: [], gscholar_entry_id: f.g.id });
    assert.equal((await f.c.validate(false)).valid, true);
    const r = await f.c.audit();
    const finding = r.findings.find(x => x.code === "SCHOLAR_MULTIPLE_PUBLICATIONS")!;
    assert.ok(finding.record_ids.includes(p.id)); assert.ok(finding.record_ids.includes(f.p.id)); assert.ok(finding.record_ids.includes(f.g.id));
    assert.equal(r.findings.filter(x => x.code === "SCHOLAR_MULTIPLE_PUBLICATIONS").length, 1);
    assert.ok(r.findings.some(x => x.code === "LINK_TYPE" && x.severity === "error"));
    assert.equal(cli(f.root).status, 4);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("malformed records do not hide valid records and ambiguous links are explicit", async () => {
  const f = await fixture(); try {
    const source = await readFile(f.path(f.g.id), "utf8");
    await writeFile(join(f.root, "catalog/gscholar/entries/duplicate.json"), source);
    await writeFile(join(f.root, "catalog/publications/broken.json"), "{bad json");
    await writeFile(join(f.root, "catalog/publications/missing.json"), '{"schema_version":2,"title":"A","title":"B"}');
    const r = await f.c.audit(); const codes = r.findings.map(x => x.code);
    for (const code of ["INVALID_JSON", "SCHEMA_INVALID", "DUPLICATE_JSON_KEY", "DUPLICATE_UUID", "LINK_AMBIGUOUS"]) assert.ok(codes.includes(code), code);
    assert.equal(r.complete, true); assert.equal(r.counts_complete, false); assert.ok(r.skipped.length > 0);
    assert.equal(r.statistics.links, 0); assert.equal(cli(f.root, "--json").status, 4);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("audit missing roots and unreadable symlinks report operational incompleteness", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-audit-incomplete-"));
  try {
    assert.equal((await auditRepository(root)).complete, false); assert.equal(cli(root).status, 1);
    const c = new Catalog({ root }); await c.initialize();
    await mkdir(join(root, "catalog/publications"), { recursive: true });
    await symlink("/nonexistent-mypub-audit-target", join(root, "catalog/publications/link.json"));
    const r = await c.audit(); assert.equal(r.complete, false); assert.ok(r.files.unreadable > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("precision, archived completeness, current revisions and independent comparisons", async () => {
  const f = await fixture(); try {
    const p = await f.c.add({ citation_key: "dates", type: "journal", title: "Dates", authors: [], submission_date: "2024", acceptance_date: "2024-01", publication_date: "2024", issued_date: "2024-06" });
    let r = await f.c.audit(); assert.ok(!r.findings.some(x => x.record_ids.includes(p.id) && ["DATE_ORDER", "PUB_ISSUE_DATE"].includes(x.code)));
    await f.c.archive(p.id); r = await f.c.audit(); assert.ok(!r.findings.some(x => x.record_ids.includes(p.id) && x.code === "PUB_MISSING_DOI")); assert.ok(!r.findings.some(x => x.record_ids.includes(p.id) && ["EMPTY_BYLINE", "PUB_MISSING_VOLUME"].includes(x.code)));
    const value = JSON.parse(await readFile(f.path(f.p.id), "utf8")); value.title = "Different current title"; await writeFile(f.path(f.p.id), JSON.stringify(value));
    const g = JSON.parse(await readFile(f.path(f.g.id), "utf8")); g.title = "Unrelated title"; g.year = 2023; g.authors = ["Someone Else"]; await writeFile(f.path(f.g.id), JSON.stringify(g));
    r = await f.c.audit(); for (const code of ["ARXIV_CURRENT_VERSION", "LINK_TITLE", "LINK_YEAR", "LINK_AUTHORS"]) assert.ok(r.findings.some(x => x.code === code), code);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("current arXiv author and abstract differences warn independently of title errors", async () => {
  const f = await fixture(); try {
    const p = JSON.parse(await readFile(f.path(f.p.id), "utf8"));
    p.arxiv_versions[1].authors = ["Jane Doee"];
    await writeFile(f.path(f.p.id), JSON.stringify(p));
    let r = await f.c.audit();
    const warning = r.findings.find(x => x.code === "ARXIV_CURRENT_AUTHORS");
    assert.equal(warning?.severity, "warning");
    assert.deepEqual(warning?.values, { current: ["Jane Doe"], latest: ["Jane Doee"] });
    assert.equal(r.errors, 0); assert.equal(cli(f.root).status, 0);
    for (const field of ["abstract", "title"]) {
      const changed = { ...p, [field]: "Different current text" };
      await writeFile(f.path(f.p.id), JSON.stringify(changed));
      r = await f.c.audit();
      assert.ok(r.findings.some(x => x.code === "ARXIV_CURRENT_AUTHORS" && x.severity === "warning"));
      if (field === "abstract") {
        const abstract = r.findings.find(x => x.code === "ARXIV_CURRENT_ABSTRACT");
        assert.equal(abstract?.severity, "warning");
        assert.deepEqual(abstract?.values, { current: "Different current text", latest: "New" });
        assert.equal(r.errors, 0); assert.equal(cli(f.root).status, 0);
      } else {
        assert.ok(r.findings.some(x => x.code === "ARXIV_CURRENT_VERSION" && x.severity === "error"));
        assert.equal(cli(f.root).status, 4);
      }
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("incomplete revision metadata is reported without aborting other comparisons", async () => {
  const f = await fixture(); try {
    const p = JSON.parse(await readFile(f.path(f.p.id), "utf8"));
    delete p.arxiv_versions[1].title; delete p.arxiv_versions[1].authors; delete p.arxiv_versions[1].abstract;
    await writeFile(f.path(f.p.id), JSON.stringify(p));
    const r = await f.c.audit();
    assert.equal(r.complete, true); assert.ok(r.findings.some(x => x.code === "ARXIV_HISTORY"));
    assert.equal(r.statistics.links, 1); assert.ok(!r.findings.some(x => x.code === "LINK_TITLE"));
    assert.equal(cli(f.root, "--not-an-option").status, 2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("identity aliases, explicit identifiers, source dates and incomplete matching policy", async () => {
  const f = await fixture(); try {
    await f.c.change(s => { s.authors[0]!.aliases.push("Jane Alternative"); });
    const g = JSON.parse(await readFile(f.path(f.g.id), "utf8"));
    g.authors = ["J. Alternative"]; g.authors_completeness = "complete";
    g.scholar_url = "https://arxiv.org/abs/2401.99999v2";
    g.publication_date = "2023/99/99";
    await writeFile(f.path(f.g.id), JSON.stringify(g));
    let r = await f.c.audit();
    assert.ok(!r.findings.some(x => x.code === "LINK_AUTHORS"));
    assert.ok(!r.findings.some(x => x.code === "SCHOLAR_YEAR_DATE"));
    assert.ok(r.findings.some(x => x.code === "LINK_IDENTIFIER"));
    g.pub_type = "incomplete"; g.publication_date = "2023/1/2"; g.authors = [];
    await writeFile(f.path(f.g.id), JSON.stringify(g)); r = await f.c.audit();
    for (const code of ["SCHOLAR_INCOMPLETE_ELIGIBLE", "SCHOLAR_YEAR_DATE", "SCHOLAR_COMPLETE_BYLINE"]) assert.ok(r.findings.some(x => x.code === code), code);
    assert.ok(r.skipped.some(x => x.check.startsWith("authors ")));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("unambiguous date conflicts and linked types are separate findings", async () => {
  const f = await fixture(); try {
    const p = JSON.parse(await readFile(f.path(f.p.id), "utf8"));
    p.type = "journal"; delete p.arxiv_versions;
    p.publication_date = "2024-01"; p.issued_date = "2024-02";
    p.submission_date = "2024-03"; p.acceptance_date = "2024-02";
    await writeFile(f.path(f.p.id), JSON.stringify(p));
    const r = await f.c.audit();
    assert.ok(r.findings.some(x => x.code === "PUB_ISSUE_DATE"));
    assert.equal(r.findings.filter(x => x.code === "DATE_ORDER").length, 2);
    assert.ok(r.findings.some(x => x.code === "LINK_TYPE"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
