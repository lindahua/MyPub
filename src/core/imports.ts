import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { AddPublicationInput, Author, Coverage, ImportResult, Publication, PublicationType, Review, Proposal } from "./types.js";
import { Catalog, publicationFromInput } from "./catalog.js";
import { fingerprint, normalizeArxiv, normalizeDoi, normalizeText, now, uuid } from "./utils.js";
import { MyPubError } from "./errors.js";
import { parseCsv as parseCSV } from "./csv.js";
import { importNative } from "./native.js";

type Imported = AddPublicationInput & { raw?: unknown };
function authors(value = ""): Author[] { return value.split(/\s+and\s+|\s*;\s*/i).map(name => name.trim()).filter(Boolean).map(name => ({ name })); }
function type(value = ""): PublicationType { const v = value.toLowerCase(); if (v.includes("article") || v.includes("journal")) return "journal"; if (v.includes("conference") || v.includes("inproceedings")) return "conference"; if (v.includes("workshop")) return "workshop"; if (v.includes("thesis")) return "thesis"; if (v.includes("arxiv") || v.includes("preprint")) return "preprint"; return "other"; }
function parseCsv(contents: string): Imported[] {
  return parseCSV(contents).map((row, i) => {
    const title = row.title?.trim(); if (!title) throw new MyPubError(`CSV row ${i + 2} has no title`, "IMPORT_INVALID");
    const date = row.publication_date || row.year || row.publication_year;
    const venue = row.venue || row.journal || row.booktitle;
    return { citation_key: row.citation_key || row.key || `import-${fingerprint(row).slice(0, 12)}`, title, type: type(row.type), authors: authors(row.authors || row.author),
      ...(row.abstract?.trim() ? { abstract: row.abstract } : {}), ...(date ? { publication_date: date } : {}), ...(venue ? { venue: { name: venue } } : {}),
      identifiers: { ...(row.doi ? { doi: normalizeDoi(row.doi) } : {}), ...(row.arxiv ? { arxiv: normalizeArxiv(row.arxiv) } : {}) },
      ...(row.official_url ? { official_url: row.official_url } : {}), ...(row.paper_url ? { paper_url: row.paper_url } : {}), ...(row.extra_urls !== undefined ? { extra_urls: row.extra_urls.split(/\s+/).filter(Boolean) } : row.url ? { extra_urls: [row.url] } : {}), ...(row.tags ? { tags: row.tags.split(/[;,]/).map(x => x.trim()).filter(Boolean) } : {}), raw: row };
  });
}
function parseBibtex(contents: string): Imported[] {
  const records: Imported[] = []; const entry = /@(\w+)\s*\{\s*([^,]+),([\s\S]*?)(?=\n\s*@\w+\s*\{|\s*$)/g;
  for (const match of contents.matchAll(entry)) {
    const fields: Record<string, string> = {}; const body = match[3]!.replace(/\}\s*$/, "");
    const fieldPattern = /(\w[\w-]*)\s*=\s*(?:\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)"|([^,\n]+))\s*,?/g;
    for (const field of body.matchAll(fieldPattern)) fields[field[1]!.toLowerCase()] = (field[2] ?? field[3] ?? field[4] ?? "").trim();
    if (!fields.title) continue;
    records.push({ citation_key: match[2]!.trim(), type: type(match[1]), title: fields.title.replace(/[{}]/g, ""), authors: authors(fields.author), ...(fields.abstract ? { abstract: fields.abstract } : {}), ...(fields.journal || fields.booktitle ? { venue: { name: fields.journal ?? fields.booktitle! } } : {}), ...(fields.year ? { publication_date: fields.year } : {}), ...(fields.doi || fields.eprint ? { identifiers: { ...(fields.doi ? { doi: normalizeDoi(fields.doi) } : {}), ...(fields.eprint ? { arxiv: normalizeArxiv(fields.eprint) } : {}) } } : {}), ...(fields.official_url ? { official_url: fields.official_url } : {}), ...(fields.paper_url ? { paper_url: fields.paper_url } : {}), ...(fields.extra_urls !== undefined ? { extra_urls: fields.extra_urls.split(/\s+/).filter(Boolean) } : fields.url && fields.url !== fields.official_url ? { extra_urls: [fields.url] } : {}), ...(fields.keywords ? { tags: fields.keywords.split(/[,;]/).map((tag) => tag.trim()).filter(Boolean) } : {}), raw: fields });
  }
  if (!records.length) throw new MyPubError("No BibTeX entries found", "IMPORT_INVALID");
  return records;
}

function fromJson(value: unknown): Imported[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map(item => {
    if (!item || typeof item !== "object" || typeof item.title !== "string" || !Array.isArray(item.authors)) throw new MyPubError("JSON entry requires title and authors", "IMPORT_INVALID");
    if (item.schema_version !== undefined && item.schema_version !== 2) throw new MyPubError("Only version 2 is supported", "UNSUPPORTED_SCHEMA");
    const { schema_version, created_at, updated_at, ...input } = item;
    return input as Imported;
  });
}
function proposalsFor(current: Publication, incoming: Imported, completeness: Coverage): Proposal[] {
  const proposals: Proposal[] = [];
  const fields = ["title", "abstract", "official_url", "paper_url", "authors", "venue", "publication_date", "submission_date", "acceptance_date", "online_date", "issued_date", "identifiers", "arxiv_versions", "extra_urls", "tags", "type", "volume", "issue", "pages"] as const;
  for (const field of fields) {
    let proposed: unknown = incoming[field]; if (proposed === undefined) continue;
    if (field === "authors") {
      // Source spelling alone cannot move a confirmed identity to another credit.
      if (incoming.type === "preprint" && incoming.arxiv_versions?.length && completeness === "complete") {
        const used = new Set<string>();
        proposed = incoming.authors.map(a => {
          const matches = current.authors.filter(old => normalizeText(old.name) === normalizeText(a.name));
          const credit = { ...(matches.length === 1 ? matches[0] : {}), ...a };
          if (credit.author_id) { if (used.has(credit.author_id)) delete credit.author_id; else used.add(credit.author_id); }
          return credit;
        });
        if (fingerprint(current.authors) !== fingerprint(proposed)) proposals.push({ id: uuid(), target: { entity_type: "publication", entity_id: current.id }, operation: "replace", path: "/authors", expected_revision: fingerprint(current), current: current.authors, proposed, state: "pending" });
        continue;
      }
      if (completeness !== "complete" || incoming.authors.length < current.authors.length) continue;
      if (current.authors.some(a => a.author_id || a.roles?.length) && fingerprint(current.authors.map(a => a.name)) !== fingerprint(incoming.authors.map(a => a.name))) continue;
      proposed = incoming.authors.map((a, i) => ({ ...current.authors[i], ...a }));
    }
    if (field === "identifiers") proposed = { ...current.identifiers, ...incoming.identifiers };
    if (field === "venue" && current.venue?.venue_id) proposed = { ...current.venue, ...incoming.venue };
    if (fingerprint(current[field]) === fingerprint(proposed)) continue;
    proposals.push({ id: uuid(), target: { entity_type: "publication", entity_id: current.id }, operation: "replace", path: `/${field}`, expected_revision: fingerprint(current), ...(current[field] !== undefined ? { current: current[field] } : {}), proposed, state: "pending" });
  }
  return proposals;
}
export async function stageImport(c: Catalog, inputs: Imported[], provider: string, payload: unknown, completeness: Coverage = "complete", sourceReference?: string): Promise<ImportResult> {
  const inputFingerprint = fingerprint({ provider, payload, completeness });
  return c.change(s => {
    const repeated = s.reviews.find(r => r.evidence?.input_fingerprint === inputFingerprint);
    if (repeated) return { source_review_id: repeated.id, review_ids: [repeated.id], created: 0, matched: 0, duplicates: inputs.length };
    const time = now(); let created = 0; let matched = 0;
    const r: Review = { schema_version: 2, id: uuid(), summary: `Import ${inputs.length} publication records from ${provider}`, kind: "import", state: "pending", targets: [], proposals: [], evidence: { provider, captured_at: time, ...(sourceReference ? { source_reference: sourceReference } : {}), payload, completeness, parser_version: "mypub/2", input_fingerprint: inputFingerprint }, created_at: time, updated_at: time };
    for (const input of inputs) {
      const { raw, ...fields } = input; const proposed = publicationFromInput(fields);
      const exact = fields.id ? s.publications.find(p => p.id === fields.id) : undefined;
      const candidates = exact ? [exact] : s.publications.filter(p => (proposed.type !== "preprint" || p.type === "preprint") && ((proposed.identifiers.doi && p.identifiers.doi === proposed.identifiers.doi) || (proposed.identifiers.arxiv && p.identifiers.arxiv === proposed.identifiers.arxiv) || (normalizeText(p.title) === normalizeText(proposed.title) && p.authors.some(a => proposed.authors.some(b => normalizeText(a.name) === normalizeText(b.name))))));
      if (candidates.length === 1) { const p = candidates[0]!; r.targets.push({ entity_type: "publication", entity_id: p.id }); r.proposals.push(...proposalsFor(p, input, completeness)); matched++; }
      else { r.targets.push({ entity_type: "publication", entity_id: proposed.id }); r.proposals.push({ id: uuid(), target: { entity_type: "publication", entity_id: proposed.id }, operation: "create", proposed, ...(candidates.length ? { candidate_ids: candidates.map(p => p.id) } : {}), state: "pending" }); created++; }
    }
    r.targets = r.targets.filter((t, i, arr) => arr.findIndex(x => fingerprint(x) === fingerprint(t)) === i);
    s.reviews.push(r); return { source_review_id: r.id, review_ids: [r.id], created, matched, duplicates: 0 };
  });
}
export async function importFile(c: Catalog, path: string, provider?: string, completeness: Coverage = "complete"): Promise<ImportResult> {
  const text = await readFile(path, "utf8"); const extension = extname(path).toLowerCase();
  const value: unknown = extension === ".csv" || extension === ".bib" || extension === ".bibtex" ? undefined : JSON.parse(text);
  if (value && typeof value === "object" && "format" in value) return importNative(c, value);
  const inputs = extension === ".csv" ? parseCsv(text) : extension === ".bib" || extension === ".bibtex" ? parseBibtex(text) : fromJson(value);
  return stageImport(c, inputs, provider ?? extension.slice(1), text, completeness, basename(path));
}
export async function readReviewFiles(c: Catalog): Promise<Review[]> { return (await c.read()).reviews; }
