import { mkdir, readFile, readdir, rename, rm, writeFile, lstat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import type { CatalogState } from "./types.js";
import { assertLibrary, assertRecord, validRepositoryPath, validUuid } from "./schemas.js";
import { atomicWriteJson, fileExists, fingerprint, now, readJson, safePath, sha256, uuid, durableWrite } from "./utils.js";
import { catalogFiles, jsonFiles } from "./paths.js";
import { MyPubError } from "./errors.js";

export interface LoadedState { state: CatalogState; files: Map<string, unknown>; }
export async function loadState(root: string): Promise<LoadedState> {
  const library = await readJson<unknown>(join(root, "catalog/library.json"));
  if (typeof library === "object" && library !== null && "schema_version" in library && library.schema_version !== 2) throw new MyPubError("Only catalog schema version 2 is supported; this operation will not modify an older/newer catalog", "UNSUPPORTED_SCHEMA");
  assertLibrary(library);
  const s: CatalogState = { library, owner: { schema_version: 2 }, publications: [], authors: [], venues: [], gscholar_entries: [], reviews: [] };
  const files = new Map<string, unknown>();
  for (const file of await jsonFiles(join(root, "catalog"))) {
    const path = relative(root, file).split("\\").join("/"); const value = await readJson<unknown>(file); files.set(path, value);
    if (path === "catalog/library.json") continue;
    if (path === "catalog/config/author.json") { assertRecord("owner", value); s.owner = value as CatalogState["owner"]; }
    else if (path === "catalog/gscholar/profile.json") { assertRecord("gscholar_profile", value); s.gscholar_profile = value as NonNullable<CatalogState["gscholar_profile"]>; }
    else {
      const group = ([ ["publications", "publication"], ["authors", "author"], ["venues", "venue"], ["gscholar/entries", "gscholar_entry"], ["reviews", "review"] ] as const).find(([prefix]) => path.startsWith(`catalog/${prefix}/`));
      if (!group) throw new MyPubError(`Unsupported catalog JSON path: ${path}`, "SCHEMA_INVALID");
      assertRecord(group[1], value);
      const collection = group[0] === "gscholar/entries" ? "gscholar_entries" : group[0];
      (s[collection] as unknown[]).push(value);
    }
  }
  return { state: s, files };
}
type Operation = { type: "write"; path: string; staged_path: string; sha256: string } | { type: "delete"; path: string };
interface Manifest { schema_version: 2; id: string; state: "staging" | "ready" | "applying" | "committed" | "rolled_back"; created_at: string; updated_at: string; operations: Operation[]; }
const digest = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
async function confined(root: string, path: string): Promise<string> {
  if (!validRepositoryPath(path)) throw new MyPubError(`Unsafe transaction path ${path}`, "UNSAFE_PATH");
  const target = safePath(root, path); let current = root;
  for (const part of path.split("/")) { current = join(current, part); try { if ((await lstat(current)).isSymbolicLink()) throw new MyPubError("Transaction paths cannot traverse symlinks", "UNSAFE_PATH"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
  return target;
}
async function apply(root: string, directory: string, m: Manifest): Promise<void> {
  if (m.schema_version !== 2 || !validUuid(m.id) || !Array.isArray(m.operations)) throw new MyPubError("Invalid transaction manifest", "TRANSACTION_INVALID");
  // Validate all staged content before making the first visible change.
  for (const op of m.operations) {
    if (!op.path.startsWith("catalog/") && !op.path.startsWith("attachments/")) throw new MyPubError("Invalid transaction destination", "UNSAFE_PATH");
    await confined(root, op.path);
    if (op.type === "write") { const path = await confined(directory, op.staged_path); if (await sha256(path) !== op.sha256) throw new MyPubError("Staged transaction hash mismatch", "HASH_MISMATCH"); }
    else if (op.type !== "delete") throw new MyPubError("Unsupported transaction operation", "TRANSACTION_INVALID");
  }
  m.state = "applying"; m.updated_at = now(); await atomicWriteJson(join(directory, "manifest.json"), m);
  for (const op of m.operations) {
    const destination = await confined(root, op.path);
    if (op.type === "write") { const data = await readFile(await confined(directory, op.staged_path)); await mkdir(dirname(destination), { recursive: true }); const tmp = `${destination}.${m.id}.tmp`; await durableWrite(tmp, data); await rename(tmp, destination); }
    else await rm(destination, { force: true });
  }
  m.state = "committed"; m.updated_at = now(); await atomicWriteJson(join(directory, "manifest.json"), m);
}
export async function recoverTransactions(root: string): Promise<void> {
  const dir = join(root, "local/transactions"); let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  for (const e of entries) {
    if (!e.isDirectory() || !validUuid(e.name)) throw new MyPubError("Invalid transaction directory", "TRANSACTION_INVALID");
    const directory = join(dir, e.name); const path = join(directory, "manifest.json");
    if (!await fileExists(path)) { await rm(directory, { recursive: true }); continue; }
    const m = await readJson<Manifest>(path); if (m.id !== e.name) throw new MyPubError("Transaction identity mismatch", "TRANSACTION_INVALID");
    if (m.state === "ready" || m.state === "applying") await apply(root, directory, m);
    else if (m.state !== "staging" && m.state !== "committed" && m.state !== "rolled_back") throw new MyPubError("Unknown transaction state", "TRANSACTION_INVALID");
    await rm(directory, { recursive: true });
  }
}
export async function pendingTransaction(root: string): Promise<boolean> { try { return (await readdir(join(root, "local/transactions"))).length > 0; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
export async function writeState(root: string, before: Map<string, unknown>, after: CatalogState, binary = new Map<string, Buffer>()): Promise<void> {
  const files = catalogFiles(after); const operations: Operation[] = []; const id = uuid(); const directory = join(root, "local/transactions", id); const time = now();
  const m: Manifest = { schema_version: 2, id, state: "staging", created_at: time, updated_at: time, operations };
  await atomicWriteJson(join(directory, "manifest.json"), m);
  const stage = async (path: string, data: Buffer): Promise<void> => { const staged_path = `data/${operations.length}`; await mkdir(join(directory, "data"), { recursive: true }); await durableWrite(join(directory, staged_path), data); operations.push({ type: "write", path, staged_path, sha256: digest(data) }); };
  try {
    for (const [path, data] of binary) await stage(path, data);
    for (const [path, value] of files) if (!before.has(path) || fingerprint(before.get(path)) !== fingerprint(value)) await stage(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
    // Remove obsolete paths only after all new files are durably staged.
    for (const path of before.keys()) if (!files.has(path)) operations.push({ type: "delete", path });
    // Library version/identity file is applied last on initialization.
    operations.sort((a, b) => Number(a.path === "catalog/library.json") - Number(b.path === "catalog/library.json") || Number(b.type === "delete") - Number(a.type === "delete"));
    m.state = "ready"; await atomicWriteJson(join(directory, "manifest.json"), m); await apply(root, directory, m);
    await rm(directory, { recursive: true });
  } catch (e) { if (m.state === "staging") await rm(directory, { recursive: true }); throw e; }
}
