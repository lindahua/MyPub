import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { mkdir } from "node:fs/promises";
import { MyPubError } from "./errors.js";

export const now = (): string => new Date().toISOString();
export const uuid = (): string => randomUUID();
export const normalizeDoi = (value: string): string => value.trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "").replace(/^doi:\s*/, "");
export const normalizeArxiv = (value: string): string => value.trim().toLowerCase().replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//, "").replace(/\.pdf$/, "").replace(/^arxiv:\s*/, "").replace(/v\d+$/, "");
export const normalizeText = (value: string): string => value.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const sha256 = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");

export async function readJson<T>(path: string): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { throw new MyPubError(`Cannot read JSON: ${path}`, "INVALID_JSON", { cause: String(error) }); }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export function safePath(root: string, relative: string): string {
  const base = resolve(root);
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new MyPubError(`Path escapes managed directory: ${relative}`, "UNSAFE_PATH");
  return target;
}

export async function withLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  let handle;
  try { handle = await open(lockPath, "wx"); }
  catch { throw new MyPubError("Another MyPub writer is active", "CATALOG_LOCKED"); }
  try {
    await handle.writeFile(`${process.pid} ${now()}\n`);
    return await action();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try { const handle = await open(path, "r"); await handle.close(); return true; } catch { return false; }
}
