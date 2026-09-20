import type { CatalogState, Publication, Proposal, AuthorIdentity } from "./types.js";
import { fingerprint, now, uuid } from "./utils.js";
import { resolveIdentity } from "./validation.js";

/** Exact name matching, ignoring Unicode compatibility, case and whitespace only. */
export const authorNameKey = (name: string): string => name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

export function resolvePublicationAuthors(s: CatalogState, publications: Publication[]) {
  const time = now(), proposals: Proposal[] = [];
  let linked = 0, created = 0, unresolved = 0;
  const names = new Map<string, Set<string>>();
  const index = (name: string, id: string) => {
    const a = resolveIdentity(s.authors, id);
    if (!a || a.archived_at) return;
    const key = authorNameKey(name), ids = names.get(key) ?? new Set<string>();
    ids.add(a.id); names.set(key, ids);
  };
  for (const a of s.authors) for (const name of [a.preferred_name, ...a.aliases]) index(name, a.id);
  for (const p of s.publications) for (const a of p.authors) if (a.author_id) index(a.name, a.author_id);
  for (const p of publications) {
    if (p.archived_at) continue;
    const current = structuredClone(p.authors), expected_revision = fingerprint(p);
    const used = new Set(p.authors.flatMap(a => a.author_id ? [resolveIdentity(s.authors, a.author_id)?.id ?? a.author_id] : []));
    for (const credit of p.authors) {
      if (credit.author_id) continue;
      const key = authorNameKey(credit.name), matches = [...(names.get(key) ?? [])];
      // Never choose an arbitrary occurrence in a repeated-name byline.
      if (matches.length > 1 || p.authors.filter(a => authorNameKey(a.name) === key).length > 1 || matches.some(id => used.has(id))) { unresolved++; continue; }
      let id = matches[0];
      if (!id) {
        id = uuid();
        const a: AuthorIdentity = { schema_version: 2, id, author_key: `author-${id}`, preferred_name: credit.name, aliases: [], identifiers: {}, created_at: time, updated_at: time };
        s.authors.push(a); index(credit.name, id); created++;
        proposals.push({ id: uuid(), target: { entity_type: "author", entity_id: id }, operation: "create", proposed: structuredClone(a), state: "accepted", decided_at: time });
      }
      credit.author_id = id; used.add(id); linked++;
    }
    if (fingerprint(current) !== fingerprint(p.authors)) {
      p.updated_at = new Date(Math.max(Date.parse(p.updated_at), Date.parse(time))).toISOString().replace(/\.\d{3}Z$/, "Z");
      proposals.push({ id: uuid(), target: { entity_type: "publication", entity_id: p.id }, operation: "replace", path: "/authors", expected_revision, current, proposed: structuredClone(p.authors), state: "accepted", decided_at: time });
    }
  }
  if (proposals.length) s.reviews.push({ schema_version: 2, id: uuid(), kind: "identity", summary: `Resolve ${linked} author credits by name; create ${created} identities`, state: "accepted", targets: proposals.map(p => p.target), proposals, decision_note: "User-approved name policy: unique active name match links automatically; no match creates an identity. Multiple candidates and duplicate-person byline conflicts remain unresolved. Literal names and existing links are preserved.", created_at: time, updated_at: time, decided_at: time });
  return { linked, created, unresolved };
}
