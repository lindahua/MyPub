import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AddPublicationInput, Author, ImportResult, Observation, Publication, PublicationType, Review } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { Catalog } from "./catalog.js";
import { atomicWriteJson, fingerprint, normalizeArxiv, normalizeDoi, normalizeText, now, uuid, withLock } from "./utils.js";
import { MyPubError } from "./errors.js";

type Imported = AddPublicationInput & { source_id?: string; raw?: unknown };

function splitCsvLine(line: string): string[] {
  const fields: string[] = []; let field = ""; let quoted = false;
  for (let index = 0; index < line.length; index++) { const char = line[index]!; if (char === '"') { if (quoted && line[index + 1] === '"') { field += '"'; index++; } else quoted = !quoted; } else if (char === "," && !quoted) { fields.push(field); field = ""; } else field += char; }
  fields.push(field); return fields;
}

function authors(value = ""): Author[] { return value.split(/\s+and\s+|\s*;\s*/i).map((name) => name.trim()).filter(Boolean).map((name) => ({ name })); }
function type(value = ""): PublicationType { const v = value.toLowerCase(); if (v.includes("article") || v.includes("journal")) return "journal"; if (v.includes("conference") || v.includes("inproceedings")) return "conference"; if (v.includes("workshop")) return "workshop"; if (v.includes("thesis")) return "thesis"; if (v.includes("arxiv")) return "arxiv"; return "other"; }

function parseCsv(contents: string): Imported[] {
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim()); if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]!).map((header) => normalizeText(header).replace(/ /g, "_"));
  return lines.slice(1).map((line, row) => {
    const values = splitCsvLine(line); const get = (...names: string[]): string | undefined => { for (const name of names) { const index = headers.indexOf(name); if (index >= 0 && values[index]?.trim()) return values[index]!.trim(); } return undefined; };
    const title = get("title"); if (!title) throw new MyPubError(`CSV row ${row + 2} has no title`, "IMPORT_INVALID");
    const year = get("year", "publication_year"); const doi = get("doi"); const arxiv = get("arxiv", "arxiv_id");
    const sourceId = get("scholar_id", "article_id");
    const url = get("url"); const tagText = get("tags", "keywords");
    return { citation_key: get("citation_key", "key", "id") ?? `import-${row + 1}-${fingerprint(title).slice(0, 8)}`, type: type(get("type", "entry_type")), status: "published", title, authors: authors(get("authors", "author")), ...(year ? { dates: { issued: year } } : {}), ...(doi || arxiv ? { identifiers: { ...(doi ? { doi: normalizeDoi(doi) } : {}), ...(arxiv ? { arxiv: normalizeArxiv(arxiv) } : {}) } } : {}), ...(get("venue", "journal", "booktitle") ? { venue: get("venue", "journal", "booktitle")! } : {}), ...(url ? { urls: [url] } : {}), ...(tagText ? { tags: tagText.split(/[;,]/).map((tag) => tag.trim()).filter(Boolean) } : {}), ...(sourceId ? { source_id: sourceId } : {}), raw: Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])) };
  });
}

function parseBibtex(contents: string): Imported[] {
  const records: Imported[] = []; const entry = /@(\w+)\s*\{\s*([^,]+),([\s\S]*?)(?=\n\s*@\w+\s*\{|\s*$)/g;
  for (const match of contents.matchAll(entry)) {
    const fields: Record<string, string> = {}; const body = match[3]!.replace(/\}\s*$/, "");
    const fieldPattern = /(\w[\w-]*)\s*=\s*(?:\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)"|([^,\n]+))\s*,?/g;
    for (const field of body.matchAll(fieldPattern)) fields[field[1]!.toLowerCase()] = (field[2] ?? field[3] ?? field[4] ?? "").trim();
    if (!fields.title) continue;
    records.push({ citation_key: match[2]!.trim(), type: type(match[1]), status: fields.year ? "published" : "draft", title: fields.title.replace(/[{}]/g, ""), authors: authors(fields.author), ...(fields.journal || fields.booktitle ? { venue: fields.journal ?? fields.booktitle } : {}), ...(fields.year ? { dates: { issued: fields.year } } : {}), ...(fields.doi || fields.eprint ? { identifiers: { ...(fields.doi ? { doi: normalizeDoi(fields.doi) } : {}), ...(fields.eprint ? { arxiv: normalizeArxiv(fields.eprint) } : {}) } } : {}), ...(fields.url ? { urls: [fields.url] } : {}), ...(fields.keywords ? { tags: fields.keywords.split(/[,;]/).map((tag) => tag.trim()).filter(Boolean) } : {}), raw: fields });
  }
  if (!records.length) throw new MyPubError("No BibTeX entries found", "IMPORT_INVALID");
  return records;
}

function fromJson(value: unknown): Imported[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => { if (typeof item !== "object" || item === null) throw new MyPubError("JSON import entries must be objects", "IMPORT_INVALID"); const record = item as Record<string, unknown>; if (typeof record.title !== "string" || !Array.isArray(record.authors)) throw new MyPubError("JSON entry requires title and authors", "IMPORT_INVALID"); return record as unknown as Imported; });
}

