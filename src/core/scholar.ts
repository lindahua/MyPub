import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Catalog, clean, findPublication, manualReview, pairRejected, touch } from "./catalog.js";
import type { CatalogState, Coverage, Proposal, Review, ScholarEntry, ScholarReconciliation } from "./types.js";
import { fingerprint, normalizeText, now, uuid } from "./utils.js";
import { scholarEntryIds, scholarLinkValue } from "./scholar-links.js";
import { publicationYear } from "./paths.js";
import { isObject, validTimestamp } from "./schemas.js";
import { MyPubError } from "./errors.js";
import { parseCsv } from "./csv.js";
import { reviewState } from "./validation.js";

const detailFields = ["publication_date", "volume", "issue", "pages", "publisher", "patent_office", "application_number", "description", "scholar_url", "cited_by_url", "venue", "authors_text"] as const;
const externalId = (profile: string, value: string): string => value.startsWith(`${profile}:`) ? value : `${profile}:${value}`;
function findEntry(s: CatalogState, ref: string): ScholarEntry { const matches = s.gscholar_entries.filter((g) => g.id === ref || g.scholar_id === ref || externalId(g.profile_id, ref) === externalId(g.profile_id, g.scholar_id)); if (matches.length !== 1) throw new MyPubError("Scholar entry not found or ambiguous", "NOT_FOUND"); return matches[0]!; }
export function reconcileState(s: CatalogState): ScholarReconciliation {
  const result: ScholarReconciliation = { local_only: s.publications.filter((p) => !scholarEntryIds(p).length).map((p) => p.id), matched: [], source_only: [], excluded: [], absent: [], candidates: [], rejected_pairs: [], differences: [], shared_counts: [] };
  for (const g of s.gscholar_entries) {
    const linked = s.publications.filter((p) => scholarEntryIds(p).includes(g.id));
    if (g.presence === "absent") result.absent.push(g.id);
    if (g.matching.policy === "excluded") result.excluded.push(g.id);
    else if (linked.length) result.matched.push(g.id); else result.source_only.push(g.id);
    for (const p of s.publications) if (pairRejected(s, p.id, g.id)) result.rejected_pairs.push({ publication_id: p.id, entry_id: g.id });
    if (g.matching.policy === "eligible" && g.presence === "present") {
      const candidates = s.publications.filter((p) => !p.archived_at && !scholarEntryIds(p).includes(g.id) && !pairRejected(s, p.id, g.id) && normalizeText(p.title) === normalizeText(g.title) && (!g.year || !publicationYear(p) || Math.abs(g.year - publicationYear(p)!) <= 1));
      if (candidates.length) result.candidates.push({ entry_id: g.id, publication_ids: candidates.map((p) => p.id) });
    }
    for (const p of linked) for (const [field, local, observed] of [["title", p.title, g.title], ["year", publicationYear(p), g.year], ["venue", p.venue?.name, g.venue]] as const) if (local !== undefined && observed !== undefined && local !== observed) result.differences.push({ publication_id: p.id, entry_id: g.id, field, local, observed });
    if (linked.length > 1) result.shared_counts.push({ entry_id: g.id, publication_ids: linked.map((p) => p.id), citation_count: g.citation_history.at(-1)?.count ?? null });
  }
  return result;
}
export async function reconcileScholar(c: Catalog): Promise<ScholarReconciliation> { return reconcileState(await c.read()); }
function citationValue(value: unknown): number | null {
  if (value === null || value === "" || value === "null") return null;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new MyPubError("Citation count must be a non-negative integer or null", "IMPORT_INVALID"); return n;
}
export async function importScholarSnapshot(c: Catalog, path: string, coverage: Coverage = "unknown", observedAt = now()): Promise<ScholarReconciliation> {
  const contents = await readFile(path, "utf8"); let payload: unknown; let rows: Record<string, unknown>[]; let profileId: string | undefined; let captured = observedAt; let totals: unknown;
  if (extname(path).toLowerCase() === ".csv") { rows = parseCsv(contents); payload = rows; }
  else { payload = JSON.parse(contents) as unknown; if (!isObject(payload) || !Array.isArray(payload.entries) || !payload.entries.every(isObject)) throw new MyPubError("Scholar JSON requires an entries array", "IMPORT_INVALID"); rows = payload.entries; profileId = typeof payload.profile_id === "string" ? payload.profile_id : undefined; captured = typeof payload.captured_at === "string" ? payload.captured_at : observedAt; totals = payload.totals; if (payload.coverage !== undefined) { if (!["complete", "partial", "unknown"].includes(String(payload.coverage))) throw new MyPubError("Invalid capture coverage", "IMPORT_INVALID"); coverage = payload.coverage as Coverage; } }
  return applyScholarSnapshot(c, { rows, payload, profileId, captured, totals, coverage, sourceReference: basename(path) });
}
export interface ScholarSnapshotInput {
  rows: Record<string, unknown>[]; payload: unknown; profileId: string | undefined;
  captured: string; totals?: unknown; coverage: Coverage; sourceReference: string;
  parserVersion?: string;
}
export async function applyScholarSnapshot(c: Catalog, input: ScholarSnapshotInput): Promise<ScholarReconciliation> {
  const { rows, payload, profileId, captured, totals, coverage } = input;
  if (!validTimestamp(captured)) throw new MyPubError("Capture time must be a UTC timestamp", "IMPORT_INVALID");
  const inputFingerprint = fingerprint({ provider: "google_scholar", payload, captured_at: captured, coverage });
  return c.change((s) => {
    const profile = s.gscholar_profile; if (!profile) throw new MyPubError("Configure the owner and Scholar profile before importing", "PROFILE_NOT_CONFIGURED");
    if (profileId && profileId !== profile.profile_id) throw new MyPubError("Snapshot belongs to another profile", "PROFILE_MEMBERSHIP");
    const previous = s.reviews.find((r) => r.evidence?.input_fingerprint === inputFingerprint); if (previous) return { ...reconcileState(s), source_review_id: previous.id };
    const time = now(); const source: Review = { schema_version: 2, id: uuid(), summary: `Import Google Scholar ${captured}`, kind: "import", state: "accepted", targets: [], evidence: { provider: "google_scholar", captured_at: captured, source_reference: input.sourceReference, payload, completeness: coverage, parser_version: input.parserVersion ?? "mypub-scholar/2", input_fingerprint: inputFingerprint }, proposals: [], created_at: time, updated_at: time, decided_at: time };
    s.reviews.push(source); const observed: string[] = []; const seen = new Set<string>(); let unidentified = false;
    for (const row of rows) {
      const sourceProfile = row.profile_id ?? row.profile_user_id; if (sourceProfile && sourceProfile !== profile.profile_id) throw new MyPubError("Mixed Scholar profiles are not supported", "PROFILE_MEMBERSHIP");
      let rawId = row.scholar_id ?? row.citation_id ?? row.article_id;
      const url = row.scholar_url ?? row.article_url ?? row.url;
      if (!rawId && typeof url === "string") rawId = new URL(url).searchParams.get("citation_for_view");
      if (typeof rawId !== "string" || !rawId.trim()) { unidentified = true; continue; }
      if (rawId.includes(":") && !rawId.startsWith(`${profile.profile_id}:`)) throw new MyPubError("Scholar entry prefix belongs to another profile", "PROFILE_MEMBERSHIP");
      const scholarId = externalId(profile.profile_id, rawId.trim()); if (seen.has(scholarId)) throw new MyPubError("Duplicate entry in one capture", "IMPORT_INVALID"); seen.add(scholarId);
      let g = s.gscholar_entries.find((g) => externalId(g.profile_id, g.scholar_id) === scholarId); const isNew = !g;
      if (!g) { if (typeof row.title !== "string" || !row.title.trim()) throw new MyPubError("New Scholar entries require a title", "IMPORT_INVALID"); g = { schema_version: 2, id: uuid(), profile_id: profile.profile_id, scholar_id: scholarId, title: row.title, authors: [], authors_completeness: "unknown", matching: { policy: "eligible" }, first_seen_at: captured, last_seen_at: captured, presence: "present", source_review_id: source.id, citation_history: [], created_at: time, updated_at: time }; s.gscholar_entries.push(g); }
      observed.push(g.id); source.targets.push({ entity_type: "gscholar_entry", entity_id: g.id });
      if (isNew || Date.parse(captured) >= Date.parse(g.last_seen_at)) {
        if (typeof row.title === "string" && row.title.trim()) g.title = row.title;
        for (const field of detailFields) { const value = row[field]; if (typeof value === "string" && value.trim()) g[field] = value; }
        if (typeof url === "string" && url.trim()) g.scholar_url = url;
        if (row.year !== undefined && row.year !== null && row.year !== "") { const year = Number(row.year); if (!Number.isInteger(year) || year < 1000 || year > 9999) throw new MyPubError("Invalid Scholar year", "IMPORT_INVALID"); g.year = year; }
        let names: unknown = row.author_names ?? row.authors;
        if (typeof names === "string") { if (names.trim().startsWith("[")) names = JSON.parse(names); else { g.authors_text = names; names = undefined; } }
        const completeness = row.authors_completeness ?? "unknown";
        if (!["complete", "partial", "unknown"].includes(String(completeness))) throw new MyPubError("Invalid authors completeness", "IMPORT_INVALID");
        if (names !== undefined) { if (!Array.isArray(names) || !names.every((n) => typeof n === "string" && !!n.trim() && !["...", "…"].includes(n.trim()))) throw new MyPubError("Invalid source author array", "IMPORT_INVALID"); if (g.authors_completeness !== "complete" || completeness === "complete") { g.authors = names as string[]; g.authors_completeness = completeness as Coverage; } }
        if (g.presence !== "absent" || !g.absent_since || Date.parse(captured) >= Date.parse(g.absent_since)) { g.presence = "present"; delete g.absent_since; }
        g.last_seen_at = captured; g.source_review_id = source.id;
      }
      if (Date.parse(captured) < Date.parse(g.first_seen_at)) g.first_seen_at = captured;
      const citationKey = ["citation_count", "citations", "cited_by", "cited_by_count"].find((k) => Object.hasOwn(row, k));
      if (citationKey) { const observed_at = typeof row.observed_at === "string" ? row.observed_at : captured; const sample = { observed_at, count: citationValue(row[citationKey]), source_review_id: source.id, ...(row.estimated === true || row.estimated === false ? { estimated: row.estimated } : {}) }; g.citation_history.push(sample); g.citation_history.sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at)); }
      if (isObject(row.annual_counts)) { const counts = Object.fromEntries(Object.entries(row.annual_counts).map(([y, n]) => [y, citationValue(n)])); g.annual_citations ??= []; g.annual_citations.push({ observed_at: typeof row.annual_observed_at === "string" ? row.annual_observed_at : captured, counts, source_review_id: source.id }); }
      touch(g);
    }
    const effectiveCoverage = unidentified ? "unknown" : coverage;
    const capture = { captured_at: captured, coverage: effectiveCoverage, source_review_id: source.id, observed_entry_ids: observed, ...(totals !== undefined ? { totals: totals as NonNullable<(typeof profile.captures)[number]["totals"]> } : {}) };
    profile.captures.push(capture); profile.captures.sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at)); touch(profile);
    // Recompute against the full dated capture history, including out-of-order imports.
    for (const g of s.gscholar_entries) {
      const absent = profile.captures.find(capture => capture.coverage === "complete" && Date.parse(capture.captured_at) > Date.parse(g.last_seen_at) && !capture.observed_entry_ids.includes(g.id));
      if (absent) {
        g.presence = "absent"; g.absent_since = absent.captured_at;
        if (!g.citation_history.some(sample => sample.observed_at === absent.captured_at && sample.source_review_id === absent.source_review_id)) g.citation_history.push({ observed_at: absent.captured_at, count: null, source_review_id: absent.source_review_id });
        g.citation_history.sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at)); touch(g);
        if (g.matching.policy !== "excluded") {
          const target = { entity_type: "gscholar_entry" as const, entity_id: g.id };
          if (!source.targets.some(item => item.entity_type === target.entity_type && item.entity_id === target.entity_id)) source.targets.push(target);
          const proposed = { policy: "excluded" as const, reason: "absent", decision_review_id: source.id };
          source.proposals.push({ id: uuid(), target, operation: "replace", path: "/matching", expected_revision: fingerprint(g), current: clean(g.matching), proposed, state: "accepted", decided_at: time });
          g.matching = proposed; touch(g);
          for (const p of s.publications.filter(p => scholarEntryIds(p).includes(g.id))) {
            const publicationTarget = { entity_type: "publication" as const, entity_id: p.id }; const old = clean(p.gscholar_entry_id); const next = scholarLinkValue(scholarEntryIds(p).filter(id => id !== g.id));
            if (!source.targets.some(item => item.entity_type === publicationTarget.entity_type && item.entity_id === publicationTarget.entity_id)) source.targets.push(publicationTarget);
            source.proposals.push({ id: uuid(), target: publicationTarget, operation: "unlink", path: "/gscholar_entry_id", expected_revision: fingerprint(p), current: old, ...(next !== undefined ? { proposed: clean(next) } : {}), candidate_ids: [g.id], state: "accepted", decided_at: time });
            if (next === undefined) delete p.gscholar_entry_id; else p.gscholar_entry_id = next; touch(p);
          }
        }
      } else if (g.presence === "absent") { g.presence = "present"; delete g.absent_since; touch(g); }
    }
    const result = reconcileState(s);
    const proposals: Proposal[] = result.candidates.flatMap((candidate) => candidate.publication_ids.flatMap((publicationId) => {
      if (s.reviews.some((r) => r.proposals.some((p) => ["pending", "deferred"].includes(p.state) && p.target.entity_id === publicationId && p.path === "/gscholar_entry_id" && (p.proposed === candidate.entry_id || p.candidate_ids?.includes(candidate.entry_id))))) return [];
      const p = s.publications.find((p) => p.id === publicationId)!; const current = p.gscholar_entry_id; const proposed = scholarLinkValue([...scholarEntryIds(p), candidate.entry_id]); return [{ id: uuid(), target: { entity_type: "publication" as const, entity_id: p.id }, operation: "link" as const, path: "/gscholar_entry_id", expected_revision: fingerprint(p), ...(current !== undefined ? { current: clean(current) } : {}), proposed, candidate_ids: [candidate.entry_id], state: "pending" as const }];
    }));
    if (proposals.length) s.reviews.push({ schema_version: 2, id: uuid(), summary: `Match Google Scholar ${captured}`, kind: "change", state: "pending", targets: [], source_review_id: source.id, proposals, created_at: time, updated_at: time });
    return { ...result, source_review_id: source.id };
  });
}
export async function linkScholar(c: Catalog, publication: string, entry?: string): Promise<void> {
  await c.change((s) => { const p = findPublication(s, publication); const old = p.gscholar_entry_id; const g = entry ? findEntry(s, entry) : undefined; const oldIds = scholarEntryIds(p);
    if (g && oldIds.includes(g.id) || !g && !oldIds.length) return;
    const next = g ? scholarLinkValue([...oldIds, g.id]) : undefined;
    const proposal: Proposal = { id: uuid(), target: { entity_type: "publication", entity_id: p.id }, operation: g ? "link" : "unlink", path: "/gscholar_entry_id", expected_revision: fingerprint(p), ...(old !== undefined ? { current: clean(old) } : {}), ...(g ? { proposed: clean(next), candidate_ids: [g.id] } : {}), state: "accepted", decided_at: now() };
    if (next === undefined) delete p.gscholar_entry_id; else p.gscholar_entry_id = next; touch(p); s.reviews.push(manualReview(`${g ? "Link" : "Unlink"} Scholar ${p.title}`, [proposal.target], [proposal]));
  });
}
export async function unlinkScholar(c: Catalog, publication: string, entry?: string): Promise<void> {
  if (!entry) return linkScholar(c, publication);
  await c.change((s) => { const p = findPublication(s, publication); const g = findEntry(s, entry); const old = p.gscholar_entry_id; const ids = scholarEntryIds(p); if (!ids.includes(g.id)) return; const next = scholarLinkValue(ids.filter(id => id !== g.id));
    const proposal: Proposal = { id: uuid(), target: { entity_type: "publication", entity_id: p.id }, operation: "unlink", path: "/gscholar_entry_id", expected_revision: fingerprint(p), current: clean(old), ...(next !== undefined ? { proposed: clean(next) } : {}), candidate_ids: [g.id], state: "accepted", decided_at: now() };
    if (next === undefined) delete p.gscholar_entry_id; else p.gscholar_entry_id = next; touch(p); s.reviews.push(manualReview(`Unlink Scholar ${p.title}`, [proposal.target], [proposal]));
  });
}
export async function matchingPolicy(c: Catalog, entry: string, excluded: boolean, reason?: string, unlinkPublications = false, preview = false): Promise<{ entry_id: string; publication_ids: string[]; applied: boolean }> {
  const inspect = (s: CatalogState) => { const g = findEntry(s, entry); return { g, linked: s.publications.filter((p) => scholarEntryIds(p).includes(g.id)) }; };
  if (preview) { const { g, linked } = inspect(await c.read()); return { entry_id: g.id, publication_ids: linked.map((p) => p.id), applied: false }; }
  return c.change((s) => { const { g, linked } = inspect(s); if (excluded && !reason?.trim()) throw new MyPubError("Exclusion requires a reason", "EXCLUSION_REASON"); if (excluded && linked.length && !unlinkPublications) throw new MyPubError("Excluding this entry requires --unlink-publications", "EXCLUDED_LINK", linked.map((p) => p.id));
    const review = manualReview(`${excluded ? "Exclude" : "Include"} Scholar ${g.title}`, [{ entity_type: "gscholar_entry", entity_id: g.id }]);
    const matching = { policy: excluded ? "excluded" as const : "eligible" as const, ...(reason ? { reason } : {}), decision_review_id: review.id };
    review.proposals.push({ id: uuid(), target: review.targets[0]!, operation: "replace", path: "/matching", expected_revision: fingerprint(g), current: clean(g.matching), proposed: matching, state: "accepted", decided_at: now() });
    if (excluded) for (const p of linked) { const old = clean(p.gscholar_entry_id); const next = scholarLinkValue(scholarEntryIds(p).filter(id => id !== g.id)); review.targets.push({ entity_type: "publication", entity_id: p.id }); review.proposals.push({ id: uuid(), target: { entity_type: "publication", entity_id: p.id }, operation: "unlink", path: "/gscholar_entry_id", expected_revision: fingerprint(p), current: old, ...(next !== undefined ? { proposed: clean(next) } : {}), candidate_ids: [g.id], state: "accepted", decided_at: now() }); if (next === undefined) delete p.gscholar_entry_id; else p.gscholar_entry_id = next; touch(p); }
    g.matching = matching; touch(g); s.reviews.push(review); return { entry_id: g.id, publication_ids: linked.map((p) => p.id), applied: true };
  });
}
