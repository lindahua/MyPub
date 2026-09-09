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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mypub-audit-")); const c = new Catalog({ root }); await c.initialize();
  const author = await addAuthor(c, { author_key: "self", preferred_name: "Jane Doe" }); await configureOwner(c, author.id, "profile");
  const p = await c.add({ citation_key: "paper", type: "preprint", title: "New title", authors: [{ name: "Jane Doe", author_id: author.id }], publication_date: "2024-01-01", submission_date: "2024-01-01", identifiers: { arxiv: "2401.00001" }, arxiv_versions: [{ version: 1, submission_date: "2024-01-01", title: "Old title", authors: ["Jane Doe"], abstract: "Old" }, { version: 2, submission_date: "2024-02-01", title: "New title", authors: ["Jane Doe"], abstract: "New" }] });
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
    assert.match(cli(f.root, "--details").stdout, /Coverage:|SCHOLAR_PARTIAL_AUTHORS/);
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
    await f.c.archive(p.id); r = await f.c.audit(); assert.ok(!r.findings.some(x => x.record_ids.includes(p.id) && ["PUB_MISSING_DOI", "EMPTY_BYLINE", "PUB_MISSING_VOLUME"].includes(x.code)));
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
