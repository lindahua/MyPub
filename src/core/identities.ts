import { Catalog, clean, findPublication, manualReview, touch } from "./catalog.js";
import type { AuthorCredit, AuthorIdentity, CatalogState, NameParts, VenueIdentity } from "./types.js";
import { fingerprint, now, uuid } from "./utils.js";
import { MyPubError } from "./errors.js";
import { resolveIdentity } from "./validation.js";

type Identity = AuthorIdentity | VenueIdentity;
type Kind = "author" | "venue";
type AuthorInput = Pick<AuthorIdentity, "author_key" | "preferred_name"> & Partial<Omit<AuthorIdentity, "author_key" | "preferred_name" | "schema_version" | "created_at" | "updated_at">>;
type VenueInput = Pick<VenueIdentity, "venue_key" | "preferred_name" | "kind"> & Partial<Omit<VenueIdentity, "venue_key" | "preferred_name" | "kind" | "schema_version" | "created_at" | "updated_at">>;
const rows = (s: CatalogState, kind: Kind): Identity[] => kind === "author" ? s.authors : s.venues;
export function findIdentity(s: CatalogState, kind: "author", ref: string): AuthorIdentity;
export function findIdentity(s: CatalogState, kind: "venue", ref: string): VenueIdentity;
export function findIdentity(s: CatalogState, kind: Kind, ref: string): Identity;
export function findIdentity(s: CatalogState, kind: Kind, ref: string): Identity {
  const found = rows(s, kind).find((r) => r.id === ref || ("author_key" in r ? r.author_key : r.venue_key) === ref);
  if (!found) throw new MyPubError(`${kind} not found: ${ref}`, "NOT_FOUND"); return found;
}
export function normalizeAuthor(a: AuthorIdentity): void {
  if (a.identifiers.google_scholar?.includes("://")) { const value = new URL(a.identifiers.google_scholar).searchParams.get("user"); if (!value) throw new MyPubError("Scholar profile URL has no user ID", "IDENTIFIER_INVALID"); a.identifiers.google_scholar = value; }
  if (a.identifiers.orcid) a.identifiers.orcid = a.identifiers.orcid.replace(/^https?:\/\/orcid.org\//i, "").replace(/^orcid:\s*/i, "").toUpperCase().trim();
}
export async function addAuthor(c: Catalog, input: AuthorInput): Promise<AuthorIdentity> {
  for (const key of ["schema_version", "created_at", "updated_at"]) if (Object.hasOwn(input, key)) throw new MyPubError(`Unsupported add field: ${key}`, "SCHEMA_INVALID");
  return c.change((s) => { const time = now(); const a: AuthorIdentity = clean({ aliases: [], identifiers: {}, ...input, schema_version: 2, id: input.id ?? uuid(), created_at: time, updated_at: time }); normalizeAuthor(a); s.authors.push(a); return a; });
}
export async function addVenue(c: Catalog, input: VenueInput): Promise<VenueIdentity> {
  for (const key of ["schema_version", "created_at", "updated_at"]) if (Object.hasOwn(input, key)) throw new MyPubError(`Unsupported add field: ${key}`, "SCHEMA_INVALID");
  return c.change((s) => { const time = now(); const v: VenueIdentity = clean({ aliases: [], urls: [], ...input, schema_version: 2, id: input.id ?? uuid(), created_at: time, updated_at: time }); s.venues.push(v); return v; });
}
export async function updateIdentity(c: Catalog, kind: Kind, ref: string, patch: Record<string, unknown>, expected?: string): Promise<Identity> {
  return c.change((s) => { const item = findIdentity(s, kind, ref); if (expected && expected !== fingerprint(item)) throw new MyPubError("Identity changed", "STALE_REVISION"); for (const key of ["schema_version", "id", "created_at", "updated_at", "merged_into"]) if (Object.hasOwn(patch, key)) throw new MyPubError(`Cannot patch ${key}`, "SCHEMA_INVALID");
    const updated = clean({ ...item, ...patch }); if (kind === "author") { const a = updated as AuthorIdentity; if (patch.preferred_name !== undefined && patch.preferred_name !== item.preferred_name && !Object.hasOwn(patch, "name_parts")) delete a.name_parts; normalizeAuthor(a); }
    touch(updated); const collection = rows(s, kind); collection[collection.indexOf(item)] = updated; return updated;
  });
}
export async function archiveIdentity(c: Catalog, kind: Kind, ref: string, archived = true): Promise<Identity> {
  return c.change((s) => { const r = findIdentity(s, kind, ref); if (!archived && r.merged_into) throw new MyPubError("A merge tombstone cannot be restored independently", "MERGED_IDENTITY"); if (archived) r.archived_at = now(); else delete r.archived_at; touch(r); return r; });
}
export async function identityDetails(c: Catalog, kind: Kind, ref: string): Promise<{ identity: Identity; publications: Array<{ id: string; title: string; credits?: AuthorCredit[] }> }> {
  const s = await c.read(); const identity = findIdentity(s, kind, ref); const target = resolveIdentity(rows(s, kind), identity.id)!;
  return { identity, publications: s.publications.filter((p) => kind === "author" ? p.authors.some((a) => resolveIdentity(s.authors, a.author_id ?? "")?.id === target.id) : resolveIdentity(s.venues, p.venue?.venue_id ?? "")?.id === target.id).map((p) => ({ id: p.id, title: p.title, ...(kind === "author" ? { credits: p.authors.filter((a) => resolveIdentity(s.authors, a.author_id ?? "")?.id === target.id) } : {}) })) };
}
export async function updateCredit(c: Catalog, publication: string, position: number, patch: Partial<AuthorCredit>, expected: string): Promise<AuthorCredit> {
  return c.change((s) => { const p = findPublication(s, publication); if (!expected || fingerprint(p) !== expected) throw new MyPubError("Publication changed; inspect it before editing this position", "STALE_REVISION"); if (!Number.isInteger(position) || position < 1 || position > p.authors.length) throw new MyPubError("Invalid one-based credit position", "INVALID_POSITION");
    const credit = clean({ ...p.authors[position - 1], ...patch }) as AuthorCredit;
    if (credit.author_id) credit.author_id = findIdentity(s, "author", credit.author_id).id;
    p.authors[position - 1] = credit; touch(p); return credit;
  });
}
export async function unlinkCredit(c: Catalog, publication: string, position: number, expected: string): Promise<AuthorCredit> {
  return c.change((s) => { const p = findPublication(s, publication); if (fingerprint(p) !== expected) throw new MyPubError("Publication changed", "STALE_REVISION"); const a = p.authors[position - 1]; if (!Number.isInteger(position) || !a) throw new MyPubError("Invalid credit position", "INVALID_POSITION"); delete a.author_id; touch(p); return a; });
}
export async function linkVenue(c: Catalog, publication: string, venue?: string): Promise<void> {
  await c.change((s) => { const p = findPublication(s, publication); if (venue) { const v = findIdentity(s, "venue", venue); p.venue = { ...(p.venue ?? { name: v.preferred_name }), venue_id: v.id }; } else if (p.venue) delete p.venue.venue_id; touch(p); });
}
export async function mergeIdentity(c: Catalog, kind: Kind, source: string, target: string, apply = false): Promise<{ source_id: string; target_id: string; publication_ids: string[]; applied: boolean }> {
  const preview = (s: CatalogState) => { const from = findIdentity(s, kind, source); const to = findIdentity(s, kind, target); if (from.id === to.id || from.merged_into || to.merged_into || to.archived_at) throw new MyPubError("Choose distinct unmerged identities and an active survivor", "MERGE_INVALID"); const affected = s.publications.filter((p) => kind === "author" ? p.authors.some((a) => a.author_id === from.id) : p.venue?.venue_id === from.id); return { from, to, affected }; };
  if (!apply) { const { from, to, affected } = preview(await c.read()); return { source_id: from.id, target_id: to.id, publication_ids: affected.map((p) => p.id), applied: false }; }
  return c.change((s) => { const { from, to, affected } = preview(s);
    to.aliases = [...new Set([...to.aliases, from.preferred_name, ...from.aliases])].filter((a) => a !== to.preferred_name);
    if (kind === "author") { const a = from as AuthorIdentity; const b = to as AuthorIdentity; const all = [...(b.identifier_aliases ?? []), ...(a.identifier_aliases ?? [])]; for (const provider of ["google_scholar", "orcid"] as const) if (a.identifiers[provider] && a.identifiers[provider] !== b.identifiers[provider]) { if (!b.identifiers[provider]) b.identifiers[provider] = a.identifiers[provider]; else all.push({ provider, value: a.identifiers[provider] }); } b.identifier_aliases = all.filter((x, i) => b.identifiers[x.provider] !== x.value && all.findIndex((y) => y.provider === x.provider && y.value === x.value) === i); }
    else { const a = from as VenueIdentity; const b = to as VenueIdentity; b.urls = [...new Set([...b.urls, ...a.urls])]; }
    for (const p of affected) { if (kind === "author") for (const a of p.authors) { if (a.author_id === from.id) a.author_id = to.id; } else if (p.venue) p.venue.venue_id = to.id; touch(p); }
    if (kind === "author" && s.owner.self_author_id === from.id) s.owner.self_author_id = to.id;
    from.merged_into = to.id; from.archived_at = now(); touch(from); touch(to);
    s.reviews.push(manualReview(`Merge ${kind} ${from.preferred_name} into ${to.preferred_name}`, [{ entity_type: kind, entity_id: from.id }, { entity_type: kind, entity_id: to.id }]));
    return { source_id: from.id, target_id: to.id, publication_ids: affected.map((p) => p.id), applied: true };
  });
}
export async function configureOwner(c: Catalog, author: string, profileId?: string): Promise<void> {
  await c.change((s) => { const a = findIdentity(s, "author", author); s.owner.self_author_id = a.id; if (profileId) {
    if (s.gscholar_profile && s.gscholar_profile.profile_id !== profileId) throw new MyPubError("A profile switch requires explicit reconciliation; cannot replace it in place", "PROFILE_SWITCH");
    if (a.identifiers.google_scholar && a.identifiers.google_scholar !== profileId) throw new MyPubError("Confirm the profile on the author before configuring it", "PROFILE_OWNER");
    a.identifiers.google_scholar = profileId; touch(a); const time = now(); s.gscholar_profile ??= { schema_version: 2, profile_id: profileId, captures: [], created_at: time, updated_at: time };
  } });
}
