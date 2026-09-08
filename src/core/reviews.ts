import type { CatalogState, Proposal, ProposalState, Review, ReviewState, ReviewTarget } from "./types.js";
import { Catalog, clean, touch } from "./catalog.js";
import { fingerprint, now } from "./utils.js";
import { MyPubError } from "./errors.js";
import { applyNative } from "./native.js";
import { reviewState } from "./validation.js";

export const targetCollection = { publication: "publications", author: "authors", venue: "venues", gscholar_entry: "gscholar_entries" } as const;
export function targetRecord(s: CatalogState, target: ReviewTarget): unknown {
  if (target.entity_type === "library") return s.library;
  if (target.entity_type === "gscholar_profile") return s.gscholar_profile;
  return s[targetCollection[target.entity_type]].find((r) => r.id === target.entity_id);
}
function segments(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new MyPubError("Invalid JSON Pointer", "PROPOSAL_PATH");
  const parts = path.slice(1).split("/").map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (parts.some((p) => ["__proto__", "prototype", "constructor"].includes(p))) throw new MyPubError("Unsafe JSON Pointer", "PROPOSAL_PATH");
  return parts;
}
export function pointerValue(value: unknown, path: string): unknown {
  let current = value;
  for (const part of segments(path)) { if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) return undefined; current = (current as Record<string, unknown>)[part]; }
  return current;
}
function setPointer(record: unknown, path: string, value: unknown, remove = false): unknown {
  const parts = segments(path); if (!parts.length) { if (remove) throw new MyPubError("Cannot remove entire record", "PROPOSAL_PATH"); return clean(value); }
  if (["schema_version", "id", "created_at", "updated_at"].includes(parts[0]!)) throw new MyPubError("Immutable record field", "PROPOSAL_PATH");
  let parent = record as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) { const next = parent[part]; if (typeof next !== "object" || next === null) throw new MyPubError("Pointer parent no longer exists", "STALE_REVIEW"); parent = next as Record<string, unknown>; }
  const last = parts.at(-1)!;
  if (Array.isArray(parent)) { const n = Number(last); if (!/^\d+$/.test(last) || n < 0 || n >= parent.length) throw new MyPubError("Invalid array pointer", "PROPOSAL_PATH"); if (remove) parent.splice(n, 1); else parent[n] = clean(value); }
  else if (remove) delete parent[last]; else parent[last] = clean(value);
  return record;
}
function replaceTarget(s: CatalogState, target: ReviewTarget, value: unknown, create = false): void {
  if (target.entity_type === "library") { s.library = value as CatalogState["library"]; return; }
  if (target.entity_type === "gscholar_profile") { s.gscholar_profile = value as NonNullable<CatalogState["gscholar_profile"]>; return; }
  const rows = s[targetCollection[target.entity_type]] as Array<{ id: string }>; const r = value as { id: string };
  if (r.id !== target.entity_id) throw new MyPubError("Proposed UUID differs from target", "PROPOSAL_TARGET");
  const i = rows.findIndex((x) => x.id === target.entity_id); if (create) { if (i !== -1) throw new MyPubError("Creation target already exists", "STALE_REVIEW"); rows.push(r); } else { if (i < 0) throw new MyPubError("Target no longer exists", "STALE_REVIEW"); rows[i] = r; }
}
export function checkProposals(s: CatalogState, proposals: Proposal[]): void {
  for (let i = 0; i < proposals.length; i++) {
    const a = proposals[i]!;
    for (const b of proposals.slice(i + 1)) if (fingerprint(a.target) === fingerprint(b.target) && (a.path === undefined || b.path === undefined || a.path === b.path || a.path.startsWith(`${b.path}/`) || b.path.startsWith(`${a.path}/`))) throw new MyPubError("Select one of the competing proposals for this target", "PROPOSAL_CONFLICT");
  }
  for (const p of proposals) {
    const record = targetRecord(s, p.target);
    if (p.operation === "create") { if (record) throw new MyPubError("Creation target already exists", "STALE_REVIEW"); continue; }
    if (!record || !p.expected_revision || p.expected_revision !== fingerprint(record)) throw new MyPubError("Review target changed; regenerate or reopen the proposal", "STALE_REVIEW");
    if (p.path !== undefined) {
      const current = pointerValue(record, p.path);
      if (Object.hasOwn(p, "current") ? current === undefined || fingerprint(current) !== fingerprint(p.current) : current !== undefined) throw new MyPubError("Review's current value no longer matches", "STALE_REVIEW");
    }
  }
}
export function applyProposals(s: CatalogState, proposals: Proposal[]): void {
  checkProposals(s, proposals);
  for (const p of proposals) {
    if (p.operation === "create") { replaceTarget(s, p.target, clean(p.proposed), true); continue; }
    let record = targetRecord(s, p.target) as Record<string, unknown>;
    if (p.operation === "archive") record.archived_at = now();
    else if (p.operation === "restore") delete record.archived_at;
    else if (p.operation === "merge") throw new MyPubError("Use the reviewed identity merge operation", "PROPOSAL_OPERATION");
    else record = setPointer(record, p.path!, p.proposed, p.operation === "remove" || p.operation === "unlink" && !Object.hasOwn(p, "proposed")) as Record<string, unknown>;
    touch(record as unknown as { updated_at: string }); replaceTarget(s, p.target, record);
  }
}
export async function listReviews(c: Catalog, state?: ReviewState): Promise<Review[]> { return (await c.read()).reviews.filter((r) => !state || r.state === state).sort((a, b) => b.created_at.localeCompare(a.created_at)); }
export async function getReview(c: Catalog, id: string): Promise<Review> { const r = (await c.read()).reviews.find((r) => r.id === id); if (!r) throw new MyPubError("Review not found", "NOT_FOUND"); return r; }
export async function decideReview(c: Catalog, id: string, state: Exclude<ProposalState, "pending">, note?: string, proposalIds?: string[]): Promise<Review> {
  return c.change((s) => {
    const r = s.reviews.find((r) => r.id === id); if (!r) throw new MyPubError("Review not found", "NOT_FOUND");
    const selected = r.proposals.filter((p) => (!proposalIds || proposalIds.includes(p.id)) && ["pending", "deferred"].includes(p.state));
    if (r.proposals.length && !selected.length || !r.proposals.length && ["accepted", "rejected"].includes(r.state)) throw new MyPubError("Review is already decided", "REVIEW_DECIDED");
    if (proposalIds?.some((id) => !selected.some((p) => p.id === id))) throw new MyPubError("Unknown or already decided proposal", "REVIEW_DECIDED");
    if (state === "accepted") { if (r.evidence?.provider === "mypub-native") applyNative(s, r.evidence.payload); else applyProposals(s, selected); }
    for (const p of selected) { p.state = state; if (state === "deferred") delete p.decided_at; else p.decided_at = now(); if (note) p.decision_note = note; }
    r.state = r.proposals.length ? reviewState(r) : state;
    if (r.state === "accepted" || r.state === "rejected") r.decided_at = now(); else delete r.decided_at;
    if (note) r.decision_note = note; touch(r); return r;
  });
}
export async function reopenReview(c: Catalog, id: string, proposalId?: string): Promise<Review> {
  return c.change((s) => { const r = s.reviews.find((r) => r.id === id); if (!r) throw new MyPubError("Review not found", "NOT_FOUND"); const targets = r.proposals.filter((p) => (!proposalId || p.id === proposalId) && ["rejected", "deferred"].includes(p.state)); if (!targets.length) throw new MyPubError("No rejected/deferred proposal to reopen", "REVIEW_DECIDED");
    for (const p of targets) { const record = targetRecord(s, p.target); p.state = "pending"; delete p.decided_at; if (record) { p.expected_revision = fingerprint(record); if (p.path !== undefined) { const current = pointerValue(record, p.path); if (current === undefined) delete p.current; else p.current = clean(current); } } }
    r.state = reviewState(r); delete r.decided_at; touch(r); return r;
  });
}
