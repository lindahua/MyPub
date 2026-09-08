import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Catalog } from "./catalog.js";
import { commit, initializeGit, listConflicts, resolveConflict, status, sync } from "./sync.js";
import { run } from "../adapters/process.js";
import { atomicWriteJson } from "./utils.js";
import { MyPubError } from "./errors.js";

async function configureGit(root: string): Promise<void> { await run("git", ["config", "user.email", "tests@example.invalid"], root); await run("git", ["config", "user.name", "MyPub Tests"], root); }
const errorCode = (code: string) => (error: unknown): boolean => error instanceof MyPubError && error.code === code;

test("status distinguishes non-Git catalogs and local commits without upstreams", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-status-"));
  try {
    const catalog = new Catalog({ root }); await catalog.initialize(); const before = await status(catalog); assert.equal(before.git, false); assert.equal(before.catalog, "ready"); assert.deepEqual(await listConflicts(catalog), []);
    await initializeGit(catalog); await configureGit(root); const result = await commit(catalog, "initial catalog"); assert.equal(result.state, "committed"); const after = await status(catalog); assert.equal(after.git, true); assert.equal(after.pending_upload, true); assert.equal(after.dirty, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sync persists conflicting alternatives and resolution restores the selected record", { timeout: 20_000 }, async () => {
  const container = await mkdtemp(join(tmpdir(), "mypub-sync-"));
  try {
    const seedRoot = join(container, "seed"); const seed = new Catalog({ root: seedRoot }); await seed.initialize(); const publication = await seed.add({ citation_key: "shared", type: "journal", title: "Original Title", authors: [{ name: "A" }] }); await initializeGit(seed); await configureGit(seedRoot); await commit(seed, "seed catalog");
    const remote = join(container, "remote.git"); await run("git", ["init", "--bare", "--initial-branch=main", remote], container); await run("git", ["remote", "add", "origin", remote], seedRoot); await run("git", ["push", "-u", "origin", "main"], seedRoot);
    const firstRoot = join(container, "first"); const secondRoot = join(container, "second"); await run("git", ["clone", remote, firstRoot], container); await run("git", ["clone", remote, secondRoot], container); await configureGit(firstRoot); await configureGit(secondRoot); const first = new Catalog({ root: firstRoot }); const second = new Catalog({ root: secondRoot });
    await first.update(publication.id, { title: "First Computer Title" }); await commit(first); assert.equal((await sync(first)).state, "pushed");
    await second.update(publication.id, { title: "Second Computer Title" }); await commit(second); const result = await sync(second); assert.equal(result.state, "needs-review"); assert.equal(result.conflicts.length, 1); assert.match(JSON.stringify(result.conflicts[0]?.ours), /Second Computer Title/); assert.match(JSON.stringify(result.conflicts[0]?.theirs), /First Computer Title/);
    await resolveConflict(second, result.conflicts[0]!.id, "ours"); assert.equal((await second.get(publication.id)).title, "Second Computer Title"); assert.equal((await second.validate(false)).valid, true); assert.equal((await sync(second)).state, "merged"); assert.deepEqual(await listConflicts(second), []);
  } finally { await rm(container, { recursive: true, force: true }); }
});

test("conflict paths reject invalid UUIDs", async () => { const root = await mkdtemp(join(tmpdir(), "mypub-resolve-")); try { const c = new Catalog({ root }); await c.initialize(); await assert.rejects(resolveConflict(c, "../escape", "ours"), errorCode("SCHEMA_INVALID")); } finally { await rm(root, { recursive: true, force: true }); } });
test("independent UUID edits merge despite a path change; duplicate external identities never activate", { timeout: 30_000 }, async () => {
  const { addAuthor } = await import("./identities.js"); const container = await mkdtemp(join(tmpdir(), "mypub-sync-independent-"));
  try {
    const seedRoot = join(container, "seed"), seed = new Catalog({ root: seedRoot }); await seed.initialize(); const p = await seed.add({ citation_key: "p", type: "other", title: "Original", authors: [] }); await initializeGit(seed); await configureGit(seedRoot); await commit(seed);
    const remote = join(container, "remote.git"); await run("git", ["init", "--bare", "--initial-branch=main", remote], container); await run("git", ["remote", "add", "origin", remote], seedRoot); await run("git", ["push", "-u", "origin", "main"], seedRoot);
    const root = join(container, "other"); await run("git", ["clone", remote, root], container); await configureGit(root); const other = new Catalog({ root });
    const remoteFile = join(container, "remote.txt"), localFile = join(container, "local.txt"); await writeFile(remoteFile, "remote supplement"); await writeFile(localFile, "local slides");
    await seed.addAttachment(p.id, remoteFile, "supplement"); await other.addAttachment(p.id, localFile, "slides");
    await seed.update(p.id, { title: "Remote Rename" }); await commit(seed); await sync(seed); await other.update(p.id, { notes: "Independent local edit" }); await commit(other); assert.equal((await sync(other)).state, "merged"); assert.equal((await other.get(p.id)).title, "Remote Rename"); assert.equal((await other.get(p.id)).notes, "Independent local edit"); assert.equal((await other.get(p.id)).attachments.length, 2); assert.equal((await other.validate(true)).valid, true);
    await sync(seed); await addAuthor(seed, { author_key: "remote-person", preferred_name: "Person", identifiers: { google_scholar: "same-profile" } }); await commit(seed); await sync(seed);
    await addAuthor(other, { author_key: "local-person", preferred_name: "Person", identifiers: { google_scholar: "same-profile" } }); await commit(other); const result = await sync(other); assert.equal(result.state, "needs-review"); assert.equal(result.conflicts[0]?.kind, "reference"); assert.equal((await other.read()).authors.length, 1); assert.equal((await other.validate(false)).valid, true);
  } finally { await rm(container, { recursive: true, force: true }); }
});

test("status reports metadata edits and untracked files awaiting commit with an aligned upstream", async () => {
  const container = await mkdtemp(join(tmpdir(), "mypub-status-metadata-"));
  try {
    const root = join(container, "library"), catalog = new Catalog({ root }); await catalog.initialize();
    const p = await catalog.add({ citation_key: "status-paper", title: "Status Paper", type: "other", authors: [] });
    await initializeGit(catalog); await configureGit(root); await commit(catalog);
    const remote = join(container, "remote.git"); await run("git", ["init", "--bare", "--initial-branch=main", remote], container);
    await run("git", ["remote", "add", "origin", remote], root); await run("git", ["push", "-u", "origin", "main"], root);
    assert.equal((await status(catalog)).pending_upload, false);
    await catalog.update(p.id, { notes: "Saved metadata edit" });
    await writeFile(join(root, "notes with spaces\n中文.txt"), "Notes");
    const result = await status(catalog);
    assert.equal(result.ahead, 0); assert.equal(result.behind, 0); assert.equal(result.dirty, true); assert.equal(result.pending_upload, false);
    assert.ok(result.changes?.some(c => c.label === "Status Paper" && c.status === "modified"));
    assert.ok(result.changes?.some(c => c.path === "notes with spaces\n中文.txt" && c.status === "added"));
    await run("git", ["add", "."], root); await run("git", ["commit", "-m", "metadata"], root);
    await run("git", ["mv", "notes with spaces\n中文.txt", "renamed notes.txt"], root);
    const renamed = (await status(catalog)).changes?.find(c => c.path === "renamed notes.txt");
    assert.equal(renamed?.status, "renamed"); assert.equal(renamed?.previous_path, "notes with spaces\n中文.txt");
  } finally { await rm(container, { recursive: true, force: true }); }
});

test("commit is offline, includes unstaged managed edits, excludes unrelated files, and has no empty commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-commit-"));
  try {
    const c = new Catalog({ root }); await c.initialize(); await initializeGit(c); await configureGit(root);
    await run("git", ["remote", "add", "origin", join(root, "unreachable.git")], root);
    const p = await c.add({ citation_key: "commit", title: "Commit Paper", type: "other", authors: [] });
    await commit(c);
    await c.update(p.id, { notes: "First edit" }); await run("git", ["add", "catalog"], root);
    await c.update(p.id, { notes: "Latest edit" });
    await writeFile(join(root, "unrelated.txt"), "Keep separate"); await run("git", ["add", "unrelated.txt"], root);
    const before = (await run("git", ["rev-parse", "HEAD"], root)).stdout;
    await assert.rejects(commit(c), errorCode("GIT_INDEX_DIRTY"));
    assert.equal((await run("git", ["rev-parse", "HEAD"], root)).stdout, before);
    await run("git", ["reset", "--", "unrelated.txt"], root);
    const result = await commit(c, "Checkpoint"); assert.equal(result.state, "committed");
    const path = (await run("git", ["ls-files", "catalog/publications"], root)).stdout.trim();
    assert.equal(JSON.parse((await run("git", ["show", `HEAD:${path}`], root)).stdout).notes, "Latest edit");
    assert.equal((await run("git", ["ls-tree", "HEAD", "unrelated.txt"], root)).stdout, "");
    assert.equal((await commit(c)).state, "no-changes");
    assert.equal((await run("git", ["rev-parse", "HEAD"], root)).stdout.trim(), result.commit);
    await assert.rejects(sync(c), errorCode("GIT_WORKTREE_DIRTY"));
    await rm(join(root, "unrelated.txt"));
    await assert.rejects(sync(c), errorCode("UPSTREAM_NOT_CONFIGURED"));
    await run("git", ["checkout", "--detach"], root);
    await assert.rejects(commit(c), errorCode("GIT_DETACHED"));
    await assert.rejects(sync(c), errorCode("GIT_DETACHED"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function remoteFixture(container: string): Promise<{ seed: Catalog; other: Catalog; remote: string }> {
  const seed = new Catalog({ root: join(container, "seed") }); await seed.initialize(); await initializeGit(seed); await configureGit(seed.root); await commit(seed);
  const remote = join(container, "remote.git"); await run("git", ["init", "--bare", "--initial-branch=main", remote], container);
  await run("git", ["remote", "add", "origin", remote], seed.root); await run("git", ["push", "-u", "origin", "main"], seed.root);
  const other = new Catalog({ root: join(container, "other") }); await run("git", ["clone", remote, other.root], container); await configureGit(other.root);
  return { seed, other, remote };
}

test("sync fast-forwards without merge commits or attachment downloads and rejects invalid remote catalogs", async () => {
  const container = await mkdtemp(join(tmpdir(), "mypub-sync-ff-"));
  try {
    const { seed, other } = await remoteFixture(container);
    const p = await seed.add({ citation_key: "ff", title: "Remote Café 日本語", type: "other", authors: [] });
    const file = join(container, "paper.pdf"); await writeFile(file, "%PDF remote attachment");
    const attachment = await seed.addAttachment(p.id, file, "paper");
    await commit(seed); await sync(seed);
    const remoteHead = (await run("git", ["rev-parse", "HEAD"], seed.root)).stdout.trim();
    assert.equal((await sync(other)).state, "pulled");
    assert.equal((await run("git", ["rev-parse", "HEAD"], other.root)).stdout.trim(), remoteHead);
    const { readFile } = await import("node:fs/promises");
    assert.match(await readFile(join(other.root, attachment.path), "utf8"), /^version https:\/\/git-lfs/);
    // A metadata-only commit and push must work without materializing the remote attachment.
    await other.update(p.id, { notes: "Metadata only" }); await commit(other); await sync(other); await sync(seed);
    const before = (await run("git", ["rev-parse", "HEAD"], other.root)).stdout;
    const path = (await run("git", ["ls-files", "-z", "catalog/publications"], seed.root)).stdout.split("\0")[0]!;
    const invalid = JSON.parse(await readFile(join(seed.root, path), "utf8")); invalid.gscholar_entry_id = "00000000-0000-4000-8000-000000000001";
    await atomicWriteJson(join(seed.root, path), invalid); await run("git", ["add", "catalog"], seed.root); await run("git", ["commit", "-m", "Invalid external edit"], seed.root); await run("git", ["push"], seed.root);
    await assert.rejects(sync(other), errorCode("VALIDATION_FAILED"));
    assert.equal((await run("git", ["rev-parse", "HEAD"], other.root)).stdout, before);
    assert.equal((await other.validate(false)).valid, true);
  } finally { await rm(container, { recursive: true, force: true }); }
});

test("commit rejects attachment manifest mismatches without creating a checkpoint", async () => {
  const container = await mkdtemp(join(tmpdir(), "mypub-commit-lfs-"));
  try {
    const c = new Catalog({ root: join(container, "library") }); await c.initialize(); await initializeGit(c); await configureGit(c.root);
    const p = await c.add({ citation_key: "file", title: "File Paper", type: "other", authors: [] }); await commit(c);
    const before = (await run("git", ["rev-parse", "HEAD"], c.root)).stdout;
    const file = join(container, "paper.pdf"); await writeFile(file, "%PDF original"); const a = await c.addAttachment(p.id, file, "paper");
    await writeFile(join(c.root, a.path), "Changed outside MyPub");
    await assert.rejects(commit(c), errorCode("ATTACHMENT_MISMATCH"));
    assert.equal((await run("git", ["rev-parse", "HEAD"], c.root)).stdout, before);
  } finally { await rm(container, { recursive: true, force: true }); }
});

test("failed upload retains local commits and retries without creating another commit", async () => {
  const container = await mkdtemp(join(tmpdir(), "mypub-sync-upload-"));
  try {
    const { seed, remote } = await remoteFixture(container);
    await seed.add({ citation_key: "pending", title: "Pending Upload", type: "other", authors: [] });
    const checkpoint = await commit(seed);
    await writeFile(join(remote, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await assert.rejects(sync(seed), errorCode("SYNC_UPLOAD_FAILED"));
    assert.equal((await run("git", ["rev-parse", "HEAD"], seed.root)).stdout.trim(), checkpoint.commit);
    assert.equal((await status(seed)).pending_upload, true); assert.equal((await status(seed)).last_successful_sync, undefined);
    await rm(join(remote, "hooks/pre-receive"));
    assert.equal((await sync(seed)).state, "pushed");
    assert.equal((await sync(seed)).state, "up-to-date");
    assert.equal((await run("git", ["rev-parse", "HEAD"], seed.root)).stdout.trim(), checkpoint.commit);
  } finally { await rm(container, { recursive: true, force: true }); }
});

test("commit reads Unicode catalog paths with Git path quoting enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-commit-unicode-"));
  try {
    const c = new Catalog({ root }); await c.initialize(); await initializeGit(c); await configureGit(root);
    await run("git", ["config", "core.quotePath", "true"], root);
    const p = await c.add({ citation_key: "unicode", title: "Café 日本語", type: "other", authors: [] });
    await commit(c);
    const quoted = (await run("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", "catalog/publications"], root)).stdout;
    assert.ok(quoted.startsWith('"'), "fixture must exercise Git-quoted paths");
    await c.update(p.id, { notes: "A local edit" });
    assert.equal((await commit(c)).state, "committed");
    assert.equal((await commit(c)).state, "no-changes");
    assert.equal((await c.get(p.id)).notes, "A local edit");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("no-op commits skip validation and history reads; changed commits batch history in one process", async t => {
  const container = await mkdtemp(join(tmpdir(), "mypub-commit-fast-"));
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  try {
    const c = new Catalog({ root: join(container, "library") }); await c.initialize(); await initializeGit(c); await configureGit(c.root);
    const p = await c.add({ citation_key: "fast", title: "Café 日本語", type: "other", authors: [] });
    await c.add({ citation_key: "second", title: "Another record", type: "other", authors: [] });
    await commit(c);
    const validation = t.mock.method(c, "assertValid");
    const trace = join(container, "noop.jsonl"); process.env.GIT_TRACE2_EVENT = trace;
    assert.equal((await commit(c)).state, "no-changes");
    assert.equal(validation.mock.callCount(), 0);
    const { readFile } = await import("node:fs/promises");
    const commands = async (file: string): Promise<string[][]> => (await readFile(file, "utf8")).trim().split("\n").map(row => JSON.parse(row)).filter(row => row.event === "start").map(row => row.argv);
    assert.ok((await commands(trace)).every(argv => !argv.includes("ls-tree") && !argv.includes("cat-file") && !argv.includes("show")));
    await c.update(p.id, { notes: "A real change\n含 Unicode" });
    const before = validation.mock.callCount();
    const changedTrace = join(container, "changed.jsonl"); process.env.GIT_TRACE2_EVENT = changedTrace;
    assert.equal((await commit(c)).state, "committed");
    assert.equal(validation.mock.callCount(), before + 1);
    const changed = await commands(changedTrace);
    assert.equal(changed.filter(argv => argv.includes("cat-file") && argv.includes("--batch")).length, 1);
    assert.ok(changed.every(argv => !argv.includes("show")), "no per-record Git processes");
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = previousTrace;
    await rm(container, { recursive: true, force: true });
  }
});

test("unchanged sync fetches upstream but skips catalog and attachment validation", async t => {
  const container = await mkdtemp(join(tmpdir(), "mypub-sync-fast-"));
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  try {
    const { seed } = await remoteFixture(container);
    const validation = t.mock.method(seed, "assertValid");
    const trace = join(container, "trace.jsonl"); process.env.GIT_TRACE2_EVENT = trace;
    const phases: string[] = [];
    assert.equal((await sync(seed, undefined, event => phases.push(event.phase))).state, "up-to-date");
    assert.equal(validation.mock.callCount(), 0);
    assert.deepEqual(phases, ["preflight", "fetch"]);
    const { fileURLToPath } = await import("node:url");
    const cli = fileURLToPath(new URL("../cli/main.js", import.meta.url));
    const readable = await run(process.execPath, [cli, "--root", seed.root, "sync"], seed.root);
    assert.match(readable.stderr, /Fetching upstream/);
    assert.match(readable.stdout, /Already synchronized/);
    const json = await run(process.execPath, [cli, "--root", seed.root, "--json", "sync"], seed.root);
    assert.equal(JSON.parse(json.stdout).state, "up-to-date");
    assert.doesNotMatch(json.stderr, /Checking local|Fetching upstream/);

    const { readFile } = await import("node:fs/promises");
    const commands: string[][] = (await readFile(trace, "utf8")).trim().split("\n").map(row => JSON.parse(row)).filter(row => row.event === "start").map(row => row.argv);
    assert.ok(commands.some(argv => argv.includes("fetch")));
    assert.ok(commands.every(argv => !argv.includes("cat-file") && !argv.includes("show") && !argv.includes("push")));
    assert.ok((await status(seed)).last_successful_sync);
    await seed.add({ citation_key: "outgoing", title: "Outgoing", type: "other", authors: [] }); await commit(seed);
    const before = validation.mock.callCount(); phases.length = 0;
    assert.equal((await sync(seed, undefined, event => phases.push(event.phase))).state, "pushed");
    assert.ok(validation.mock.callCount() > before);
    assert.deepEqual(phases, ["preflight", "fetch", "validate", "upload-attachments", "push"]);
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = previousTrace;
    await rm(container, { recursive: true, force: true });
  }
});


test("sync accepts a validated fast-forward that updates historical publication fields", async () => {
  const container = await mkdtemp(join(tmpdir(), "mypub-sync-schema-"));
  try {
    const { seed, other } = await remoteFixture(container);
    const publication = await seed.add({ citation_key: "links", title: "Links", type: "other", authors: [], extra_urls: ["https://example.org/code"] });
    const path = (await run("git", ["ls-files", "--others", "--exclude-standard", "catalog/publications"], seed.root)).stdout.trim();
    const { extra_urls, ...fields } = publication;
    await atomicWriteJson(join(seed.root, path), { ...fields, urls: extra_urls });
    await run("git", ["add", "catalog"], seed.root); await run("git", ["commit", "-m", "Historical URLs"], seed.root); await run("git", ["push"], seed.root);
    await run("git", ["pull", "--ff-only"], other.root);
    await assert.rejects(other.read(), errorCode("SCHEMA_INVALID"));
    const oldHead = (await run("git", ["rev-parse", "HEAD"], other.root)).stdout;
    // An invalid incoming tree must still be rejected before changing HEAD.
    await atomicWriteJson(join(seed.root, path), { ...publication, extra_urls: ["relative-url"] });
    await run("git", ["add", "catalog"], seed.root); await run("git", ["commit", "-m", "Invalid incoming URLs"], seed.root); await run("git", ["push"], seed.root);
    await assert.rejects(sync(other));
    assert.equal((await run("git", ["rev-parse", "HEAD"], other.root)).stdout, oldHead);
    await atomicWriteJson(join(seed.root, path), publication);
    await run("git", ["add", "catalog"], seed.root); await run("git", ["commit", "-m", "Rename urls to extra_urls"], seed.root); await run("git", ["push"], seed.root);
    assert.equal((await sync(other)).state, "pulled");
    assert.deepEqual((await other.get(publication.id)).extra_urls, extra_urls);
    assert.equal((await other.validate(false)).valid, true);
    assert.equal((await run("git", ["rev-parse", "HEAD"], other.root)).stdout, (await run("git", ["rev-parse", "HEAD"], seed.root)).stdout);
  } finally { await rm(container, { recursive: true, force: true }); }
});
