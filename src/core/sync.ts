import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CatalogState, CommitResult, ProgressHandler, StatusChange, StatusResult, SyncConflict, SyncResult } from "./types.js";
import { Catalog } from "./catalog.js";
import { atomicWriteJson, fileExists, now, readJson, uuid, withLock, fingerprint, safePath } from "./utils.js";
import { run } from "../adapters/process.js";
import { MyPubError } from "./errors.js";
import { catalogFiles } from "./paths.js";
import { loadState, recoverTransactions, refreshStoredDatabase } from "./storage.js";
import { assertUnchangedEvidence, validateState } from "./validation.js";
import { ensureLocalIgnored } from "../adapters/database.js";
import { assertLibrary, validUuid, validRepositoryPath } from "./schemas.js";

// Checkouts retain LFS pointers; synchronization must never implicitly download binaries.
const lfsSkip = ["-c", "filter.lfs.smudge=git-lfs smudge --skip", "-c", "filter.lfs.process=git-lfs filter-process --skip"];
const git = (catalog: Catalog, args: string[], allowFailure = false, input?: string) => run("git", [...lfsSkip, ...args], catalog.root, allowFailure, input);
export const managedPath = (path: string): boolean => path.startsWith("catalog/") || path.startsWith("attachments/") || [".gitattributes", ".gitignore"].includes(path);
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
  const porcelain = (await git(catalog, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
  const changes = await statusChanges(catalog, porcelain); const branch = (await git(catalog, ["branch", "--show-current"])).stdout.trim(); const upstreamResult = await git(catalog, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], true); let ahead: number | undefined; let behind: number | undefined;
  if (upstreamResult.code === 0) { const counts = (await git(catalog, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])).stdout.trim().split(/\s+/).map(Number); behind = counts[0]; ahead = counts[1]; }
  let last_successful_sync: string | undefined; if (await fileExists(join(catalog.localDir, "sync.json"))) last_successful_sync = (await readJson<{ last_successful_sync?: string }>(join(catalog.localDir, "sync.json"))).last_successful_sync;
  const hasCommit = (await git(catalog, ["rev-parse", "--verify", "HEAD"], true)).code === 0;
  return { catalog: catalogReady ? "ready" : "missing", git: true, lfs, branch, ...(upstreamResult.code === 0 ? { upstream: upstreamResult.stdout.trim(), ...(ahead !== undefined ? { ahead } : {}), ...(behind !== undefined ? { behind } : {}) } : {}), changes, dirty: changes.length > 0, pending_upload: Boolean(ahead && ahead > 0) || (upstreamResult.code !== 0 && hasCommit), needs_review: changes.some(change => change.status === "conflicted") || await hasConflicts(catalog), ...(last_successful_sync ? { last_successful_sync } : {}) };
}

