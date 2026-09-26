#!/usr/bin/env node
// Read-only check of DOIs published in official landing-page metadata.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { load } from "cheerio";

const [root, mode] = process.argv.slice(2);
if (!root || (mode && !["--missing-only", "--with-doi"].includes(mode))) {
  console.error("Usage: node scripts/doi-page-audit.mjs CATALOG_ROOT [--missing-only|--with-doi]");
  process.exit(2);
}
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]));
  return paths.flat();
}
const sourceFiles = (await files(join(root, "catalog/publications"))).filter(file => file.endsWith(".json"));
const records = await Promise.all(sourceFiles.map(async file => ({ file, ...JSON.parse(await readFile(file, "utf8")) })));
const venues = await Promise.all((await files(join(root, "catalog/venues"))).filter(file => file.endsWith(".json")).map(async file => JSON.parse(await readFile(file, "utf8"))));
const exemptVenueIds = new Set(venues.filter(venue => ["iclr", "icml"].includes(venue.venue_key)).map(venue => venue.id));
const exemptVenueNames = new Set(["International Conference on Learning Representations", "International Conference on Machine Learning"]);
const exemptMissingDoi = record => record.type === "conference" && !record.identifiers.doi && (exemptVenueNames.has(record.venue?.name) || exemptVenueIds.has(record.venue?.venue_id));
const selected = records.filter(record => !record.archived_at && record.official_url && !exemptMissingDoi(record) && (mode !== "--missing-only" || !record.identifiers.doi) && (mode !== "--with-doi" || record.identifiers.doi && record.type !== "preprint"));
const results = new Array(selected.length);
let index = 0;
const normalize = value => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const doiFrom = value => String(value ?? "").match(/(?:https?:\/\/(?:dx\.)?doi\.org\/|\bdoi\s*:\s*)?(10\.\d{4,9}\/[^\s<>"'?#]+)/i)?.[1]?.replace(/[.,;)]$/, "").toLowerCase();
async function worker() {
  while (index < selected.length) {
    const at = index++, record = selected[at];
    const result = { id: record.id, title: record.title, type: record.type, official_url: record.official_url, stored_doi: record.identifiers.doi ?? null };
    try {
      const response = await fetch(record.official_url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "MyPub DOI audit (bibliographic metadata verification)" } });
      result.status = response.status;
      if (response.ok && response.headers.get("content-type")?.includes("html")) {
        const html = await response.text();
        const $ = load(html);
        const meta = name => $(`meta[name="${name}"], meta[property="${name}"]`).first().attr("content");
        const host = new URL(record.official_url).hostname.replace(/^www\./, "");
        const hostDoi = host === "ijcai.org" ? $("a[href^='https://doi.org/'], a[href^='http://dx.doi.org/']").first().attr("href")
          : host === "roboticsproceedings.org" ? $("body").text().match(/\bDOI\s*=\s*\{([^}]+)\}/i)?.[1]
          : undefined;
        const candidates = [meta("citation_doi"), meta("dc.identifier"), meta("DC.Identifier"), meta("prism.doi"), meta("doi"), meta("citation_id"), hostDoi].map(doiFrom).filter(Boolean);
        result.page_dois = [...new Set(candidates)];
        result.page_title = meta("citation_title") ?? meta("dc.title") ?? meta("og:title") ?? null;
        result.title_matches = result.page_title ? normalize(result.page_title) === normalize(record.title) : null;
      }
    } catch (error) { result.error = String(error); }
    results[at] = result;
  }
}
await Promise.all(Array.from({ length: 4 }, () => worker()));
console.log(JSON.stringify({ checked: selected.length, results }, null, 2));
