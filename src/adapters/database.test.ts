import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../core/catalog.js";
import { addAuthor, addVenue, configureOwner, mergeIdentity, updateIdentity } from "../core/identities.js";
import { importScholarSnapshot, linkScholar } from "../core/scholar.js";
import { importFile } from "../core/imports.js";
import { decideReview } from "../core/reviews.js";
import { backup, restore } from "../core/backup.js";
import { initializeGit, sync } from "../core/sync.js";
import { catalogFiles } from "../core/paths.js";
import { atomicWriteJson, now, sha256, uuid } from "../core/utils.js";
import { MyPubError } from "../core/errors.js";
import { databasePath } from "./database.js";
import { run } from "./process.js";

const input = { citation_key: "one", type: "journal" as const, title: "First Paper", authors: [] };
const code = (expected: string) => (e: unknown) => e instanceof MyPubError && e.code === expected;
function rows(root: string, sql: string, ...args: SQLInputValue[]) {
  const db = new DatabaseSync(databasePath(root), { readOnly: true });
  try { return db.prepare(sql).all(...args).map(r => ({ ...r })); } finally { db.close(); }
}
const title = (root: string) => rows(root, "SELECT title FROM publications ORDER BY citation_key").map(r => r.title);
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "mypub-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = new Catalog({ root }); await c.initialize(); return { c, root };
}
async function configureGit(root: string) {
  await run("git", ["config", "user.name", "Database Tests"], root);
  await run("git", ["config", "user.email", "db@example.invalid"], root);
}

test("every catalog transaction refreshes integrated tables before returning", async t => {
  const { c, root } = await fixture(t);
  assert.deepEqual(title(root), []);
  const a = await addAuthor(c, { author_key: "alice", preferred_name: "Alice Example", aliases: ["A. E."] });
  const v = await addVenue(c, { venue_key: "journal", preferred_name: "Example Journal", kind: "journal" });
  const p = await c.add({ ...input, authors: [{ name: "A Example", author_id: a.id, roles: ["corresponding"] }], venue: { name: "Printed Journal", venue_id: v.id }, publication_date: "2026-02", identifiers: { arxiv: "2601.00001" }, tags: ["Theory"] });
  assert.deepEqual(title(root), [p.title]);
  assert.deepEqual(rows(root, "SELECT author_id,name,roles FROM author_bibliography"), [{ author_id: a.id, name: "A Example", roles: '["corresponding"]' }]);
  assert.deepEqual(rows(root, "SELECT year,publication_count FROM venue_year_summary"), [{ year: 2026, publication_count: 1 }]);
  const second = await c.add({ ...input, citation_key: "two", title: "Second Paper", identifiers: { arxiv: "2601.00001" } });
  await c.addRelation(second.id, p.id, "extends", "Longer treatment");
  assert.deepEqual(rows(root, "SELECT source_id,target_id,note FROM relations"), [{ source_id: second.id, target_id: p.id, note: "Longer treatment" }]);
  assert.equal(rows(root, "SELECT * FROM identifiers WHERE value='2601.00001'").length, 2);
  await assert.rejects(c.get("2601.00001"), code("AMBIGUOUS"));
  const file = join(root, "paper.pdf"); await writeFile(file, "%PDF fixture");
  const attachment = await c.addAttachment(p.id, file, "paper");
  assert.deepEqual(rows(root, "SELECT id,publication_id,is_primary FROM attachments"), [{ id: attachment.id, publication_id: p.id, is_primary: 1 }]);
  await c.update(p.id, { title: "Renamed Paper", publication_date: "2025" });
  assert.deepEqual(title(root), ["Renamed Paper", "Second Paper"]);
  assert.match(rows(root, "SELECT path FROM records WHERE id=?", p.id)[0]!.path as string, /2025\/renamed_paper_/);
  await updateIdentity(c, "author", a.id, { aliases: ["New Alias"] });
  assert.equal((await c.list({ query: "New Alias" }))[0]?.id, p.id);
  await c.archive(p.id);
  assert.equal(rows(root, "SELECT * FROM venue_year_summary WHERE venue_id=?", v.id).length, 0);
  await c.restorePublication(p.id); await c.removeRelation(second.id, p.id);
  assert.equal(rows(root, "SELECT * FROM relations").length, 0);
  assert.equal(rows(root, "SELECT * FROM venue_year_summary WHERE venue_id=?", v.id).length, 1);
  // All canonical JSON is retained losslessly, including fields without dedicated SQL columns.
  const state = await c.read();
  assert.deepEqual(new Map(rows(root, "SELECT path,json FROM records").map(r => [r.path, JSON.parse(r.json as string)])), catalogFiles(state));
});