// NUL-delimited porcelain preserves spaces, Unicode, newlines and rename paths.
async function statusChanges(catalog: Catalog, porcelain: string): Promise<StatusChange[]> {
  const fields = porcelain.split("\0"); const changes: StatusChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const row = fields[i]; if (!row) continue;
    const code = row.slice(0, 2), path = row.slice(3);
    const conflicted = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code);
    const status: StatusChange["status"] = conflicted ? "conflicted" : code.includes("R") ? "renamed" : code.includes("C") ? "copied" : code === "??" || code.includes("A") ? "added" : code.includes("D") ? "deleted" : "modified";
    const previous = code.includes("R") || code.includes("C") ? fields[++i] : undefined;
    const change: StatusChange = { path, status, ...(previous ? { previous_path: previous } : {}) };
    if (path.startsWith("catalog/") && path.endsWith(".json") && status !== "deleted" && !conflicted) {
      try {
        const record = await readJson<Record<string, unknown>>(safePath(catalog.root, path));
        const label = record.title ?? record.summary ?? record.preferred_name;
        if (typeof label === "string") change.label = label;
      } catch { /* A malformed or removed record still appears by path. */ }
    }
    changes.push(change);
  }
  return changes;
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
  const tree = (await git(c, ["ls-tree", "-r", "-z", revision, "--", "catalog"])).stdout;
  const entries = tree.split("\0").filter(Boolean).map(row => {
    const tab = row.indexOf("\t");
    const [, type, oid] = row.slice(0, tab).split(" ");
    const path = row.slice(tab + 1);
    if (tab < 0 || type !== "blob" || !oid || !path.endsWith(".json") || !validRepositoryPath(path)) throw new MyPubError(`Unexpected path in catalog Git tree: ${JSON.stringify(path)}`, "VALIDATION_FAILED");
    return { path, oid };
  });
  const records: Records = new Map();
  if (!entries.length) return records;
  // Read every blob in one Git process. Frame by UTF-8 bytes, not JS characters.
  const bytes = Buffer.from((await git(c, ["cat-file", "--batch"], false, entries.map(entry => entry.oid).join("\n") + "\n")).stdout, "utf8");
  let offset = 0;
  for (const { path, oid } of entries) {
    const end = bytes.indexOf(10, offset);
    const header = end < 0 ? [] : bytes.subarray(offset, end).toString("ascii").split(" ");
    const size = Number(header[2]);
    if (header[0] !== oid || header[1] !== "blob" || !Number.isSafeInteger(size) || size < 0 || end + 1 + size >= bytes.length || bytes[end + 1 + size] !== 10) throw new MyPubError("Invalid Git batch object response", "PROCESS_FAILED");
    const value: unknown = JSON.parse(bytes.subarray(end + 1, end + 1 + size).toString("utf8"));
    offset = end + size + 2;
    const key = recordKey(path, value);
    if (records.has(key)) throw new MyPubError("Duplicate entity UUID in Git tree", "VALIDATION_FAILED");
    records.set(key, value);
  }
  if (offset !== bytes.length) throw new MyPubError("Unexpected trailing Git batch data", "PROCESS_FAILED");
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
async function requireBranch(c: Catalog): Promise<string> {
  if ((await git(c, ["rev-parse", "--is-inside-work-tree"], true)).code !== 0) throw new MyPubError("Initialize Git for this library before committing or synchronizing", "GIT_NOT_INITIALIZED");
  const branch = (await git(c, ["symbolic-ref", "--quiet", "--short", "HEAD"], true)).stdout.trim();
  if (!branch) throw new MyPubError("Select a branch before committing or synchronizing (detached HEAD)", "GIT_DETACHED");
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    const path = (await git(c, ["rev-parse", "--git-path", name])).stdout.trim();
    if (await fileExists(path.startsWith("/") ? path : join(c.root, path))) throw new MyPubError("Finish or abort the active Git operation first", "GIT_OPERATION_PENDING");
  }
  await assertLocalUntracked(c);
  return branch;
}

async function validatePointers(c: Catalog, state: CatalogState, revision: string): Promise<void> {
  for (const p of state.publications) for (const a of p.attachments) {
    const result = await git(c, ["show", `${revision}:${a.path}`], true);
    const oid = /^oid sha256:([a-f0-9]{64})$/m.exec(result.stdout)?.[1];
    const size = /^size (\d+)$/m.exec(result.stdout)?.[1];
    if (result.code !== 0 || !result.stdout.startsWith("version https://git-lfs.github.com/spec/v1\n") || oid !== a.sha256 || size !== String(a.size_bytes)) throw new MyPubError(`Attachment LFS pointer does not match its catalog manifest: ${a.path}`, "ATTACHMENT_MISMATCH");
  }
}

