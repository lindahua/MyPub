import type { CatalogState, NativeExport, ImportResult, Review } from "./types.js";
import { Catalog, clean } from "./catalog.js";
import { fingerprint, now, uuid } from "./utils.js";
import { MyPubError } from "./errors.js";
import { assertRecord, validTimestamp, validUuid } from "./schemas.js";
import { validateState } from "./validation.js";

export function nativeExport(s: CatalogState, publicationIds: string[]): NativeExport {
  const all = [...s.publications, ...s.authors, ...s.venues, ...s.gscholar_entries, ...s.reviews];
  const byId = new Map(all.map(r => [r.id, r])); const included = new Set<string>(); let profile = false;
  function references(value: unknown): void {
    if (typeof value === "string" && byId.has(value)) include(value);
    else if (Array.isArray(value)) value.forEach(references);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) if (key !== "evidence") references(item);
  }
  function include(id: string): void {
    if (included.has(id)) return; const record = byId.get(id); if (!record) throw new MyPubError(`Export target not found: ${id}`, "NOT_FOUND");
    included.add(id); references(record);
    if ("profile_id" in record && !profile) { profile = true; references(s.gscholar_profile); if (s.owner.self_author_id) include(s.owner.self_author_id); }
  }
  publicationIds.forEach(include);
  // Include decisions about selected records, including rejected candidate pairs.
  let size = -1; while (size !== included.size) { size = included.size; for (const r of s.reviews) if (r.targets.some(t => t.entity_id && included.has(t.entity_id))) include(r.id); }
  const { id, name, schema_version } = s.library;
  return clean({ format: "mypub-native", format_version: 1, exported_at: now(), source_library: { id, name, schema_version }, selection: { publication_ids: publicationIds }, publications: s.publications.filter(r => included.has(r.id)), authors: s.authors.filter(r => included.has(r.id)), venues: s.venues.filter(r => included.has(r.id)), gscholar_profile: profile ? s.gscholar_profile ?? null : null, gscholar_entries: s.gscholar_entries.filter(r => included.has(r.id)), reviews: s.reviews.filter(r => included.has(r.id)) });
}
export function parseNative(value: unknown): NativeExport {
  if (!value || typeof value !== "object") throw new MyPubError("Invalid native envelope", "IMPORT_INVALID");
  const e = value as NativeExport;
  const keys = ["format", "format_version", "exported_at", "source_library", "selection", "publications", "authors", "venues", "gscholar_profile", "gscholar_entries", "reviews"];
  if (Object.keys(e).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(e, k)) || e.format !== "mypub-native" || e.format_version !== 1 || !validTimestamp(e.exported_at) || !e.source_library || !validUuid(e.source_library.id) || e.source_library.schema_version !== 2 || !e.source_library.name || !Array.isArray(e.selection?.publication_ids)) throw new MyPubError("Unsupported or malformed native envelope", "IMPORT_INVALID");
  for (const [collection, kind] of [["publications", "publication"], ["authors", "author"], ["venues", "venue"], ["gscholar_entries", "gscholar_entry"], ["reviews", "review"]] as const) { if (!Array.isArray(e[collection])) throw new MyPubError(`Missing ${collection}`, "IMPORT_INVALID"); e[collection].forEach(r => assertRecord(kind, r)); }
  if (e.gscholar_profile !== null) assertRecord("gscholar_profile", e.gscholar_profile);
  if (new Set(e.selection.publication_ids).size !== e.selection.publication_ids.length || e.selection.publication_ids.some(id => !e.publications.some(p => p.id === id))) throw new MyPubError("Invalid native selection", "IMPORT_INVALID");
  return e;
}
export function applyNative(s: CatalogState, value: unknown): void {
  const e = parseNative(value);
  for (const collection of ["publications", "authors", "venues", "gscholar_entries", "reviews"] as const) {
    const rows = s[collection] as Array<{ id: string }>;
    for (const r of e[collection]) { const old = rows.find(x => x.id === r.id); if (old && fingerprint(old) !== fingerprint(r)) throw new MyPubError(`Native import UUID collision: ${r.id}`, "IMPORT_COLLISION"); if (!old) rows.push(clean(r)); }
  }
  if (e.gscholar_profile) {
    if (s.gscholar_profile && fingerprint(s.gscholar_profile) !== fingerprint(e.gscholar_profile)) throw new MyPubError("Scholar profile collision", "IMPORT_COLLISION");
    s.gscholar_profile = clean(e.gscholar_profile);
    if (!s.owner.self_author_id) {
      const matches = s.authors.filter(a => !a.merged_into && (a.identifiers.google_scholar === e.gscholar_profile!.profile_id || a.identifier_aliases?.some(i => i.provider === "google_scholar" && i.value === e.gscholar_profile!.profile_id)));
      if (matches.length !== 1) throw new MyPubError("Native Scholar context needs one confirmed owner identity", "IMPORT_COLLISION"); s.owner.self_author_id = matches[0]!.id;
    }
  }
  const validation = validateState(s); if (!validation.valid) throw new MyPubError("Native import has unresolved collisions or references", "IMPORT_COLLISION", validation);
}
export async function importNative(c: Catalog, value: unknown): Promise<ImportResult> {
  const e = parseNative(value); const hash = fingerprint(e);
  return c.change(s => {
    const repeat = s.reviews.find(r => r.evidence?.provider === "mypub-native" && r.evidence.input_fingerprint === hash);
    if (repeat) return { source_review_id: repeat.id, review_ids: [repeat.id], created: 0, matched: 0, duplicates: e.publications.length };
    // Preview all collisions against a disposable state; acceptance repeats this check.
    applyNative(clean(s), e);
    const time = now(); const r: Review = { schema_version: 2, id: uuid(), kind: "import", summary: `Import native catalog records from ${e.source_library.name} (${e.source_library.id})`, state: "pending", targets: [], proposals: [], evidence: { provider: "mypub-native", captured_at: e.exported_at, payload: e, completeness: "complete", parser_version: "mypub/2", input_fingerprint: hash }, created_at: time, updated_at: time };
    s.reviews.push(r); return { source_review_id: r.id, review_ids: [r.id], created: e.publications.filter(p => !s.publications.some(x => x.id === p.id)).length, matched: 0, duplicates: 0 };
  });
}
