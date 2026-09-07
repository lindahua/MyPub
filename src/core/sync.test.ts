import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Catalog } from "./catalog.js";
import { initializeGit, listConflicts, resolveConflict, status, sync } from "./sync.js";
import { run } from "../adapters/process.js";
import { atomicWriteJson } from "./utils.js";
import { MyPubError } from "./errors.js";

async function configureGit(root: string): Promise<void> { await run("git", ["config", "user.email", "tests@example.invalid"], root); await run("git", ["config", "user.name", "MyPub Tests"], root); }
const errorCode = (code: string) => (error: unknown): boolean => error instanceof MyPubError && error.code === code;

test("status distinguishes non-Git catalogs and local commits without upstreams", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-status-"));
  try {
    const catalog = new Catalog({ root }); await catalog.initialize(); const before = await status(catalog); assert.equal(before.git, false); assert.equal(before.catalog, "ready"); assert.deepEqual(await listConflicts(catalog), []);
    await initializeGit(catalog); await configureGit(root); const result = await sync(catalog, "initial catalog"); assert.equal(result.state, "up-to-date"); const after = await status(catalog); assert.equal(after.git, true); assert.equal(after.pending_upload, true); assert.equal(after.dirty, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sync persists conflicting alternatives and resolution restores the selected record", { timeout: 20_000 }, async () => {
  const container = await mkdtemp(join(tmpdir(), "mypub-sync-"));
  try {
    const seedRoot = join(container, "seed"); const seed = new Catalog({ root: seedRoot }); await seed.initialize(); const publication = await seed.add({ citation_key: "shared", type: "journal", title: "Original Title", authors: [{ name: "A" }] }); await initializeGit(seed); await configureGit(seedRoot); await sync(seed, "seed catalog");
    const remote = join(container, "remote.git"); await run("git", ["init", "--bare", "--initial-branch=main", remote], container); await run("git", ["remote", "add", "origin", remote], seedRoot); await run("git", ["push", "-u", "origin", "main"], seedRoot);
    const firstRoot = join(container, "first"); const secondRoot = join(container, "second"); await run("git", ["clone", remote, firstRoot], container); await run("git", ["clone", remote, secondRoot], container); await configureGit(firstRoot); await configureGit(secondRoot); const first = new Catalog({ root: firstRoot }); const second = new Catalog({ root: secondRoot });
    await first.update(publication.id, { title: "First Computer Title" }); assert.equal((await sync(first)).state, "pushed");
    await second.update(publication.id, { title: "Second Computer Title" }); const result = await sync(second); assert.equal(result.state, "needs-review"); assert.equal(result.conflicts.length, 1); assert.match(JSON.stringify(result.conflicts[0]?.ours), /Second Computer Title/); assert.match(JSON.stringify(result.conflicts[0]?.theirs), /First Computer Title/);
    await resolveConflict(second, result.conflicts[0]!.id, "ours"); assert.equal((await second.get(publication.id)).title, "Second Computer Title"); assert.equal((await second.validate(false)).valid, true); assert.equal((await sync(second)).state, "merged"); assert.deepEqual(await listConflicts(second), []);
  } finally { await rm(container, { recursive: true, force: true }); }
});

test("conflict paths reject invalid UUIDs", async () => { const root = await mkdtemp(join(tmpdir(), "mypub-resolve-")); try { const c = new Catalog({ root }); await c.initialize(); await assert.rejects(resolveConflict(c, "../escape", "ours"), errorCode("SCHEMA_INVALID")); } finally { await rm(root, { recursive: true, force: true }); } });
test("independent UUID edits merge despite a path change; duplicate external identities never activate", { timeout: 30_000 }, async () => {
  const { addAuthor } = await import("./identities.js"); const container = await mkdtemp(join(tmpdir(), "mypub-sync-independent-"));
  try {
    const seedRoot = join(container, "seed"), seed = new Catalog({ root: seedRoot }); await seed.initialize(); const p = await seed.add({ citation_key: "p", type: "other", title: "Original", authors: [] }); await initializeGit(seed); await configureGit(seedRoot); await sync(seed);
    const remote = join(container, "remote.git"); await run("git", ["init", "--bare", "--initial-branch=main", remote], container); await run("git", ["remote", "add", "origin", remote], seedRoot); await run("git", ["push", "-u", "origin", "main"], seedRoot);
    const root = join(container, "other"); await run("git", ["clone", remote, root], container); await configureGit(root); const other = new Catalog({ root });
    const remoteFile = join(container, "remote.txt"), localFile = join(container, "local.txt"); await writeFile(remoteFile, "remote supplement"); await writeFile(localFile, "local slides");
    await seed.addAttachment(p.id, remoteFile, "supplement"); await other.addAttachment(p.id, localFile, "slides");
    await seed.update(p.id, { title: "Remote Rename" }); await sync(seed); await other.update(p.id, { notes: "Independent local edit" }); assert.equal((await sync(other)).state, "merged"); assert.equal((await other.get(p.id)).title, "Remote Rename"); assert.equal((await other.get(p.id)).notes, "Independent local edit"); assert.equal((await other.get(p.id)).attachments.length, 2); assert.equal((await other.validate(true)).valid, true);
    await sync(seed); await addAuthor(seed, { author_key: "remote-person", preferred_name: "Person", identifiers: { google_scholar: "same-profile" } }); await sync(seed);
    await addAuthor(other, { author_key: "local-person", preferred_name: "Person", identifiers: { google_scholar: "same-profile" } }); const result = await sync(other); assert.equal(result.state, "needs-review"); assert.equal(result.conflicts[0]?.kind, "reference"); assert.equal((await other.read()).authors.length, 1); assert.equal((await other.validate(false)).valid, true);
  } finally { await rm(container, { recursive: true, force: true }); }
});
