import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Catalog } from "./catalog.js";
import { importFile } from "./imports.js";
import { decideReview, listReviews } from "./reviews.js";
import { toBibtex, toCsv } from "./exports.js";
import { importScholarSnapshot } from "./scholar.js";
import { addAuthor, configureOwner } from "./identities.js";

test("catalog workflows preserve distinct publications and derive incoming relations", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-test-"));
  try {
    const catalog = new Catalog({ root }); await catalog.initialize("Test Library");
    const preprint = await catalog.add({ citation_key: "Ada2025Example", type: "arxiv", title: "An Example Paper", authors: [{ name: "Ada Lovelace" }], submission_date: "2025-01-01", identifiers: { arxiv: "2501.00001v2" }, urls: [], tags: ["example"] });
    const conference = await catalog.add({ citation_key: "Ada2026Example", type: "conference", title: "An Example Paper, Revised", authors: [{ name: "Ada Lovelace" }], publication_date: "2026", identifiers: { doi: "https://doi.org/10.1000/EXAMPLE" }, urls: [], tags: [] });
    await catalog.addRelation(conference.id, preprint.id, "published_version_of");
    const details = await catalog.details(preprint.id); assert.equal(details.incoming_relations[0]?.source_id, conference.id); assert.equal(details.incoming_relations[0]?.label, "Published version");
    assert.equal((await catalog.get("10.1000/example")).id, conference.id); assert.equal((await catalog.get("2501.00001")).id, preprint.id);
    const validation = await catalog.validate(); assert.equal(validation.valid, true, JSON.stringify(validation.issues)); assert.match(toBibtex(await catalog.list()), /@inproceedings/); assert.match(toCsv(await catalog.list()), /citation_key/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("imports are idempotent and accepted through durable review", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-import-test-"));
  try {
    const catalog = new Catalog({ root }); await catalog.initialize(); const path = join(root, "source.bib");
    await writeFile(path, "@article{hopper2024,\n title={Compiler Notes},\n author={Grace Hopper},\n year={2024},\n doi={10.1000/compiler}\n}\n", "utf8");
    const first = await importFile(catalog, path); const second = await importFile(catalog, path); assert.deepEqual(second.review_ids, first.review_ids); assert.equal(second.duplicates, 1);
    const review = (await listReviews(catalog, "pending"))[0]!; await decideReview(catalog, review.id, "accepted"); assert.equal((await catalog.list()).length, 1); assert.equal((await listReviews(catalog, "accepted")).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("attachments are copied, deduplicated, hashed, and validated", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-attachment-test-"));
  try {
    const catalog = new Catalog({ root }); await catalog.initialize(); const publication = await catalog.add({ citation_key: "file2026", type: "other", title: "Files", authors: [{ name: "A Person" }] }); const source = join(root, "paper.pdf"); await writeFile(source, "%PDF fixture", "utf8");
    const first = await catalog.addAttachment(publication.id, source, "paper", "Manuscript"); const second = await catalog.addAttachment(publication.id, source, "paper"); assert.equal(second.id, first.id); assert.equal((await catalog.get(publication.id)).primary_attachment_id, first.id); assert.equal((await catalog.validate()).valid, true); assert.equal((await readFile(join(root, first.path), "utf8")), "%PDF fixture");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("partial Scholar snapshots preserve unknown counts and do not claim local omissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-scholar-test-"));
  try {
    const catalog = new Catalog({ root }); await catalog.initialize(); const publication = await catalog.add({ citation_key: "scholar2026", type: "journal", title: "Citation Paper", authors: [{ name: "A Person" }], publication_date: "2026" }); const owner = await addAuthor(catalog, { author_key: "self", preferred_name: "Self" }); await configureOwner(catalog, owner.id, "profile"); const source = join(root, "scholar.csv");
    await writeFile(source, "title,year,citation_count,scholar_id,observed_at\nCitation Paper,2026,,record-1,2026-09-01T00:00:00Z\n", "utf8"); const result = await importScholarSnapshot(catalog, source, "partial"); assert.deepEqual(result.matched, []); assert.deepEqual(result.local_only, [publication.id]); assert.deepEqual(result.candidates[0]?.publication_ids, [publication.id]); assert.equal((await catalog.read()).gscholar_entries[0]?.citation_history[0]?.count, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refresh imports do not erase unobserved fields or truncate curated authors", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-refresh-test-"));
  try {
    const catalog = new Catalog({ root }); await catalog.initialize(); await catalog.add({ citation_key: "complete2026", type: "journal", title: "Complete Record", authors: [{ name: "First Author" }, { name: "Second Author" }], publication_date: "2026", identifiers: { doi: "10.1000/complete" }, urls: ["https://example.test/paper"], tags: ["kept"] }); const source = join(root, "refresh.csv");
    await writeFile(source, "title,year,doi,authors\nComplete Record,2026,10.1000/complete,First Author\n", "utf8"); await importFile(catalog, source); const review = (await listReviews(catalog, "pending"))[0]!; assert.equal(review.proposals.some((change) => ["/authors", "/urls", "/tags"].includes(change.path ?? "")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
