import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StatusResult, SyncConflict, SyncResult } from "./types.js";
import { Catalog } from "./catalog.js";
import { atomicWriteJson, fileExists, now, readJson, uuid, withLock } from "./utils.js";
import { run } from "../adapters/process.js";
import { MyPubError } from "./errors.js";
import { rebuildSearchIndex } from "../adapters/search.js";

const git = (catalog: Catalog, args: string[], allowFailure = false) => run("git", args, catalog.root, allowFailure);
export async function initializeGit(catalog: Catalog): Promise<void> {
  if (!(await fileExists(join(catalog.root, ".git")))) await git(catalog, ["init"]);
  await run("git", ["lfs", "install", "--local"], catalog.root);
  await git(catalog, ["add", ".gitattributes", ".gitignore", "catalog"]);
}

export async function status(catalog: Catalog): Promise<StatusResult> {
  const catalogReady = await fileExists(join(catalog.catalogDir, "library.json")); const isGit = (await git(catalog, ["rev-parse", "--is-inside-work-tree"], true)).code === 0; const lfs = (await run("git", ["lfs", "version"], catalog.root, true)).code === 0;
  if (!isGit) return { catalog: catalogReady ? "ready" : "missing", git: false, lfs, dirty: false, pending_upload: false, needs_review: await hasConflicts(catalog) };
  const porcelain = (await git(catalog, ["status", "--porcelain"])).stdout; const branch = (await git(catalog, ["branch", "--show-current"])).stdout.trim(); const upstreamResult = await git(catalog, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], true); let ahead: number | undefined; let behind: number | undefined;
  if (upstreamResult.code === 0) { const counts = (await git(catalog, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])).stdout.trim().split(/\s+/).map(Number); behind = counts[0]; ahead = counts[1]; }
  let last_successful_sync: string | undefined; if (await fileExists(join(catalog.localDir, "sync.json"))) last_successful_sync = (await readJson<{ last_successful_sync?: string }>(join(catalog.localDir, "sync.json"))).last_successful_sync;
  const hasCommit = (await git(catalog, ["rev-parse", "--verify", "HEAD"], true)).code === 0;
  return { catalog: catalogReady ? "ready" : "missing", git: true, lfs, branch, ...(upstreamResult.code === 0 ? { upstream: upstreamResult.stdout.trim(), ...(ahead !== undefined ? { ahead } : {}), ...(behind !== undefined ? { behind } : {}) } : {}), dirty: porcelain.length > 0, pending_upload: Boolean(ahead && ahead > 0) || porcelain.includes("attachments/") || (upstreamResult.code !== 0 && hasCommit), needs_review: await hasConflicts(catalog), ...(last_successful_sync ? { last_successful_sync } : {}) };
}

async function hasConflicts(catalog: Catalog): Promise<boolean> { try { return (await readdir(join(catalog.localDir, "conflicts"))).some((file) => file.endsWith(".json")); } catch { return false; } }
export async function listConflicts(catalog: Catalog): Promise<SyncConflict[]> { try { const files = (await readdir(join(catalog.localDir, "conflicts"))).filter((file) => file.endsWith(".json")); return Promise.all(files.map((file) => readJson<SyncConflict>(join(catalog.localDir, "conflicts", file)))); } catch { return []; } }

export async function sync(catalog: Catalog, message = "mypub: synchronize catalog"): Promise<SyncResult> {
  return withLock(join(catalog.localDir, "write.lock"), async () => {
    const validation = await catalog.validate(false); if (!validation.valid) throw new MyPubError("Catalog validation failed before synchronization", "VALIDATION_FAILED", validation);
    await initializeGit(catalog); const paths = ["catalog", ".gitattributes", ".gitignore"]; if (await fileExists(catalog.attachmentsDir)) paths.push("attachments"); await git(catalog, ["add", ...paths]);
    if ((await git(catalog, ["diff", "--cached", "--quiet"], true)).code !== 0) await git(catalog, ["commit", "-m", message]);
    const upstream = await git(catalog, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], true);
    if (upstream.code !== 0) return { state: "up-to-date", commit: (await git(catalog, ["rev-parse", "HEAD"])).stdout.trim(), conflicts: [] };
    await git(catalog, ["fetch", "--prune"]); const merge = await git(catalog, ["merge", "--no-edit", upstream.stdout.trim()], true);
    if (merge.code !== 0) {
      const paths = (await git(catalog, ["diff", "--name-only", "--diff-filter=U"], true)).stdout.trim().split(/\r?\n/).filter(Boolean); const conflicts: SyncConflict[] = [];
      await mkdir(join(catalog.localDir, "conflicts"), { recursive: true });
      for (const path of paths) { const show = async (stage: number): Promise<string | undefined> => { const result = await git(catalog, ["show", `:${stage}:${path}`], true); return result.code === 0 ? result.stdout : undefined; }; const base = await show(1); const ours = await show(2); const theirs = await show(3); const conflict: SyncConflict = { id: uuid(), path, ...(base !== undefined ? { base } : {}), ...(ours !== undefined ? { ours } : {}), ...(theirs !== undefined ? { theirs } : {}), created_at: now() }; await atomicWriteJson(join(catalog.localDir, "conflicts", `${conflict.id}.json`), conflict); conflicts.push(conflict); }
      await git(catalog, ["merge", "--abort"], true); return { state: "needs-review", conflicts };
    }
    const postValidation = await catalog.validate(false); if (!postValidation.valid) throw new MyPubError("Merged catalog is invalid; inspect Git history before pushing", "VALIDATION_FAILED", postValidation);
    const beforePush = await status(catalog); if ((beforePush.ahead ?? 0) > 0) await git(catalog, ["push"]);
    await rebuildSearchIndex(catalog); const timestamp = now(); await atomicWriteJson(join(catalog.localDir, "sync.json"), { last_successful_sync: timestamp });
    return { state: merge.stdout.includes("Already up to date") ? ((beforePush.ahead ?? 0) > 0 ? "pushed" : "up-to-date") : "merged", commit: (await git(catalog, ["rev-parse", "HEAD"])).stdout.trim(), conflicts: [] };
  });
}

export async function resolveConflict(catalog: Catalog, id: string, choice: "ours" | "theirs", customPath?: string): Promise<void> {
  const path = join(catalog.localDir, "conflicts", `${id}.json`); const conflict = await readJson<SyncConflict>(path); let content = choice === "ours" ? conflict.ours : conflict.theirs; if (customPath) content = await readFile(customPath, "utf8"); if (content === undefined) throw new MyPubError(`Chosen side does not contain ${conflict.path}`, "CONFLICT_SIDE_MISSING");
  const target = join(catalog.root, conflict.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, "utf8"); const { unlink } = await import("node:fs/promises"); await unlink(path);
}
