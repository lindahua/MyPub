import type { Catalog } from "./catalog.js";
import { applyScholarSnapshot } from "./scholar.js";
import { MyPubError } from "./errors.js";
import { parseScholarDetail, parseScholarOverview, scholarFetcher, scholarUrl } from "../adapters/scholar.js";
import type { ScholarRow, ScholarTransportOptions } from "../adapters/scholar.js";

export interface ScholarUpdateOptions extends ScholarTransportOptions {
  onProgress?: (message: string) => void;
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
  const previouslyMissing = new Set(state.gscholar_entries.filter(g => g.presence === "missing").map(g => g.id));
  const missing = new Set(result.missing);
  return { ...result, observed: entries.length, added: added.length, updated: entries.length - added.length,
    newly_missing: result.missing.filter(id => !previouslyMissing.has(id)).length,
    restored: state.gscholar_entries.filter(g => previouslyMissing.has(g.id) && !missing.has(g.id)).length,
    citation_checks: entries.length };
}