function changes(current: Publication, proposed: Imported): Review["changes"] {
  const fields: Array<keyof Imported> = ["title", "authors", "venue", "dates", "identifiers", "urls", "tags", "type", "status"];
  return fields.flatMap((field) => {
    const incoming = proposed[field];
    if (incoming === undefined || JSON.stringify(current[field as keyof Publication]) === JSON.stringify(incoming)) return [];
    if (field === "authors" && Array.isArray(incoming) && incoming.length < current.authors.length) return [];
    return [{ field: String(field), current: current[field as keyof Publication], proposed: incoming }];
  });
}

export async function importFile(catalog: Catalog, path: string, provider?: string, completeness: Observation["completeness"] = "complete"): Promise<ImportResult> {
  const contents = await readFile(path, "utf8"); const extension = extname(path).toLowerCase();
  const parsed = extension === ".bib" || extension === ".bibtex" ? parseBibtex(contents) : extension === ".csv" ? parseCsv(contents) : fromJson(JSON.parse(contents));
  const sourceFingerprint = fingerprint({ provider: provider ?? extension.slice(1), contents });
  const existingReviews = await readReviewFiles(catalog); const repeat = existingReviews.filter((review) => review.source_fingerprint === sourceFingerprint);
  if (repeat.length) return { observation_id: repeat[0]!.observation_id ?? "", review_ids: repeat.map((review) => review.id), created: repeat.filter((review) => review.kind === "create").length, matched: repeat.filter((review) => review.kind === "update").length, duplicates: parsed.length };
  return withLock(join(catalog.localDir, "write.lock"), async () => {
    const publications = await catalog.list({ includeArchived: true }); const observationId = uuid(); const timestamp = now(); const reviewIds: string[] = []; let created = 0; let matched = 0;
    const observation: Observation = { schema_version: SCHEMA_VERSION, id: observationId, kind: provider === "scholar" ? "citation" : "metadata", provider: provider ?? extension.slice(1), publication_ids: [], observed_at: timestamp, source: path, payload: parsed.map((item) => item.raw ?? item), completeness, parser_version: "mypub/1" };
    for (const item of parsed) {
      const candidates = publications.filter((publication) => (item.identifiers?.doi && publication.identifiers.doi === normalizeDoi(item.identifiers.doi)) || (item.identifiers?.arxiv && publication.identifiers.arxiv === normalizeArxiv(item.identifiers.arxiv)) || (normalizeText(publication.title) === normalizeText(item.title) && publication.authors.some((author) => item.authors.some((incoming) => normalizeText(incoming.name) === normalizeText(author.name)))));
      const matchedPublication = candidates.length === 1 ? candidates[0] : undefined; const reviewId = uuid();
      const review: Review = { schema_version: SCHEMA_VERSION, id: reviewId, kind: matchedPublication ? "update" : "create", state: "pending", ...(matchedPublication ? { publication_id: matchedPublication.id } : {}), observation_id: observationId, ...(matchedPublication ? {} : { proposed_publication: proposalToPublication(item) }), changes: matchedPublication ? changes(matchedPublication, item) : [], candidate_ids: candidates.map((candidate) => candidate.id), source_fingerprint: sourceFingerprint, created_at: timestamp };
      await atomicWriteJson(join(catalog.reviewsDir, `${reviewId}.json`), review); reviewIds.push(reviewId); if (matchedPublication) { matched++; observation.publication_ids.push(matchedPublication.id); } else created++;
    }
    await atomicWriteJson(join(catalog.observationsDir, `${observationId}.json`), observation);
    return { observation_id: observationId, review_ids: reviewIds, created, matched, duplicates: 0 };
  });
}

function proposalToPublication(input: Imported): Publication { const timestamp = now(); return { schema_version: SCHEMA_VERSION, id: input.id ?? uuid(), citation_key: input.citation_key, type: input.type, status: input.status ?? "published", title: input.title, authors: input.authors, dates: input.dates ?? {}, identifiers: input.identifiers ?? {}, urls: input.urls ?? [], tags: input.tags ?? [], relations: input.relations ?? [], attachments: input.attachments ?? [], created_at: timestamp, updated_at: timestamp, ...(input.venue ? { venue: input.venue } : {}), ...(input.notes ? { notes: input.notes } : {}) }; }

export async function readReviewFiles(catalog: Catalog): Promise<Review[]> {
  const { readdir } = await import("node:fs/promises"); try { const files = (await readdir(catalog.reviewsDir)).filter((file) => file.endsWith(".json")); return Promise.all(files.map(async (file) => (await import("./utils.js")).readJson<Review>(join(catalog.reviewsDir, file)))); } catch { return []; }
}
