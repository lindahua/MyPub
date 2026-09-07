import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Catalog } from "./catalog.js";
import { backup, restore } from "./backup.js";
import { toBibtex, toCsv } from "./exports.js";
import { importFile } from "./imports.js";
import { decideReview, getReview, listReviews } from "./reviews.js";
import { rebuildSearchIndex } from "../adapters/search.js";
import { run } from "../adapters/process.js";
import { MyPubError } from "./errors.js";

const errorCode = (code: string) => (error: unknown): boolean => error instanceof MyPubError && error.code === code;

test("CSV and JSON imports support review update, rejection, and deferral", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-review-"));
  try {
    const catalog = new Catalog({ root }); await catalog.initialize(); await catalog.add({ citation_key: "known", type: "journal", title: "Known, Quoted", authors: [{ name: "Author" }], identifiers: { doi: "10.1002/known" }, tags: ["old"] });
    const csv = join(root, "update.csv"); await writeFile(csv, 'title,authors,doi,tags\n"Known, Quoted",Author,10.1002/known,"new; tested"\n', "utf8"); await importFile(catalog, csv);
    const update = (await listReviews(catalog, "pending"))[0]!; assert.equal(update.kind, "import"); await decideReview(catalog, update.id, "accepted"); assert.deepEqual((await catalog.get("known")).tags, ["new", "tested"]);
    const json = join(root, "new.json"); await writeFile(json, JSON.stringify({ citation_key: "new", type: "other", title: "New", authors: [{ name: "N" }] }), "utf8"); await importFile(catalog, json);
    const create = (await listReviews(catalog, "pending"))[0]!; const deferred = await decideReview(catalog, create.id, "deferred", "later"); assert.equal(deferred.decision_note, "later"); const rejected = await decideReview(catalog, create.id, "rejected"); assert.equal(rejected.state, "rejected"); await assert.rejects(decideReview(catalog, create.id, "accepted"), errorCode("REVIEW_DECIDED")); assert.equal((await getReview(catalog, create.id)).state, "rejected");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid imports are rejected with useful errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-invalid-import-"));
  try {
    const catalog = new Catalog({ root }); await catalog.initialize(); const emptyBib = join(root, "empty.bib"); const badCsv = join(root, "bad.csv"); const badJson = join(root, "bad.json"); await writeFile(emptyBib, "not bibtex", "utf8"); await writeFile(badCsv, "authors\nNobody\n", "utf8"); await writeFile(badJson, "42", "utf8");
    await assert.rejects(importFile(catalog, emptyBib), errorCode("IMPORT_INVALID")); await assert.rejects(importFile(catalog, badCsv), errorCode("IMPORT_INVALID")); await assert.rejects(importFile(catalog, badJson), errorCode("IMPORT_INVALID"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exports escape content and the SQLite index contains all records", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-index-"));
  try {
    const catalog = new Catalog({ root }); await catalog.initialize(); await catalog.add({ citation_key: "escape", type: "journal", title: "A {Structured} Title", authors: [{ name: "A, Author" }], venue: { name: "Journal, One" }, publication_date: "2024", tags: ["one", "two"] });
    assert.match(toBibtex(await catalog.list()), /A \\{Structured\\} Title/); assert.match(toCsv(await catalog.list()), /"Journal, One"/); assert.equal(toBibtex([]), "");
    const rebuilt = await rebuildSearchIndex(catalog); assert.equal(rebuilt.indexed, 1); const database = new DatabaseSync(rebuilt.path, { readOnly: true }); try { assert.equal((database.prepare("SELECT COUNT(*) AS count FROM publications").get() as { count: number }).count, 1); } finally { database.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("backup and restore reproduce a catalog and refuse unsafe destinations", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-backup-source-")); const container = await mkdtemp(join(tmpdir(), "mypub-backup-target-"));
  try {
    const catalog = new Catalog({ root }); await catalog.initialize(); await catalog.add({ citation_key: "backup", type: "other", title: "Backup", authors: [{ name: "A" }] }); await run("git", ["init"], root); await run("git", ["config", "user.email", "test@example.invalid"], root); await run("git", ["config", "user.name", "Test"], root); await run("git", ["add", "."], root); await run("git", ["commit", "-m", "fixture"], root);
    await assert.rejects(backup(catalog, join(root, "inside")), errorCode("UNSAFE_PATH")); const destination = join(container, "backup"); await backup(catalog, destination); await assert.rejects(backup(catalog, destination), errorCode("BACKUP_EXISTS"));
    const restoredRoot = join(container, "restored"); const restored = new Catalog({ root: restoredRoot }); await restore(restored, destination); assert.equal((await restored.get("backup")).title, "Backup"); await assert.rejects(restore(restored, destination), errorCode("RESTORE_NOT_EMPTY"));
  } finally { await rm(root, { recursive: true, force: true }); await rm(container, { recursive: true, force: true }); }
});

test("process adapter captures success, allowed failure, and hard failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-process-"));
  try {
    assert.match((await run(process.execPath, ["--version"], root)).stdout, /^v/); assert.notEqual((await run(process.execPath, ["--definitely-invalid"], root, true)).code, 0); await assert.rejects(run(process.execPath, ["--definitely-invalid"], root), errorCode("PROCESS_FAILED")); await assert.rejects(run("missing-mypub-executable", [], root), errorCode("PROCESS_FAILED"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
