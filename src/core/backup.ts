import { cp, mkdir, readdir, readFile, rm, lstat, mkdtemp } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { Catalog } from "./catalog.js";
import { run } from "../adapters/process.js";
import { atomicWriteJson, fileExists, now, readJson, sha256, withLock } from "./utils.js";
import { MyPubError } from "./errors.js";
import { loadState, recoverTransactions } from "./storage.js";

async function copyTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new MyPubError("Backup trees must not contain symlinks", "UNSAFE_PATH");
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory()) await copyTree(from, to); else if (entry.isFile()) await cp(from, to);
  }
}
async function verifyBytes(c: Catalog): Promise<void> {
  const { state } = await loadState(c.root); c.assertValid(state);
  for (const p of state.publications) for (const a of p.attachments) {
    const path = join(c.root, a.path); let cursor = c.root;
    for (const part of a.path.split("/")) { cursor = join(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) throw new MyPubError("Attachment traverses symlink", "UNSAFE_PATH"); }
    const data = await readFile(path);
    if (data.length !== a.size_bytes || await sha256(path) !== a.sha256) throw new MyPubError(`Fetch or repair attachment before backup: ${a.path}`, "ATTACHMENT_MISMATCH");
  }
}
interface BackupManifest { schema_version: 2; created_at: string; library_id: string; catalog_schema_version: 2; git_bundle: string | null; includes_current_attachments: boolean; includes_historical_lfs_objects: boolean; }
export async function backup(c: Catalog, destination: string, filesOnly = false): Promise<{ path: string; created_at: string; git_history: boolean; historical_lfs_complete: boolean }> {
  const target = resolve(destination); if (target === c.root || target.startsWith(`${c.root}/`)) throw new MyPubError("Backup destination must be outside the catalog", "UNSAFE_PATH");
  if (await fileExists(target) && (await readdir(target)).length) throw new MyPubError("Backup destination must be empty", "BACKUP_EXISTS");
  return withLock(join(c.localDir, "write.lock"), async () => {
    await recoverTransactions(c.root); await verifyBytes(c); await mkdir(target, { recursive: true });
    const gitRepo = !filesOnly && (await run("git", ["rev-parse", "--verify", "HEAD"], c.root, true)).code === 0;
    if (!gitRepo && !filesOnly) throw new MyPubError("A Git commit is required for a history backup; use --files-only explicitly otherwise", "BACKUP_NO_HISTORY");
    let includesHistoricalLfsObjects = false;
    if (gitRepo) {
      await run("git", ["bundle", "create", join(target, "repository.bundle"), "--all"], c.root);
      // Failure to fetch historical objects is recorded, never advertised as complete.
      const fetched = await run("git", ["lfs", "fetch", "--all"], c.root, true);
      const objects = (await run("git", ["rev-parse", "--git-path", "lfs/objects"], c.root)).stdout.trim(); const objectPath = resolve(c.root, objects);
      if (await fileExists(objectPath)) { await copyTree(objectPath, join(target, "lfs-objects")); includesHistoricalLfsObjects = fetched.code === 0 && await verifyHistorical(c.root, objectPath); }
    }
    await copyTree(c.catalogDir, join(target, "catalog"));
    if (await fileExists(c.attachmentsDir)) await copyTree(c.attachmentsDir, join(target, "attachments")); else await mkdir(join(target, "attachments"));
    for (const path of [".gitattributes", ".gitignore"]) if (await fileExists(join(c.root, path))) await cp(join(c.root, path), join(target, path));
    const created_at = now(); const manifest: BackupManifest = { schema_version: 2, catalog_schema_version: 2, created_at, library_id: (await loadState(c.root)).state.library.id, git_bundle: gitRepo ? "repository.bundle" : null, includes_current_attachments: true, includes_historical_lfs_objects: includesHistoricalLfsObjects };
    await atomicWriteJson(join(target, "manifest.json"), manifest); return { path: target, created_at, git_history: gitRepo, historical_lfs_complete: includesHistoricalLfsObjects };
  });
}
export async function restore(c: Catalog, source: string): Promise<void> {
  const origin = resolve(source); const m = await readJson<BackupManifest>(join(origin, "manifest.json"));
  if (m.schema_version !== 2 || m.catalog_schema_version !== 2 || !m.includes_current_attachments || m.git_bundle !== null && m.git_bundle !== "repository.bundle") throw new MyPubError("Invalid backup manifest", "BACKUP_INVALID");
  if (await fileExists(c.root) && (await readdir(c.root)).length) throw new MyPubError("Restore destination must be empty", "RESTORE_NOT_EMPTY");
  await mkdir(dirname(c.root), { recursive: true }); const stage = await mkdtemp(join(dirname(c.root), ".mypub-restore-"));
  try {
    if (m.git_bundle) {
      await run("git", ["clone", "--no-checkout", join(origin, m.git_bundle), stage], dirname(c.root));
      await run("git", ["remote", "remove", "origin"], stage);
      await run("git", ["fetch", "--update-head-ok", join(origin, m.git_bundle), "+refs/*:refs/*"], stage);
      await run("git", ["read-tree", "HEAD"], stage);
    }
    await copyTree(join(origin, "catalog"), join(stage, "catalog")); await copyTree(join(origin, "attachments"), join(stage, "attachments"));
    for (const path of [".gitattributes", ".gitignore"]) if (await fileExists(join(origin, path))) await cp(join(origin, path), join(stage, path));
    if (m.git_bundle && await fileExists(join(origin, "lfs-objects"))) await copyTree(join(origin, "lfs-objects"), join(stage, ".git/lfs/objects"));
    if (m.includes_historical_lfs_objects && (!m.git_bundle || !await verifyHistorical(stage, join(stage, ".git/lfs/objects")))) throw new MyPubError("Historical LFS objects are missing or corrupt", "BACKUP_INVALID");
    const staged = new Catalog({ root: stage }); await verifyBytes(staged); if ((await staged.library()).id !== m.library_id) throw new MyPubError("Backup library UUID mismatch", "BACKUP_INVALID");
    const { rename } = await import("node:fs/promises"); if (await fileExists(c.root)) await rm(c.root, { recursive: true }); await rename(stage, c.root);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function verifyHistorical(root: string, objects: string): Promise<boolean> { const list = await run("git", ["lfs", "ls-files", "--all", "--long"], root, true); if (list.code !== 0) return false; for (const line of list.stdout.split("\n").filter(Boolean)) { const hash = line.split(" ")[0]!; if (!/^[a-f0-9]{64}$/.test(hash)) return false; const path = join(objects, hash.slice(0, 2), hash.slice(2, 4), hash); if (!await fileExists(path) || await sha256(path) !== hash) return false; } return true; }