test("SQL filters preserve exact identity, role, text, date and archive semantics", async t => {
  const { c } = await fixture(t);
  const a = await addAuthor(c, { author_key: "a", preferred_name: "Person One", aliases: ["Canonical Alias"] });
  const b = await addAuthor(c, { author_key: "b", preferred_name: "Person Two" });
  const v = await addVenue(c, { venue_key: "v", preferred_name: "Named Venue", kind: "conference", aliases: ["Venue Alias"] });
  const p = await c.add({ ...input, title: "Unicode École 100% _ ?", authors: [{ name: "First", author_id: b.id }, { name: "Second", author_id: a.id, roles: ["co_first", "corresponding"] }], venue: { name: "Printed Venue", venue_id: v.id }, publication_date: "2026", tags: ["Tag One"], identifiers: { doi: "10.1000/example" } });
  await c.add({ ...input, citation_key: "unresolved", authors: [{ name: "Person One" }], venue: { name: "Printed Venue" }, issued_date: "2025" });
  assert.deepEqual((await c.list({ author: a.author_key, role: "first" })).map(p => p.id), [p.id]);
  assert.equal((await c.list({ author: a.id, role: "first_listed" })).length, 0);
  assert.equal((await c.list({ author: b.id, role: "corresponding" })).length, 0);
  assert.equal((await c.list({ role: "corresponding" })).length, 1);
  assert.equal((await c.list({ role: "first_listed" })).length, 2);
  assert.equal((await c.list({ author: a.id, role: "co_first" })).length, 1);
  assert.equal((await c.list({ venue: v.venue_key })).length, 1);
  assert.equal((await c.list({ venue: "printed venue" })).length, 2);
  assert.equal((await c.list({ year: 2025 })).length, 1);
  for (const query of ["ÉCOLE", "100% _ ?", "Canonical Alias", "Venue Alias", "10.1000/example"]) assert.equal((await c.list({ query })).length, 1, query);
  assert.equal((await c.list({ query: "' OR 1=1 --" })).length, 0);
  assert.equal((await c.list({ tag: "tag one", year: 2026, type: "journal" })).length, 1);
  await assert.rejects(c.list({ author: "missing" }), code("NOT_FOUND"));
  await assert.rejects(c.get("missing"), code("NOT_FOUND"));
  assert.equal((await c.get("https://doi.org/10.1000/example")).id, p.id);
  await c.archive(p.id); assert.equal((await c.list({ query: "École" })).length, 0);
  assert.equal((await c.list({ includeArchived: true, query: "École" })).length, 1);
  const replacement = await addAuthor(c, { author_key: "replacement", preferred_name: "Replacement" });
  await mergeIdentity(c, "author", a.id, replacement.id, true);
  assert.equal((await c.list({ author: a.id, includeArchived: true }))[0]?.id, p.id);
});

