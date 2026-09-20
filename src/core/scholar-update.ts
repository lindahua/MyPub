import type { Catalog } from "./catalog.js";
import { applyScholarSnapshot } from "./scholar.js";
import { MyPubError } from "./errors.js";
import { parseScholarDetail, parseScholarOverview, scholarFetcher, scholarUrl } from "../adapters/scholar.js";
import type { ScholarRow, ScholarTransportOptions } from "../adapters/scholar.js";

export interface ScholarUpdateOptions extends ScholarTransportOptions {
  onProgress?: (message: string) => void;
}
export interface ScholarDetailBackfillOptions extends ScholarUpdateOptions {
  batchSize?: number;
  limit?: number;
}
async function fetchScholarDetail(get: (url: string) => Promise<string>, url: string, title: string, onProgress?: (message: string) => void): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try { return await get(url); }
    catch (error) {
      if (!(error instanceof MyPubError) || error.code !== "SCHOLAR_FETCH" || attempt >= 3) throw error;
      onProgress?.(`Retrying Scholar detail after a transient failure (${attempt}/3): ${title}`);
    }
  }
}
/** Fetch everything before the one recoverable catalog transaction. */
export async function updateScholar(c: Catalog, options: ScholarUpdateOptions = {}) {
  const state = await c.read(), profile = state.gscholar_profile;
  if (!profile) throw new MyPubError("Configure the owner and Scholar profile before updating", "PROFILE_NOT_CONFIGURED");
  const captured = new Date().toISOString(), get = scholarFetcher(options), entries: ScholarRow[] = [], seen = new Set<string>();
  const known = new Set(state.gscholar_entries.map(g => g.scholar_id.includes(":") ? g.scholar_id : `${g.profile_id}:${g.scholar_id}`));
  const pages: { url: string; html: string }[] = [];
  let name: string | undefined, totals: Record<string, number | null> = {};
  for (let page = 0; ; page++) {
    if (page >= 1000) throw new MyPubError("Scholar exceeded 1000 profile pages", "SCHOLAR_PARSE");
    options.onProgress?.(`Fetching Scholar profile page ${page + 1}`);
    const url = scholarUrl(profile.profile_id, undefined, page * 100), html = await get(url);
    const parsed = parseScholarOverview(html, profile.profile_id);
    if (name && name !== parsed.name) throw new MyPubError("Scholar profile changed during pagination", "SCHOLAR_PARSE");
    name = parsed.name; if (page === 0) totals = parsed.totals;
    pages.push({ url, html });
    for (const entry of parsed.entries) {
      if (seen.has(entry.scholar_id)) throw new MyPubError("Scholar repeated an entry during pagination; retry the update", "SCHOLAR_PARSE");
      seen.add(entry.scholar_id); entries.push(entry);
    }
    options.onProgress?.(`Read ${parsed.entries.length} entries on page ${page + 1} (${entries.length} total)`);
    if (!parsed.hasMore) break;
  }
  const added = entries.filter(row => !known.has(row.scholar_id));
  for (const [index, row] of added.entries()) {
    options.onProgress?.(`Fetching Scholar detail ${index + 1}/${added.length}: ${row.title}`);
    const html = await get(row.scholar_url);
    pages.push({ url: row.scholar_url, html });
    Object.assign(row, parseScholarDetail(html, profile.profile_id, row.scholar_id));
  }
  options.onProgress?.(`Saving ${entries.length} Scholar entries (${added.length} new)`);
  const result = await applyScholarSnapshot(c, { rows: entries, payload: { profile_id: profile.profile_id, captured_at: captured, coverage: "complete", entries, pages }, profileId: profile.profile_id, captured, coverage: "complete", totals, sourceReference: scholarUrl(profile.profile_id), parserVersion: "mypub-scholar-web/1" });
  const previouslyAbsent = new Set(state.gscholar_entries.filter(g => g.presence === "absent").map(g => g.id));
  const absent = new Set(result.absent);
  return { ...result, observed: entries.length, added: added.length, updated: entries.length - added.length,
    newly_absent: result.absent.filter(id => !previouslyAbsent.has(id)).length,
    restored: state.gscholar_entries.filter(g => previouslyAbsent.has(g.id) && !absent.has(g.id)).length,
    citation_checks: entries.length };
}

