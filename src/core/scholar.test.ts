import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Catalog } from "./catalog.js";
import { importScholarSnapshot } from "./scholar.js";
import { MyPubError } from "./errors.js";

const errorCode = (code: string) => (error: unknown): boolean => error instanceof MyPubError && error.code === code;

test("complete Scholar reconciliation reports differences, omissions, ambiguity, and shared counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-scholar-full-"));
  try {
    const catalog = new Catalog({ root }); await catalog.initialize(); const first = await catalog.add({ citation_key: "first", type: "journal", title: "Shared Paper", authors: [{ name: "A" }], venue: "Local Venue", dates: { issued: "2025" }, urls: ["https://scholar.google.test/record-shared"] }); const second = await catalog.add({ citation_key: "second", type: "conference", title: "Different Local Title", authors: [{ name: "B" }], venue: "Other", dates: { issued: "2024" }, urls: ["https://scholar.google.test/record-shared"] }); const omitted = await catalog.add({ citation_key: "omitted", type: "other", title: "Local Only", authors: [{ name: "C" }] });
    const source = join(root, "snapshot.csv"); await writeFile(source, 'title,year,venue,citation_count,scholar_id,article_url,observed_at\nShared Paper,2026,Observed Venue,12,record-shared,https://example.test,2026-09-02T00:00:00Z\nUnmatched,2025,,3,only-source,,2026-09-01T00:00:00Z\n', "utf8");
    const result = await importScholarSnapshot(catalog, source, "complete"); assert.equal(result.ambiguous.length, 1); assert.equal(result.source_only.length, 1); assert.deepEqual(new Set(result.local_only), new Set([omitted.id])); assert.deepEqual(new Set(result.shared_counts[0]?.publication_ids), new Set([first.id, second.id])); assert.equal(result.observed_at, "2026-09-02T00:00:00Z");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Scholar import validates file shape and citation counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-scholar-invalid-"));
  try {
    const catalog = new Catalog({ root }); await catalog.initialize(); const empty = join(root, "empty.csv"); const missingTitle = join(root, "missing.csv"); const negative = join(root, "negative.csv"); await writeFile(empty, "title\n", "utf8"); await writeFile(missingTitle, "title,citation_count\n,2\n", "utf8"); await writeFile(negative, "title,citation_count\nBad,-1\n", "utf8"); await assert.rejects(importScholarSnapshot(catalog, empty), errorCode("IMPORT_INVALID")); await assert.rejects(importScholarSnapshot(catalog, missingTitle), errorCode("IMPORT_INVALID")); await assert.rejects(importScholarSnapshot(catalog, negative), errorCode("IMPORT_INVALID"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
