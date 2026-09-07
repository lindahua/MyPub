import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CatalogState, StatusResult, SyncConflict, SyncResult } from "./types.js";
import { Catalog } from "./catalog.js";
import { atomicWriteJson, fileExists, now, readJson, uuid, withLock, fingerprint, safePath } from "./utils.js";
import { run } from "../adapters/process.js";
import { MyPubError } from "./errors.js";
import { catalogFiles } from "./paths.js";
import { loadState, recoverTransactions, refreshStoredDatabase } from "./storage.js";
import { assertUnchangedEvidence, validateState } from "./validation.js";
import { ensureLocalIgnored } from "../adapters/database.js";
import { validUuid, validRepositoryPath } from "./schemas.js";

const git = (catalog: Catalog, args: string[], allowFailure = false) => run("git", args, catalog.root, allowFailure);
export async function initializeGit(catalog: Catalog): Promise<void> {
  if (!(await fileExists(join(catalog.root, ".git")))) await git(catalog, ["init", "--initial-branch=main"]);
  await ensureLocalIgnored(catalog.root);
  await assertLocalUntracked(catalog);
  await run("git", ["lfs", "install", "--local"], catalog.root);
  await git(catalog, ["add", ".gitattributes", ".gitignore", "catalog"]);
}

async function assertLocalUntracked(catalog: Catalog, revision?: string): Promise<void> {
  const args = revision ? ["ls-tree", "-r", "--name-only", revision, "--", "local"] : ["ls-files", "--", "local"];
  if ((await git(catalog, args)).stdout.trim()) throw new MyPubError("Git tracks machine-local files under local/. Remove them from Git tracking before synchronizing; keep their local contents.", "LOCAL_TRACKED");
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


type Records = Map<string, unknown>;
function recordKey(path: string, value: unknown): string {
  if (["catalog/library.json", "catalog/config/author.json", "catalog/gscholar/profile.json"].includes(path)) return path;
  if (!value || typeof value !== "object" || !("id" in value) || !validUuid(value.id)) throw new MyPubError("Invalid record in Git tree", "VALIDATION_FAILED");
  const group = path.startsWith("catalog/gscholar/entries/") ? "gscholar_entry" : path.split("/")[1];
  return `${group}:${value.id}`;
}
async function revisionRecords(c: Catalog, revision: string): Promise<Records> {
  const paths = (await git(c, ["ls-tree", "-r", "--name-only", revision, "--", "catalog"])).stdout.trim().split("\n").filter(Boolean); const records: Records = new Map();
  for (const path of paths) {
    if (!path.endsWith(".json") || !validRepositoryPath(path)) throw new MyPubError("Unexpected path in catalog Git tree", "VALIDATION_FAILED");
    const value: unknown = JSON.parse((await git(c, ["show", `${revision}:${path}`])).stdout); const key = recordKey(path, value);
    if (records.has(key)) throw new MyPubError("Duplicate entity UUID in Git tree", "VALIDATION_FAILED"); records.set(key, value);
  }
  return records;
}
function stateFromRecords(records: Records): CatalogState {
  const s: CatalogState = { library: records.get("catalog/library.json") as CatalogState["library"], owner: records.get("catalog/config/author.json") as CatalogState["owner"], publications: [], authors: [], venues: [], reviews: [], gscholar_entries: [] };
  if (records.has("catalog/gscholar/profile.json")) s.gscholar_profile = records.get("catalog/gscholar/profile.json") as NonNullable<CatalogState["gscholar_profile"]>;
  for (const [key, value] of records) { const group = key.split(":")[0]; if (["publications", "authors", "venues", "reviews", "gscholar_entry"].includes(group!)) (s[group === "gscholar_entry" ? "gscholar_entries" : group as "publications"] as unknown[]).push(value); }
  return s;
}
const equal = (a: unknown, b: unknown): boolean => a === undefined || b === undefined ? a === b : fingerprint(a) === fingerprint(b);
function mergeValue(base: unknown, ours: unknown, theirs: unknown, field = ""): unknown {
  if (equal(ours, theirs) || equal(base, theirs)) return ours; if (equal(base, ours)) return theirs;
  if (field === "updated_at" && typeof ours === "string" && typeof theirs === "string") return Date.parse(ours) >= Date.parse(theirs) ? ours : theirs;
  if (["authors", "venue", "matching", "evidence", "name_parts"].includes(field)) throw new Error("Concurrent atomic field edits");
  if (field === "attachments" && Array.isArray(base) && Array.isArray(ours) && Array.isArray(theirs)) {
    const byId = (values: Array<{ id: string }>) => new Map(values.map(value => [value.id, value])); const b = byId(base), o = byId(ours), t = byId(theirs); const result: unknown[] = [];
    for (const id of new Set([...b.keys(), ...o.keys(), ...t.keys()])) { const value = mergeValue(b.get(id), o.get(id), t.get(id)); if (value !== undefined) result.push(value); } return result;
  }
  if (["tags", "urls", "aliases"].includes(field) && Array.isArray(base) && Array.isArray(ours) && Array.isArray(theirs)) return [...new Set([...ours, ...theirs])].filter(x => !base.includes(x) || ours.includes(x) && theirs.includes(x));
  if (base && ours && theirs && typeof base === "object" && typeof ours === "object" && typeof theirs === "object" && !Array.isArray(base) && !Array.isArray(ours) && !Array.isArray(theirs)) {
    const b = base as Record<string, unknown>, o = ours as Record<string, unknown>, t = theirs as Record<string, unknown>; const result: Record<string, unknown> = {};
    if (Object.hasOwn(b, "authors_completeness")) {
      const pair = (record: Record<string, unknown>) => ({ authors: record.authors, authors_completeness: record.authors_completeness });
      Object.assign(result, mergeValue(pair(b), pair(o), pair(t), "authors"));
    }
    for (const key of new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])) { if (Object.hasOwn(result, key)) continue; const value = mergeValue(b[key], o[key], t[key], key); if (value !== undefined) result[key] = value; } return result;
  }
  throw new Error("Concurrent record edits");
}
export async function sync(c: Catalog, message = "mypub: synchronize catalog"): Promise<SyncResult> {
  return withLock(join(c.localDir, "write.lock"), async () => {
    await recoverTransactions(c.root); const loaded = await loadState(c.root); c.assertValid(loaded.state);
    await refreshStoredDatabase(c.root);
    await initializeGit(c);
    const staged = (await git(c, ["diff", "--cached", "--name-only"])).stdout.trim().split("\n").filter(Boolean);
    if (staged.some(p => !p.startsWith("catalog/") && !p.startsWith("attachments/") && ![".gitattributes", ".gitignore"].includes(p))) throw new MyPubError("Unrelated staged files must be committed or unstaged before sync", "GIT_INDEX_DIRTY");
    await git(c, ["add", "-A", "--", "catalog", ".gitattributes", ".gitignore", ...(await fileExists(c.attachmentsDir) ? ["attachments"] : [])]);
    if ((await git(c, ["diff", "--cached", "--quiet"], true)).code !== 0) await git(c, ["commit", "-m", message]);
    const ours = (await git(c, ["rev-parse", "HEAD"])).stdout.trim(); const upstream = await git(c, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], true);
    if (upstream.code !== 0) return { state: "up-to-date", commit: ours, conflicts: [] };
    await git(c, ["fetch", "--prune"]); const theirs = (await git(c, ["rev-parse", upstream.stdout.trim()])).stdout.trim();
    await assertLocalUntracked(c, theirs);
    let merged = false;
    if (ours !== theirs && (await git(c, ["merge-base", "--is-ancestor", theirs, ours], true)).code !== 0) {
      const base = (await git(c, ["merge-base", ours, theirs])).stdout.trim();
      const b = await revisionRecords(c, base), o = await revisionRecords(c, ours), t = await revisionRecords(c, theirs); const result: Records = new Map(); const conflicts: SyncConflict[] = [];
      const saved = await listConflicts(c);
      for (const key of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
        try { const value = mergeValue(b.get(key), o.get(key), t.get(key)); if (value !== undefined) result.set(key, value); }
        catch {
          const decision = saved.find(x => x.details?.key === key && x.details?.ours_commit === ours && x.details?.theirs_commit === theirs && Object.hasOwn(x.details, "resolution"));
          if (decision) { if (decision.details!.resolution !== null) result.set(key, decision.details!.resolution); continue; }
          conflicts.push({ schema_version: 2, id: uuid(), kind: "record", ...(key.includes(":") ? { record_id: key.split(":")[1]!, record_type: ({ publications: "publication", authors: "author", venues: "venue", gscholar_entry: "gscholar_entry", reviews: "review" } as const)[key.split(":")[0] as "publications"] } : { path: key, record_type: key === "catalog/library.json" ? "library" : key === "catalog/config/author.json" ? "owner" : "gscholar_profile" }), base: b.get(key) ?? null, ours: o.get(key) ?? null, theirs: t.get(key) ?? null, details: { key, base_commit: base, ours_commit: ours, theirs_commit: theirs }, created_at: now() });
        }
      }
      const persist = async (): Promise<SyncResult> => { await rm(join(c.localDir, "conflicts"), { recursive: true, force: true }); for (const conflict of [...conflicts, ...saved.filter(x => x.details?.ours_commit === ours && x.details?.theirs_commit === theirs && Object.hasOwn(x.details, "resolution"))]) await atomicWriteJson(join(c.localDir, "conflicts", `${conflict.id}.json`), conflict); return { state: "needs-review", conflicts }; };
      if (conflicts.length) return persist();
      const candidate = stateFromRecords(result); const validation = validateState(candidate);
      try { assertUnchangedEvidence(stateFromRecords(b), candidate); } catch (error) { validation.valid = false; validation.issues.push({ severity: "error", code: "EVIDENCE_CHANGED", message: String(error) }); }
      if (!validation.valid) { conflicts.push({ schema_version: 2, id: uuid(), kind: "reference", base: stateFromRecords(b), ours: stateFromRecords(o), theirs: stateFromRecords(t), details: { validation, ours_commit: ours, theirs_commit: theirs }, created_at: now() }); return persist(); }
      const stage = join(c.localDir, `sync-stage-${uuid()}`);
      await git(c, ["worktree", "add", "--detach", stage, ours]);
      try {
        const merge = await run("git", ["merge", "--no-commit", "--no-ff", theirs], stage, true);
        const unresolved = (await run("git", ["diff", "--name-only", "--diff-filter=U"], stage)).stdout.trim().split("\n").filter(Boolean);
        if (unresolved.some(p => !p.startsWith("catalog/"))) {
          for (const path of unresolved.filter(p => !p.startsWith("catalog/"))) conflicts.push({ schema_version: 2, id: uuid(), kind: path.startsWith("attachments/") ? "attachment" : "path", path, base: null, ours: null, theirs: null, details: { ours_commit: ours, theirs_commit: theirs, message: "Resolve this non-catalog conflict with Git before retrying sync" }, created_at: now() });
          return persist();
        }
        if (merge.code !== 0 && !unresolved.length) throw new MyPubError("Staged Git merge failed", "PROCESS_FAILED", merge);
        await rm(join(stage, "catalog"), { recursive: true, force: true });
        for (const [path, value] of catalogFiles(candidate)) await atomicWriteJson(safePath(stage, path), value);
        await run("git", ["add", "-A", "--", "catalog"], stage);
        await run("git", ["commit", "-m", message], stage);
        const commit = (await run("git", ["rev-parse", "HEAD"], stage)).stdout.trim();
        // Only a completely validated tree reaches the active checkout.
        await git(c, ["merge", "--ff-only", commit]); merged = true;
        await refreshStoredDatabase(c.root, true);
        await rm(join(c.localDir, "conflicts"), { recursive: true, force: true });
      } finally { await git(c, ["worktree", "remove", "--force", stage], true); }
    }
    const counts = (await git(c, ["rev-list", "--count", `${upstream.stdout.trim()}..HEAD`])).stdout.trim(); const push = Number(counts) > 0;
    if (push) await git(c, ["push"]);
    const branch = (await git(c, ["symbolic-ref", "HEAD"])).stdout.trim(); const remote = (await git(c, ["config", `branch.${branch.replace("refs/heads/", "")}.remote`])).stdout.trim();
    await atomicWriteJson(join(c.localDir, "sync.json"), { schema_version: 2, last_successful_sync: now(), remote, branch, commit: (await git(c, ["rev-parse", "HEAD"])).stdout.trim() });
    return { state: merged ? "merged" : push ? "pushed" : "up-to-date", commit: (await git(c, ["rev-parse", "HEAD"])).stdout.trim(), conflicts: [] };
  });
}
export async function resolveConflict(c: Catalog, id: string, choice: "ours" | "theirs", customPath?: string): Promise<void> {
  if (!validUuid(id)) throw new MyPubError("Invalid conflict UUID", "SCHEMA_INVALID");
  await withLock(join(c.localDir, "write.lock"), async () => {
    const path = join(c.localDir, "conflicts", `${id}.json`); const conflict = await readJson<SyncConflict>(path);
    if (!conflict.details?.key || conflict.kind !== "record") throw new MyPubError("Correct the catalog/Git conflict and retry sync", "CONFLICT_REQUIRES_EDIT");
    const current = (await git(c, ["rev-parse", "HEAD"])).stdout.trim(); if (current !== conflict.details.ours_commit) throw new MyPubError("Conflict changed; synchronize again", "STALE_REVISION");
    const resolution: unknown = customPath ? JSON.parse(await readFile(customPath, "utf8")) : conflict[choice];
    conflict.details.resolution = resolution; await atomicWriteJson(path, conflict);
  });
}