test("Scholar captures, zero/null citations and review decisions refresh automatically", async t => {
  const { c, root } = await fixture(t);
  const a = await addAuthor(c, { author_key: "self", preferred_name: "Self" }); await configureOwner(c, a.id, "profile");
  const p = await c.add(input);
  const path = join(root, "capture.json");
  const capture = async (day: number, count: number | null) => {
    await writeFile(path, JSON.stringify({ profile_id: "profile", captured_at: `2026-09-0${day}T00:00:00Z`, coverage: "complete", entries: [{ scholar_id: "entry", title: "First Paper", citation_count: count, annual_counts: { "2025": 0, "2026": count } }] }));
    await importScholarSnapshot(c, path);
  };
  await capture(1, 0);
  const entryId = rows(root, "SELECT id FROM gscholar_entries")[0]!.id as string;
  await linkScholar(c, p.id, entryId);
  assert.equal(rows(root, "SELECT citation_count FROM publications")[0]?.citation_count, 0);
  await capture(2, null);
  assert.deepEqual(rows(root, "SELECT count FROM citation_observations ORDER BY position"), [{ count: 0 }, { count: null }]);
  assert.equal(rows(root, "SELECT citation_count FROM publications")[0]?.citation_count, null);
  assert.equal(rows(root, "SELECT * FROM scholar_captures").length, 2);
  assert.equal(rows(root, "SELECT * FROM annual_citations").length, 4);
  const source = join(root, "import.json"); await writeFile(source, JSON.stringify({ ...input, citation_key: "imported", title: "Imported" }));
  const imported = await importFile(c, source);
  assert.equal(rows(root, "SELECT * FROM review_queue WHERE id=?", imported.review_ids[0]!).length, 1);
  await decideReview(c, imported.review_ids[0]!, "accepted");
  assert.equal(rows(root, "SELECT * FROM review_queue WHERE id=?", imported.review_ids[0]!).length, 0);
  assert.equal(rows(root, "SELECT state FROM proposals WHERE review_id=?", imported.review_ids[0]!)[0]?.state, "accepted");
  assert.equal(title(root).length, 2);
});

test("external edits with unchanged mtime, renames, additions and deletions invalidate the cache", async t => {
  const { c, root } = await fixture(t); const p = await c.add(input);
  const oldPath = join(root, rows(root, "SELECT path FROM records WHERE id=?", p.id)[0]!.path as string);
  const before = await stat(oldPath);
  await writeFile(oldPath, JSON.stringify({ ...p, title: "Other Paper" })); await utimes(oldPath, before.atime, before.mtime);
  assert.equal((await c.list({ query: "Other Paper" }))[0]?.id, p.id);
  const moved = join(c.publicationsDir, "manual.json"); await rename(oldPath, moved);
  await c.read(); assert.equal(rows(root, "SELECT path FROM records WHERE id=?", p.id)[0]?.path, "catalog/publications/manual.json");
  const added = { ...p, id: uuid(), citation_key: "external" }; const extra = join(c.publicationsDir, "external.json"); await atomicWriteJson(extra, added);
  assert.equal((await c.list()).length, 2);
  await rm(extra); await rm(moved); assert.deepEqual(await c.list(), []); assert.deepEqual(title(root), []);
});

test("unchanged sources reuse the cache; missing, corrupt and incompatible databases rebuild automatically", async t => {
  const { c, root } = await fixture(t); await c.add(input);
  const initial = await stat(databasePath(root));
  await c.list(); await atomicWriteJson(join(c.localDir, "settings.json"), { arbitrary: "local-only" }); await c.read();
  assert.equal((await stat(databasePath(root))).ino, initial.ino);
  assert.equal((await stat(databasePath(root))).mtimeMs, initial.mtimeMs);
  await rm(databasePath(root)); await c.list(); assert.deepEqual(title(root), [input.title]);
  await writeFile(databasePath(root), "broken sqlite"); await c.get("one"); assert.deepEqual(title(root), [input.title]);
  for (const sql of ["UPDATE metadata SET value='999' WHERE key='version'", "DROP TABLE relations"]) {
    const db = new DatabaseSync(databasePath(root)); db.exec(sql); db.close();
    await c.read(); assert.deepEqual(title(root), [input.title]); assert.deepEqual(rows(root, "SELECT * FROM relations"), []);
  }
  const rebuilt = await c.rebuildIndex(); assert.equal(rebuilt.indexed, 1);
});

