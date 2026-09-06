import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Catalog } from "./catalog.js";
import { run } from "../adapters/process.js";
import { atomicWriteJson, fileExists, now } from "./utils.js";
import { MyPubError } from "./errors.js";

async function copyTree(source: string, target: string): Promise<void> { await mkdir(target, { recursive: true }); for (const entry of await readdir(source, { withFileTypes: true })) { const src = join(source, entry.name); const dst = join(target, entry.name); if (entry.isDirectory()) await copyTree(src, dst); else if (entry.isFile()) await copyFile(src, dst); } }
export async function backup(catalog: Catalog, destination: string): Promise<{ path: string; created_at: string }> {
  const validation = await catalog.validate(true); if (!validation.valid) throw new MyPubError("Cannot back up an invalid catalog", "VALIDATION_FAILED", validation);
  const target = resolve(destination); if (target === resolve(catalog.root) || target.startsWith(`${resolve(catalog.root)}/`)) throw new MyPubError("Backup destination must be outside the catalog repository", "UNSAFE_PATH"); if (await fileExists(join(target, "manifest.json"))) throw new MyPubError("Backup destination already contains a MyPub backup", "BACKUP_EXISTS"); await mkdir(target, { recursive: true });
  await run("git", ["lfs", "fetch", "--all"], catalog.root, true);
  const bundle = join(target, "repository.bundle"); const bundled = await run("git", ["bundle", "create", bundle, "--all"], catalog.root, true);
  await copyTree(catalog.catalogDir, join(target, "catalog")); await copyTree(catalog.attachmentsDir, join(target, "attachments"));
  let includesHistoricalLfsObjects = false; try { await copyTree(join(catalog.root, ".git", "lfs", "objects"), join(target, "lfs-objects")); includesHistoricalLfsObjects = true; } catch { /* A non-Git catalog has no historical LFS object store. */ }
  const created_at = now(); await atomicWriteJson(join(target, "manifest.json"), { schema_version: 1, created_at, library_id: (await catalog.library()).id, git_bundle: bundled.code === 0 ? "repository.bundle" : null, includes_current_attachments: true, includes_historical_lfs_objects: includesHistoricalLfsObjects }); return { path: target, created_at };
}

export async function restore(catalog: Catalog, source: string): Promise<void> {
  const origin = resolve(source); await stat(join(origin, "manifest.json"));
  if (await fileExists(join(catalog.catalogDir, "library.json"))) throw new MyPubError("Restore destination already contains a catalog", "RESTORE_NOT_EMPTY");
  await copyTree(join(origin, "catalog"), catalog.catalogDir); await copyTree(join(origin, "attachments"), catalog.attachmentsDir);
  try { await copyTree(join(origin, "lfs-objects"), join(catalog.root, ".git", "lfs", "objects")); } catch { /* Current attachments can still be restored without historical objects. */ }
  const validation = await catalog.validate(true); if (!validation.valid) throw new MyPubError("Restored data failed validation", "VALIDATION_FAILED", validation);
}