/** Backfill detail pages for present, eligible entries whose author completeness was never established. */
export async function backfillScholarDetails(c: Catalog, options: ScholarDetailBackfillOptions = {}) {
  const state = await c.read(), profile = state.gscholar_profile;
  if (!profile) throw new MyPubError("Configure the owner and Scholar profile before backfilling details", "PROFILE_NOT_CONFIGURED");
  const batchSize = options.batchSize ?? 10;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new MyPubError("Scholar detail batch size must be a positive integer", "USAGE");
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw new MyPubError("Scholar detail limit must be a positive integer", "USAGE");
  const alreadyBackfilled = new Set(state.reviews
    .filter(review => review.state === "accepted" && review.evidence?.parser_version === "mypub-scholar-detail-backfill/1")
    .flatMap(review => review.targets.filter(target => target.entity_type === "gscholar_entry").map(target => target.entity_id))
    .filter((id): id is string => Boolean(id)));
  const allCandidates = state.gscholar_entries
    .filter(entry => entry.presence === "present" && entry.matching.policy === "eligible" && entry.authors_completeness === "unknown" && !alreadyBackfilled.has(entry.id))
    .sort((a, b) => a.scholar_id.localeCompare(b.scholar_id));
  const candidates = options.limit === undefined ? allCandidates : allCandidates.slice(0, options.limit);
  const get = scholarFetcher(options), sourceReviewIds: string[] = [], successfulIds = new Set<string>(), failedEntries: Array<{ id: string; scholar_id: string; title: string; error: string }> = [];
  for (let start = 0; start < candidates.length; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize), rows: Record<string, unknown>[] = [], pages: { url: string; html: string }[] = [];
    for (const entry of batch) {
      options.onProgress?.(`Fetching Scholar detail ${start + rows.length + 1}/${candidates.length}: ${entry.title}`);
      const url = scholarUrl(profile.profile_id, entry.scholar_id);
      try {
        const html = await fetchScholarDetail(get, url, entry.title, options.onProgress);
        pages.push({ url, html });
        const parsed = parseScholarDetail(html, profile.profile_id, entry.scholar_id);
        rows.push({ scholar_id: entry.scholar_id, ...parsed }); successfulIds.add(entry.id);
      } catch (error) {
        if (!(error instanceof MyPubError) || error.code !== "SCHOLAR_FETCH") throw error;
        failedEntries.push({ id: entry.id, scholar_id: entry.scholar_id, title: entry.title, error: error.message });
        options.onProgress?.(`Skipping Scholar detail after three transient failures: ${entry.title}`);
      }
    }
    if (!rows.length) continue;
    const captured = new Date().toISOString();
    const result = await applyScholarSnapshot(c, {
      rows, payload: { profile_id: profile.profile_id, captured_at: captured, coverage: "partial", entries: rows, pages },
      profileId: profile.profile_id, captured, coverage: "partial", sourceReference: "Google Scholar detail backfill",
      parserVersion: "mypub-scholar-detail-backfill/1", proposeMatches: false
    });
    if (result.source_review_id) sourceReviewIds.push(result.source_review_id);
    options.onProgress?.(`Saved Scholar detail batch ${Math.floor(start / batchSize) + 1} (${start + batch.length}/${candidates.length})`);
  }
  const after = await c.read();
  const processed = after.gscholar_entries.filter(entry => successfulIds.has(entry.id));
  const complete = processed.filter(entry => entry.authors_completeness === "complete").length;
  const partial = processed.filter(entry => entry.authors_completeness === "partial").length;
  const unknown = processed.filter(entry => entry.authors_completeness === "unknown").length;
  const completedBackfills = new Set(after.reviews
    .filter(review => review.state === "accepted" && review.evidence?.parser_version === "mypub-scholar-detail-backfill/1")
    .flatMap(review => review.targets.map(target => target.entity_id)));
  const remaining = after.gscholar_entries.filter(entry => entry.presence === "present" && entry.matching.policy === "eligible" && entry.authors_completeness === "unknown" && !completedBackfills.has(entry.id)).length;
  return { candidates: allCandidates.length, processed: successfulIds.size, failed: failedEntries.length, failed_entries: failedEntries, complete, partial, unknown, remaining, batches: sourceReviewIds.length, source_review_ids: sourceReviewIds };
}