test("invalid external JSON or references never serve an old cache as current", async t => {
  const { c, root } = await fixture(t); const p = await c.add(input);
  const path = join(root, rows(root, "SELECT path FROM records WHERE id=?", p.id)[0]!.path as string);
  await writeFile(path, "{broken"); await assert.rejects(c.list(), code("INVALID_JSON"));
  assert.deepEqual(title(root), [input.title]);
  await atomicWriteJson(path, { ...p, authors: [{ name: "Missing", author_id: uuid() }] });
  await assert.rejects(c.get(p.id), code("VALIDATION_FAILED"));
  await atomicWriteJson(path, p); assert.equal((await c.get(p.id)).title, input.title);
});

test("failed refresh preserves saved JSON, reports saved=true and retries without repeating the edit", async t => {
  const { c, root } = await fixture(t);
  await rm(databasePath(root)); await mkdir(databasePath(root)); // Deterministic rename failure, including when tests run as root.
  await assert.rejects(c.add(input), (e: unknown) => code("CACHE_STALE")(e) && (e as MyPubError).details !== undefined && ((e as MyPubError).details as { saved: boolean }).saved);
  await assert.rejects(c.list(), code("CACHE_STALE"));
  assert.equal((await readdir(c.localDir)).filter(p => p.endsWith(".tmp")).length, 0);
  await rm(databasePath(root), { recursive: true });
  assert.equal((await c.list()).length, 1); assert.deepEqual(title(root), [input.title]);
});

test("readers see complete snapshots and competing app operations respect the catalog lock", async t => {
  const { c, root } = await fixture(t); const p = await c.add(input);
  const old = new DatabaseSync(databasePath(root), { readOnly: true });
  try {
    await c.update(p.id, { title: "Replacement" });
    assert.equal(old.prepare("SELECT title FROM publications").get()?.title, input.title);
    assert.deepEqual(title(root), ["Replacement"]);
  } finally { old.close(); }
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const write = c.change(async s => { entered(); await gate; s.publications[0]!.notes = "Atomic"; });
  await ready;
  try { await assert.rejects(new Catalog({ root }).list(), code("CATALOG_LOCKED")); }
  finally { release(); await write; }
  assert.equal((await c.get(p.id)).notes, "Atomic");
});

test("transaction recovery refreshes SQLite before returning", async t => {
  const { c, root } = await fixture(t); const p = await c.add(input);
  const path = rows(root, "SELECT path FROM records WHERE id=?", p.id)[0]!.path as string;
  const id = uuid(), directory = join(c.localDir, "transactions", id);
  await mkdir(join(directory, "data"), { recursive: true });
  const staged = join(directory, "data/0"); await atomicWriteJson(staged, { ...p, notes: "Recovered" });
  await atomicWriteJson(join(directory, "manifest.json"), { schema_version: 2, id, state: "ready", created_at: now(), updated_at: now(), operations: [{ type: "write", path, staged_path: "data/0", sha256: await sha256(staged) }] });
  await c.recover();
  assert.equal(JSON.parse(rows(root, "SELECT json FROM publications")[0]!.json as string).notes, "Recovered");
});

test("restore creates a local database without copying the source database", async t => {
  const { c, root } = await fixture(t); await c.add(input);
  const destination = await mkdtemp(join(tmpdir(), "mypub-db-restore-")); t.after(() => rm(destination, { recursive: true, force: true }));
  await backup(c, join(destination, "backup"), true);
  assert.equal((await readdir(join(destination, "backup"))).includes("local"), false);
  await writeFile(databasePath(root), "not backed up");
  const restored = new Catalog({ root: join(destination, "restored") }); await restore(restored, join(destination, "backup"));
  assert.deepEqual(title(restored.root), [input.title]);
  assert.match(await readFile(join(restored.root, ".gitignore"), "utf8"), /\/local\//);
});

test("existing ignore rules survive and SQLite, sidecars and rebuild files never enter Git", async t => {
  const { c, root } = await fixture(t);
  await writeFile(join(root, ".gitignore"), "custom-output/\n!/local/\n"); await c.initialize();
  assert.equal(await readFile(join(root, ".gitignore"), "utf8"), "custom-output/\n!/local/\n/local/\n");
  await initializeGit(c); await configureGit(root);
  for (const name of ["index.sqlite-wal", "index.sqlite-shm", "index.sqlite-journal", "index-test.sqlite.tmp"]) await writeFile(join(c.localDir, name), "ignored");
  await run("git", ["add", "."], root);
  assert.equal((await run("git", ["ls-files", "--", "local"], root)).stdout, "");
  for (const path of ["local/index.sqlite", "local/index.sqlite-wal", "local/index.sqlite-shm", "local/index.sqlite-journal", "local/index-test.sqlite.tmp"]) assert.equal((await run("git", ["check-ignore", path], root)).stdout.trim(), path);
  await sync(c);
  assert.equal((await run("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", "local"], root)).stdout, "");
  await run("git", ["add", "-f", "local/index.sqlite"], root);
  await assert.rejects(sync(c), code("LOCAL_TRACKED"));
});

