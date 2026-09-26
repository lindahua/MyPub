#!/usr/bin/env node
// Read-only Crossref title search for publications without a DOI.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2];
if (!root || process.argv.length !== 3) {
  console.error("Usage: node scripts/doi-crossref-audit.mjs CATALOG_ROOT");
  process.exit(2);
}
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}
const records = await Promise.all((await files(join(root, "catalog/publications"))).filter(file => file.endsWith(".json")).map(async file => JSON.parse(await readFile(file, "utf8"))));
const venues = await Promise.all((await files(join(root, "catalog/venues"))).filter(file => file.endsWith(".json")).map(async file => JSON.parse(await readFile(file, "utf8"))));
const exemptVenueIds = new Set(venues.filter(venue => ["iclr", "icml"].includes(venue.venue_key)).map(venue => venue.id));
const exemptVenueNames = new Set(["International Conference on Learning Representations", "International Conference on Machine Learning"]);
const selected = records.filter(record => !record.archived_at && !record.identifiers.doi && record.type !== "preprint" && !(record.type === "conference" && (exemptVenueNames.has(record.venue?.name) || exemptVenueIds.has(record.venue?.venue_id))));
const results = new Array(selected.length);
let index = 0;
async function worker() {
  while (index < selected.length) {
    const at = index++, record = selected[at];
    const result = { id: record.id, title: record.title, type: record.type, publication_date: record.publication_date ?? null, authors: record.authors.map(a => a.name), official_url: record.official_url ?? null };
    try {
      const url = new URL("https://api.crossref.org/works");
      url.searchParams.set("query.title", record.title);
      url.searchParams.set("rows", "5");
      url.searchParams.set("select", "DOI,title,author,published,type,container-title,URL");
      // Crossref's public pool currently permits one request per second.
      await new Promise(resolve => setTimeout(resolve, 1250));
      let response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { "User-Agent": "MyPub DOI audit/0.1 (read-only metadata lookup)" } });
      if (response.status === 429) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { "User-Agent": "MyPub DOI audit/0.1 (read-only metadata lookup)" } });
      }
      result.status = response.status;
      if (response.ok) {
        const data = await response.json();
        result.candidates = (data.message?.items ?? []).map(item => ({ doi: item.DOI?.toLowerCase(), title: item.title?.[0], authors: item.author?.map(a => [a.given, a.family].filter(Boolean).join(" ")) ?? [], year: item.published?.["date-parts"]?.[0]?.[0] ?? null, type: item.type, venue: item["container-title"]?.[0] ?? null, url: item.URL ?? null }));
      }
    } catch (error) { result.error = String(error); }
    results[at] = result;
  }
}
await worker();
console.log(JSON.stringify({ checked: selected.length, results }, null, 2));
