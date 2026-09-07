import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { MyPubError } from "../core/errors.js";

/** Per-user application preferences, independent of catalog schema versions. */
export interface UserConfig { repo_path?: string; max_pagesize_main?: number; max_pagesize_dropdown?: number }
export const configPath = (home = homedir()): string => join(home, ".config", "mypub", "config.json");

export async function readUserConfig(home = homedir()): Promise<UserConfig> {
  const path = configPath(home);
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new MyPubError(`Cannot read ${path}: ${(error as Error).message}`, "CONFIG");
  }
  const invalid = (message: string): never => { throw new MyPubError(`Invalid ${path}: ${message}`, "CONFIG"); };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid("expected valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("expected an object");
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!["repo_path", "max_pagesize_main", "max_pagesize_dropdown"].includes(key)) invalid(`unknown option ${key}`);
  if ("repo_path" in object) {
    const path = object.repo_path;
    if (typeof path !== "string" || !path.trim() || path.includes("\0")) return invalid("repo_path must be a non-empty path string");
    if (!isAbsolute(path) && path !== "~" && !path.startsWith("~/")) return invalid("repo_path must be absolute or start with ~/");
  }
  for (const key of ["max_pagesize_main", "max_pagesize_dropdown"]) {
    if (key in object && (typeof object[key] !== "number" || !Number.isSafeInteger(object[key]) || (object[key] as number) < 1)) invalid(`${key} must be a positive safe integer`);
  }
  return object as UserConfig;
}

export function expandHome(path: string, home = homedir()): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

export async function resolveRepoRoot(explicit?: string, home = homedir(), cwd = process.cwd()): Promise<string> {
  // An explicit repository remains usable even when the preferences need repair.
  const path = explicit ?? (await readUserConfig(home)).repo_path ?? cwd;
  return resolve(cwd, expandHome(path, home));
}