test("sync integration and external Git reset refresh; fetch alone keeps the active view", { timeout: 30_000 }, async t => {
  const { c, root } = await fixture(t); const p = await c.add(input); await initializeGit(c); await configureGit(root); await sync(c);
  const original = (await run("git", ["rev-parse", "HEAD"], root)).stdout.trim();
  const container = await mkdtemp(join(tmpdir(), "mypub-db-sync-")); t.after(() => rm(container, { recursive: true, force: true }));
  const remote = join(container, "remote.git"); await run("git", ["init", "--bare", "--initial-branch=main", remote], container);
  await run("git", ["remote", "add", "origin", remote], root); await run("git", ["push", "-u", "origin", "main"], root);
  const cloneRoot = join(container, "clone"); await run("git", ["clone", remote, cloneRoot], container); await configureGit(cloneRoot);
  const other = new Catalog({ root: cloneRoot });
  await c.update(p.id, { title: "Remote Title" }); await sync(c);
  await run("git", ["fetch"], cloneRoot);
  assert.equal((await other.get(p.id)).title, input.title);
  await sync(other); assert.deepEqual(title(cloneRoot), ["Remote Title"]);
  await run("git", ["reset", "--hard", original], cloneRoot);
  assert.equal((await other.list())[0]?.title, input.title); assert.deepEqual(title(cloneRoot), [input.title]);
  // A remote that force-tracked local data must be rejected before checkout.
  await sync(c);
  await run("git", ["add", "-f", "local/index.sqlite"], root); await run("git", ["commit", "-m", "bad remote cache"], root); await run("git", ["push"], root);
  await assert.rejects(sync(other), code("LOCAL_TRACKED"));
  assert.deepEqual(title(cloneRoot), [input.title]);
});

test("abandoned staging before catalog initialization is cleaned without requiring a database", async t => {
  const root = await mkdtemp(join(tmpdir(), "mypub-db-init-")); t.after(() => rm(root, { recursive: true, force: true }));
  const id = uuid(); await atomicWriteJson(join(root, "local/transactions", id, "manifest.json"), { id, state: "staging" });
  const c = new Catalog({ root }); await c.initialize();
  assert.deepEqual(title(root), []);
  assert.deepEqual(await readdir(join(root, "local/transactions")), []);
});

test("a failed replacement keeps the previous complete database while the saved edit remains durable", async t => {
  const { c, root } = await fixture(t); const p = await c.add(input);
  const previous = await readFile(databasePath(root));
  await mkdir(`${databasePath(root)}-wal`); // Prevent replacement without modifying the old database.
  await assert.rejects(c.update(p.id, { title: "Saved New Title" }), code("CACHE_STALE"));
  assert.deepEqual(await readFile(databasePath(root)), previous);
  await assert.rejects(c.get(p.id), code("CACHE_STALE"));
  await rm(`${databasePath(root)}-wal`, { recursive: true });
  assert.deepEqual(title(root), [input.title]);
  assert.equal((await c.get(p.id)).title, "Saved New Title");
  assert.deepEqual(title(root), ["Saved New Title"]);
});
