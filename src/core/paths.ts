import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CatalogState } from "./types.js";
import { MyPubError } from "./errors.js";

import { publicationYear } from "./dates.js";
export { publicationDate, publicationYear } from "./dates.js";
export function slug(value: string, fallback: string): string {
  const normalized = value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, "_").replace(/^[_\p{M}]+|_+$/gu, "");
  let result = ""; for (const char of normalized) { if (Buffer.byteLength(result + char, "utf8") > 120) break; result += char; }
  return result.replace(/[_\p{M}]+$/gu, "") || fallback;
}
export function surnameBucket(family?: string): string {
  if (!family) return "unknown_surname";
  const first = [...family.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()][0];
  return first && /\p{L}/u.test(first) ? first : "_other";
}
const portable = (path: string): string => path.normalize("NFKC").toLowerCase();
export function catalogFiles(s: CatalogState): Map<string, unknown> {
  const files = new Map<string, unknown>([["catalog/library.json", s.library], ["catalog/config/author.json", s.owner]]);
  if (s.gscholar_profile) files.set("catalog/gscholar/profile.json", s.gscholar_profile);
  const rows: Array<{ directory: string; stem: string; id: string; value: unknown; length: number }> = [];
  for (const p of s.publications) rows.push({ directory: `catalog/publications/${publicationYear(p) === undefined ? "unknown_year" : String(publicationYear(p)).padStart(4, "0")}`, stem: slug(p.title, "publication"), id: p.id.replaceAll("-", ""), value: p, length: 8 });
  for (const a of s.authors) { const family = a.name_parts?.family; const name = family ? [family, a.name_parts?.given, a.name_parts?.suffix].filter(Boolean).join(" ") : a.preferred_name; rows.push({ directory: `catalog/authors/${surnameBucket(family)}`, stem: slug(name, "author"), id: a.id.replaceAll("-", ""), value: a, length: 8 }); }
  for (const v of s.venues) rows.push({ directory: "catalog/venues", stem: slug(v.preferred_name, "venue"), id: v.id.replaceAll("-", ""), value: v, length: 8 });
  for (const g of s.gscholar_entries) rows.push({ directory: `catalog/gscholar/entries/${g.year ?? "unknown_year"}`, stem: slug(g.title, "gscholar_entry"), id: g.id.replaceAll("-", ""), value: g, length: 8 });
  for (const r of s.reviews) rows.push({ directory: "catalog/reviews", stem: slug(r.summary, "review"), id: r.id.replaceAll("-", ""), value: r, length: 8 });
  for (;;) {
    const groups = new Map<string, typeof rows>();
    for (const r of rows) { const key = portable(`${r.directory}/${r.stem}_${r.id.slice(0, r.length)}.json`); groups.set(key, [...(groups.get(key) ?? []), r]); }
    const collisions = [...groups.values()].filter((g) => g.length > 1); if (!collisions.length) break;
    for (const group of collisions) for (const r of group) { if (r.length === 32) throw new MyPubError("Duplicate full identity/path", "DUPLICATE_UUID"); r.length = r.length === 8 ? 12 : r.length === 12 ? 16 : 32; }
  }
  for (const r of rows) files.set(`${r.directory}/${r.stem}_${r.id.slice(0, r.length)}.json`, r.value);
  return files;
}
export async function jsonFiles(root: string): Promise<string[]> {
  let entries; try { if ((await lstat(root)).isSymbolicLink()) throw new MyPubError("Catalog symlink is not permitted", "UNSAFE_PATH"); entries = await readdir(root, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const paths: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) { const path = join(root, e.name); if ((await lstat(path)).isSymbolicLink()) throw new MyPubError(`Catalog symlink is not permitted: ${path}`, "UNSAFE_PATH"); if (e.isDirectory()) paths.push(...await jsonFiles(path)); else if (e.isFile() && e.name.endsWith(".json")) paths.push(path); }
  return paths;
}
