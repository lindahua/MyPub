import { load } from "cheerio";
import { setTimeout as delay } from "node:timers/promises";
import { MyPubError } from "../core/errors.js";

const base = "https://scholar.google.com";
export type ScholarRow = Record<string, unknown> & { scholar_id: string; title: string; scholar_url: string };
export function scholarUrl(profile: string, entry?: string, start = 0): string {
  const query = new URLSearchParams({ user: profile, hl: "en" });
  if (entry) { query.set("view_op", "view_citation"); query.set("citation_for_view", entry); }
  else { query.set("sortby", "pubdate"); query.set("cstart", String(start)); query.set("pagesize", "100"); }
  return `${base}/citations?${query}`;
}
function invalid(message: string): never { throw new MyPubError(message, "SCHOLAR_PARSE"); }
function document(html: string) {
  if (/please show you'?re not a robot|unusual traffic from your computer|gs_captcha|recaptcha|\/sorry\/index/i.test(html)) throw new MyPubError("Google Scholar blocked the request. Retry later.", "SCHOLAR_BLOCKED");
  return load(html);
}
function count(text: string): number | null {
  const cleaned = text.trim().replace(/\*$/, "").replace(/[,\s]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  const value = Number(cleaned); return Number.isSafeInteger(value) ? value : null;
}
export function parseScholarOverview(html: string, profile: string) {
  const $ = document(html);
  const name = $("#gsc_prf_in").text().trim();
  if (!name || $("#gsc_a_b").length !== 1 || $("#gsc_bpf_more").length !== 1) invalid("Incomplete or unrecognized Scholar profile page");
  const entries: ScholarRow[] = [];
  $("#gsc_a_b .gsc_a_tr").each((_, element) => {
    const row = $(element), link = row.find(".gsc_a_at"), title = link.text().trim();
    const href = link.attr("href");
    if (!title || !href) invalid("Scholar row has no title or entry link");
    const url = new URL(href, base), id = url.searchParams.get("citation_for_view");
    if (url.origin !== base || !id?.startsWith(`${profile}:`) || id === `${profile}:`) invalid("Scholar returned an entry from a different profile or without an ID");
    const year = row.find(".gsc_a_y").text().trim();
    const citation = row.find(".gsc_a_ac"), citationText = citation.text().trim();
    const entry: ScholarRow = { scholar_id: id, title, scholar_url: scholarUrl(profile, id), citation_count: count(citationText) };
    if (citationText.endsWith("*")) entry.estimated = true;
    const byline = row.find(".gs_gray").eq(0).text().trim(), venue = row.find(".gs_gray").eq(1).text().trim();
    if (byline) entry.authors_text = byline;
    if (venue) entry.venue = venue;
    if (/^[1-9]\d{3}$/.test(year)) entry.year = Number(year);
    const citedHref = citation.attr("href");
    if (citedHref) { const cited = new URL(citedHref, base); if (cited.protocol === "https:") entry.cited_by_url = cited.href; }
    entries.push(entry);
  });
  const hasMore = $("#gsc_bpf_more").attr("disabled") === undefined;
  // An explicit empty-profile message is required; a truncated table is not proof of absence.
  if (!entries.length && (hasMore || !$("#gsc_a_nn").text().trim())) invalid("Scholar returned an unexplained empty page");
  const totals: Record<string, number | null> = {};
  $("#gsc_rsb_st tbody tr").each((_, element) => {
    const cells = $(element).find("td"), label = cells.eq(0).text().trim().toLowerCase();
    const key = ({ citations: "citations", "h-index": "h_index", "i10-index": "i10_index" } as Record<string, string>)[label];
    if (key) totals[key] = count(cells.eq(1).text());
  });
  return { entries, hasMore, name, totals };
}
export function parseScholarDetail(html: string, profile: string, id: string): Record<string, unknown> {
  const $ = document(html), fields: Record<string, string> = {};
  $(".gsc_oci_field").each((_, element) => {
    const label = $(element).text().trim().toLowerCase(), value = $(element).next(".gsc_oci_value").text().trim();
    if (value) fields[label] = value;
  });
  const title = $("#gsc_oci_title").text().trim() || $(".gsc_oci_title_link").text().trim() || fields.title;
  if (!title || !$("#gsc_oci_table").length || !Object.keys(fields).length) invalid(`Incomplete Scholar detail page for ${id}`);
  const identity = $("input[name=citation_for_view]").attr("value");
  if (identity && identity !== id) invalid("Scholar returned the wrong detail entry");
  const result: Record<string, unknown> = { title, scholar_url: scholarUrl(profile, id) };
  for (const field of ["publication_date", "volume", "issue", "pages", "publisher", "patent_office", "application_number", "description"]) {
    const value = fields[field.replaceAll("_", " ")]; if (value) result[field] = value;
  }
  const venue = ["journal", "conference", "book", "venue", "source", "institution"].map(key => fields[key]).find(Boolean);
  if (venue) result.venue = venue;
  if (fields.authors) {
    const partial = /\.\.\.|…/.test(fields.authors);
    const authors = fields.authors.split(",").map(s => s.trim()).filter(s => s && !/\.\.\.|…/.test(s));
    result.authors_text = fields.authors; result.authors = authors;
    result.authors_completeness = authors.length ? partial ? "partial" : "complete" : "unknown";
  }
  const years = $(".gsc_oci_g_t").toArray(), bars = $(".gsc_oci_g_a").toArray();
  if (years.length && years.length === bars.length) {
    const annual: Record<string, number | null> = {};
    years.forEach((element, index) => {
      const year = $(element).text().trim(), bar = $(bars[index]!);
      if (/^[1-9]\d{3}$/.test(year)) annual[year] = count(bar.find(".gsc_oci_g_al").text() || bar.attr("aria-label") || bar.attr("title") || bar.text());
    });
    if (Object.keys(annual).length) result.annual_counts = annual;
  }
  return result;
}
export interface ScholarTransportOptions { fetch?: typeof globalThis.fetch; sleep?: (ms: number) => Promise<unknown> }
export function scholarFetcher(options: ScholarTransportOptions = {}): (url: string) => Promise<string> {
  let first = true;
  return async url => {
    if (!first) await (options.sleep ?? delay)(3000 + Math.random() * 5000);
    first = false;
    try {
      const response = await (options.fetch ?? globalThis.fetch)(url, { signal: AbortSignal.timeout(30_000), redirect: "error", headers: { "Accept": "text/html", "Accept-Language": "en-US,en;q=0.9" } });
      if ([403, 429, 503].includes(response.status)) throw new MyPubError(`Google Scholar blocked the request (HTTP ${response.status}). Retry later.`, "SCHOLAR_BLOCKED");
      if (!response.ok) throw new MyPubError(`Google Scholar returned HTTP ${response.status}`, "SCHOLAR_FETCH");
      const html = await response.text(); document(html); return html;
    } catch (error) {
      if (error instanceof MyPubError) throw error;
      throw new MyPubError(`Google Scholar request failed: ${error instanceof Error ? error.message : String(error)}`, "SCHOLAR_FETCH");
    }
  };
}