export async function commit(c: Catalog, message?: string): Promise<CommitResult> {
  return withLock(join(c.localDir, "write.lock"), async () => {
    await recoverTransactions(c.root); await requireBranch(c);
    const staged = (await git(c, ["diff", "--cached", "--name-only", "-z"])).stdout.split("\0").filter(Boolean);
    if (staged.some(path => !managedPath(path))) throw new MyPubError("Unrelated staged files must be committed with Git or unstaged before mypub commit", "GIT_INDEX_DIRTY");
    const changes = await statusChanges(c, (await git(c, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout);
    if (changes.some(change => change.status === "conflicted")) throw new MyPubError("Resolve Git conflicts before committing", "GIT_INDEX_DIRTY");
    // A no-op needs Git preflight, not catalog or historical evidence validation.
    const paths = new Set(changes.flatMap(change => [change.path, ...(change.previous_path ? [change.previous_path] : [])]).filter(managedPath));
    if (!paths.size) return { state: "no-changes" };
    const { state } = await loadState(c.root); c.assertValid(state);
    const ours = await git(c, ["rev-parse", "--verify", "HEAD"], true);
    if (ours.code === 0) assertUnchangedEvidence(stateFromRecords(await revisionRecords(c, "HEAD")), state);
    // Include all managed edits, including deletions and unstaged portions of staged records.
    const roots: string[] = [];
    for (const path of ["catalog", "attachments", ".gitattributes", ".gitignore"]) if (await fileExists(join(c.root, path)) || (await git(c, ["ls-files", "--", path])).stdout) roots.push(path);
    await git(c, ["add", "-A", "--", ...roots]);
    await validatePointers(c, state, "");
    if ((await git(c, ["diff", "--cached", "--quiet"], true)).code === 0) return { state: "no-changes" };
    const managed = changes.filter(change => managedPath(change.path));
    const generated = managed.length === 1 && managed[0]?.label ? `mypub: ${managed[0].status} ${managed[0].label}` : `mypub: save ${managed.length} managed file changes`;
    const subject = message?.trim() || generated;
    await git(c, ["commit", "-m", subject]);
    return { state: "committed", commit: (await git(c, ["rev-parse", "HEAD"])).stdout.trim(), message: subject };
  });
}

export async function sync(c: Catalog, message = "mypub: merge synchronized catalog", onProgress?: ProgressHandler): Promise<SyncResult> {
  return withLock(join(c.localDir, "write.lock"), async () => {
    onProgress?.({ phase: "preflight", message: "Checking local state…" });
    await recoverTransactions(c.root); const branchName = await requireBranch(c);
    if ((await git(c, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout) throw new MyPubError("Local changes await commit. Run mypub commit; handle unrelated files with Git or ignore them before mypub sync. Nothing was uploaded.", "GIT_WORKTREE_DIRTY");
    assertLibrary(await readJson(join(c.catalogDir, "library.json")));
    const head = await git(c, ["rev-parse", "--verify", "HEAD"], true);
    if (head.code !== 0) throw new MyPubError("No local checkpoint exists; run mypub commit first", "NO_COMMITS");
    const ours = head.stdout.trim();
    const remote = (await git(c, ["config", `branch.${branchName}.remote`], true)).stdout.trim();
    const remoteRef = (await git(c, ["config", `branch.${branchName}.merge`], true)).stdout.trim();
    if (!remote || remote === "." || !remoteRef.startsWith("refs/heads/")) throw new MyPubError("Synchronization is not configured; configure a remote upstream branch first", "UPSTREAM_NOT_CONFIGURED");
    onProgress?.({ phase: "fetch", message: "Fetching upstream…" });
    await git(c, ["fetch", "--no-tags", remote, remoteRef]);
    const theirs = (await git(c, ["rev-parse", "FETCH_HEAD"])).stdout.trim();
    await assertLocalUntracked(c, theirs);
    if (ours === theirs) {
      await recordSuccessfulSync(c, branchName, remote, ours);
      return { state: "up-to-date", commit: ours, conflicts: [] };
    }
    onProgress?.({ phase: "validate", message: "Validating catalog and attachment references…" });
    const loaded = await loadState(c.root); c.assertValid(loaded.state);
    await validatePointers(c, loaded.state, "HEAD");
    let merged = false, pulled = false;
    if (ours !== theirs && (await git(c, ["merge-base", "--is-ancestor", ours, theirs], true)).code === 0) {
      const candidate = stateFromRecords(await revisionRecords(c, theirs)); c.assertValid(candidate);
      assertUnchangedEvidence(loaded.state, candidate); await validatePointers(c, candidate, theirs);
      onProgress?.({ phase: "integrate", message: "Applying remote commits…" });
      await git(c, ["merge", "--ff-only", theirs]); pulled = true;
      await refreshStoredDatabase(c.root, true);
    } else if (ours !== theirs && (await git(c, ["merge-base", "--is-ancestor", theirs, ours], true)).code !== 0) {
      onProgress?.({ phase: "merge", message: "Reconciling local and remote changes…" });
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
        const merge = await run("git", [...lfsSkip, "merge", "--no-commit", "--no-ff", theirs], stage, true);
        const unresolved = (await run("git", ["diff", "--name-only", "-z", "--diff-filter=U"], stage)).stdout.split("\0").filter(Boolean);
        if (unresolved.some(p => !p.startsWith("catalog/"))) {
          for (const path of unresolved.filter(p => !p.startsWith("catalog/"))) conflicts.push({ schema_version: 2, id: uuid(), kind: path.startsWith("attachments/") ? "attachment" : "path", path, base: null, ours: null, theirs: null, details: { ours_commit: ours, theirs_commit: theirs, message: "Resolve this non-catalog conflict with Git before retrying sync" }, created_at: now() });
          return persist();
        }
        if (merge.code !== 0 && !unresolved.length) throw new MyPubError("Staged Git merge failed", "PROCESS_FAILED", merge);
        await rm(join(stage, "catalog"), { recursive: true, force: true });
        for (const [path, value] of catalogFiles(candidate)) await atomicWriteJson(safePath(stage, path), value);
        await run("git", ["add", "-A", "--", "catalog"], stage);
        await validatePointers(new Catalog({ root: stage }), candidate, "");
        await run("git", ["commit", "-m", message], stage);
        const commit = (await run("git", ["rev-parse", "HEAD"], stage)).stdout.trim();
        // Only a completely validated tree reaches the active checkout.
        await git(c, ["merge", "--ff-only", commit]); merged = true;
        await refreshStoredDatabase(c.root, true);
        await rm(join(c.localDir, "conflicts"), { recursive: true, force: true });
      } finally { await git(c, ["worktree", "remove", "--force", stage], true); }
    }
    const counts = (await git(c, ["rev-list", "--count", `${theirs}..HEAD`])).stdout.trim(); const push = Number(counts) > 0;
    if (push) {
      try {
        // Clones need not have an LFS pre-push hook installed. Upload explicitly first.
        onProgress?.({ phase: "upload-attachments", message: "Uploading attachment objects…" });
        await git(c, ["lfs", "push", remote, "HEAD"]);
        onProgress?.({ phase: "push", message: "Pushing commits…" });
        await git(c, ["push", remote, `HEAD:${remoteRef}`]);
      }
      catch (error) { throw new MyPubError("Upload failed; local commits and any integrated remote changes are retained. Synchronization is incomplete; retry mypub sync. " + String(error), "SYNC_UPLOAD_FAILED"); }
    }
    const commit = (await git(c, ["rev-parse", "HEAD"])).stdout.trim();
    await recordSuccessfulSync(c, branchName, remote, commit);
    return { state: merged ? "merged" : pulled ? "pulled" : push ? "pushed" : "up-to-date", commit, conflicts: [] };
  });
}
async function recordSuccessfulSync(c: Catalog, branch: string, remote: string, commit: string): Promise<void> {
  await rm(join(c.localDir, "conflicts"), { recursive: true, force: true });
  await atomicWriteJson(join(c.localDir, "sync.json"), { schema_version: 2, last_successful_sync: now(), remote, branch: `refs/heads/${branch}`, commit });
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
