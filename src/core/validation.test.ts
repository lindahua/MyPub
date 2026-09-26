import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Catalog, manualReview } from "./catalog.js";
import { MyPubError } from "./errors.js";
import { atomicWriteJson, safePath, withLock } from "./utils.js";
import { catalogFiles } from "./paths.js";
import type { Publication } from "./types.js";
import { validateState } from "./validation.js";

async function fixture(): Promise<{ root: string; catalog: Catalog }> { const root = await mkdtemp(join(tmpdir(), "mypub-validation-")); const catalog = new Catalog({ root }); await catalog.initialize("Validation"); return { root, catalog }; }
const errorCode = (code: string) => (error: unknown): boolean => error instanceof MyPubError && error.code === code;

test("catalog rejects duplicate identifiers, keys, missing records, and invalid relations", async () => {
  const { root, catalog } = await fixture();
  try {
    const first = await catalog.add({ citation_key: "one", type: "journal", title: "One", authors: [{ name: "A" }], identifiers: { doi: "10.1001/ONE" } });
    const second = await catalog.add({ citation_key: "two", type: "conference", title: "Two", authors: [{ name: "B" }] });
    await assert.rejects(catalog.add({ citation_key: "one", type: "other", title: "Duplicate", authors: [{ name: "C" }] }), errorCode("VALIDATION_FAILED"));
    await assert.rejects(catalog.add({ citation_key: "doi", type: "other", title: "Duplicate DOI", authors: [{ name: "C" }], identifiers: { doi: "https://doi.org/10.1001/one" } }), errorCode("VALIDATION_FAILED"));
    await catalog.archive(first.id);
    await assert.rejects(catalog.add({ citation_key: "archived-doi", type: "other", title: "Duplicate archived DOI", authors: [{ name: "C" }], identifiers: { doi: "10.1001/one" } }), errorCode("VALIDATION_FAILED"));
    await assert.rejects(catalog.get("missing"), errorCode("NOT_FOUND"));
    await assert.rejects(catalog.addRelation(first.id, first.id, "related_to"), errorCode("VALIDATION_FAILED"));
    await catalog.addRelation(first.id, second.id, "related_to", "Peers");
    await assert.rejects(catalog.addRelation(first.id, second.id, "related_to"), errorCode("VALIDATION_FAILED"));
    assert.equal((await catalog.removeRelation(first.id, second.id)).relations.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("catalog rejects a DOI that contradicts the official publication URL", async () => {
  const { root, catalog } = await fixture();
  try {
    await assert.rejects(catalog.add({ citation_key: "wrong", type: "conference", title: "Wrong DOI", authors: [{ name: "A" }], identifiers: { doi: "10.1145/one" }, official_url: "https://dl.acm.org/doi/10.1145/two" }), errorCode("VALIDATION_FAILED"));
    const paper = await catalog.add({ citation_key: "right", type: "conference", title: "Right DOI", authors: [{ name: "A" }], identifiers: { doi: "10.1145/one" }, official_url: "https://dl.acm.org/doi/10.1145/one" });
    await assert.rejects(catalog.update(paper.id, { official_url: "https://dl.acm.org/doi/10.1145/two" }), errorCode("VALIDATION_FAILED"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("OpenReview forum IDs remain unique and agree with official forum URLs", async () => {
  const { root, catalog } = await fixture();
  try {
    const paper = await catalog.add({ citation_key: "forum", type: "conference", title: "Forum paper", authors: [{ name: "A" }], identifiers: { openreview: "xI71dsS3o4" }, official_url: "https://openreview.net/forum?id=xI71dsS3o4" });
    assert.equal((await catalog.get("xI71dsS3o4")).id, paper.id);
    await assert.rejects(catalog.add({ citation_key: "mismatch", type: "conference", title: "Wrong forum", authors: [{ name: "A" }], identifiers: { openreview: "otherId" }, official_url: "https://openreview.net/forum?id=xI71dsS3o4" }), errorCode("VALIDATION_FAILED"));
    await catalog.archive(paper.id);
    await assert.rejects(catalog.add({ citation_key: "duplicate-forum", type: "conference", title: "Duplicate forum", authors: [{ name: "A" }], identifiers: { openreview: "xI71dsS3o4" } }), errorCode("VALIDATION_FAILED"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("published papers remove preprint links when a publication PDF is assigned", async () => {
  const { root, catalog } = await fixture();
  try {
    const paper = await catalog.add({ citation_key: "preprint-pending", type: "conference", title: "Conference paper", authors: [{ name: "A" }], paper_url: "https://arxiv.org/pdf/2601.12345", extra_urls: ["https://arxiv.org/abs/2601.12345"] });
    await assert.rejects(catalog.update(paper.id, { paper_url: "https://proceedings.example.org/paper.pdf" }), errorCode("VALIDATION_FAILED"));
    await catalog.update(paper.id, { paper_url: "https://proceedings.example.org/paper.pdf", extra_urls: [] });
    await assert.rejects(catalog.update(paper.id, { official_url: "https://arxiv.org/abs/2601.12345" }), errorCode("VALIDATION_FAILED"));
    await assert.rejects(catalog.add({ citation_key: "journal-preprint", type: "journal", title: "Journal paper", authors: [{ name: "B" }], paper_url: "https://journal.example.org/paper.pdf", extra_urls: ["https://www.biorxiv.org/content/10.1101/example"] }), errorCode("VALIDATION_FAILED"));
    await catalog.add({ citation_key: "workshop-preprint", type: "workshop", title: "Workshop paper", authors: [{ name: "C" }], paper_url: "https://arxiv.org/pdf/2601.12346", extra_urls: ["https://arxiv.org/abs/2601.12346"] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("historical review targets survive explicit publication removal, but open proposals require a target", async () => {
  const { root, catalog } = await fixture();
  try {
    const paper = await catalog.add({ citation_key: "duplicate", type: "conference", title: "Duplicate", authors: [{ name: "A" }] });
    const state = await catalog.read();
    const target = { entity_type: "publication" as const, entity_id: paper.id };
    state.reviews.push(manualReview("Past correction", [target]));
    const audit = manualReview("Evidence-only audit", [target]); audit.state = "pending"; delete audit.decided_at; state.reviews.push(audit);
    state.publications = state.publications.filter((publication) => publication.id !== paper.id);
    assert.equal(validateState(state).valid, true);
    const pending = manualReview("Pending edit", [target]); pending.state = "pending"; delete pending.decided_at; pending.proposals = [{ id: "33333333-3333-4333-8333-333333333333", target, operation: "archive", expected_revision: "0".repeat(64), state: "pending" }];
    state.reviews.push(pending);
    assert.equal(validateState(state).issues.some((issue) => issue.code === "REVIEW_TARGET"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("filters, archival, and initialization are stable", async () => {
  const { root, catalog } = await fixture();
  try {
    const paper = await catalog.add({ citation_key: "filter", type: "workshop", title: "Unicode Résumé Search", authors: [{ name: "Zoë" }], venue: { name: "Test Conf" }, publication_date: "2025-03", tags: ["ML"] });
    assert.equal((await catalog.list({ query: "resume", year: 2025, venue: "test conf", type: "workshop", tag: "ml" })).length, 1);
    await catalog.archive(paper.id); assert.equal((await catalog.list()).length, 0); assert.equal((await catalog.list({ includeArchived: true })).length, 1);
    assert.equal((await catalog.initialize("Ignored replacement")).name, "Validation");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("whole-catalog validation reports duplicate data, broken relations, cycles, and attachment state", async () => {
  const { root, catalog } = await fixture();
  try {
    const first = await catalog.add({ citation_key: "first", type: "journal", title: "First", authors: [{ name: "A" }] });
    const second = await catalog.add({ citation_key: "second", type: "journal", title: "Second", authors: [{ name: "B" }] });
    const paths = catalogFiles(await catalog.read()); const recordPath = (id: string): string => join(root, [...paths].find(([, value]) => (value as { id?: string }).id === id)![0]); const firstPath = recordPath(first.id); const secondPath = recordPath(second.id);
    const firstData = JSON.parse(await readFile(firstPath, "utf8")) as Publication; const secondData = JSON.parse(await readFile(secondPath, "utf8")) as Publication;
    firstData.relations = [{ type: "extends", target_id: second.id }, { type: "extends", target_id: second.id }];
    firstData.attachments = [{ id: "11111111-1111-4111-8111-111111111111", role: "paper", original_filename: "missing.pdf", media_type: "application/pdf", size_bytes: 10, storage: "git-lfs", path: `attachments/${first.id}/missing.pdf`, sha256: "a".repeat(64) }];
    secondData.citation_key = firstData.citation_key; secondData.relations = [{ type: "extends", target_id: first.id }, { type: "related_to", target_id: "99999999-9999-4999-8999-999999999999" }];
    await atomicWriteJson(firstPath, firstData); await atomicWriteJson(secondPath, secondData);
    const result = await catalog.validate(); const codes = new Set(result.issues.map((issue) => issue.code));
    assert.equal(result.valid, false); for (const code of ["DUPLICATE_CITATION_KEY", "DUPLICATE_RELATION", "BROKEN_REFERENCE", "RELATION_CYCLE", "ATTACHMENT_NOT_LOCAL"]) assert.equal(codes.has(code), true, code);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("utilities prevent path traversal and concurrent writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-utils-"));
  try {
    assert.throws(() => safePath(root, "../escape"), errorCode("UNSAFE_PATH"));
    const lock = join(root, "lock"); let release!: () => void; let entered!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const acquired = new Promise<void>((resolve) => { entered = resolve; }); const active = withLock(lock, () => { entered(); return gate; });
    await acquired; await assert.rejects(withLock(lock, async () => undefined), errorCode("CATALOG_LOCKED")); release(); await active;
  } finally { await rm(root, { recursive: true, force: true }); }
});
