import type { AddPublicationInput } from "../core/types.js";
import { normalizeArxiv, normalizeDoi } from "../core/utils.js";
import { MyPubError } from "../core/errors.js";

export async function lookupDoi(doiInput: string, capture?: (payload: unknown) => void): Promise<AddPublicationInput> {
  const doi = normalizeDoi(doiInput); const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { headers: { "User-Agent": "mypub/0.1 (mailto:local-user@example.invalid)" } });
  if (!response.ok) throw new MyPubError(`Crossref lookup failed (${response.status})`, "PROVIDER_FAILED");
  const body = await response.json() as { message?: Record<string, unknown> }; capture?.(body); const message = body.message ?? {}; const title = Array.isArray(message.title) ? String(message.title[0] ?? "") : ""; if (!title) throw new MyPubError("Crossref response has no title", "PROVIDER_INVALID");
  const abstract = typeof message.abstract === "string" ? message.abstract
    .replace(/<\/(?:jats:)?(?:p|title)>/gi, "\n\n").replace(/<[^>]*>/g, "")
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, code: string) => {
      const value = code[0]?.toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "�";
    }).replace(/&(lt|gt|quot|apos|amp);/g, (_, code: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[code]!).trim() : undefined;
  const authorValues = Array.isArray(message.author) ? message.author as Array<Record<string, unknown>> : []; const issued = message.issued as { [key: string]: unknown } | undefined; const parts = issued?.["date-parts"] as unknown[][] | undefined; const year = parts?.[0]?.[0]; const venue = Array.isArray(message["container-title"]) ? String((message["container-title"] as unknown[])[0] ?? "") : undefined;
  return { citation_key: citationKey(authorValues[0]?.family, year, title), type: String(message.type ?? "").includes("journal") ? "journal" : String(message.type ?? "").includes("proceedings") ? "conference" : "other", title, ...(abstract ? { abstract } : {}), authors: authorValues.map((author) => ({ name: [author.given, author.family].filter(Boolean).join(" "), ...(author.family || author.given ? { name_parts: { ...(author.family ? { family: String(author.family) } : {}), ...(author.given ? { given: String(author.given) } : {}) } } : {}) })), ...(venue ? { venue: { name: venue } } : {}), ...(year ? { publication_date: parts![0]!.map((part, i) => String(part).padStart(i === 0 ? 4 : 2, "0")).join("-") } : {}), identifiers: { doi }, ...(typeof message.URL === "string" && message.URL ? { official_url: message.URL } : {}), tags: [] };
}

/** Parse literal version snapshots; never reuse the latest byline for an older version. */
export function parseArxivVersions(xml: string): Array<{ id: string; version: number; submission_date: string; published: string; title: string; authors: string[]; abstract: string }> {
  const decode = (s: string): string => s.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, code: string) => String.fromCodePoint(code[0]?.toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code))).replace(/&(lt|gt|quot|apos|amp);/g, (_, code: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[code]!).replace(/\s+/g, " ").trim();
  return [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)].map(match => {
    const entry = match[1]!;
    const extract = (tag: string): string => decode(entry.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? "");
    const id = extract("id").split("/abs/").at(-1)!;
    const version = Number(id.match(/v(\d+)$/)?.[1]);
    const title = extract("title"), abstract = extract("summary"), published = extract("published").slice(0, 10), submission_date = extract("updated").slice(0, 10);
    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map(m => decode(m[1]!));
    if (!version || !title || !abstract || !/^\d{4}-\d{2}-\d{2}$/.test(published) || !/^\d{4}-\d{2}-\d{2}$/.test(submission_date)) throw new MyPubError("arXiv version metadata is incomplete", "PROVIDER_INVALID");
    return { id, version, title, authors, abstract, published, submission_date };
  });
}

export async function lookupArxiv(idInput: string, capture?: (payload: unknown) => void): Promise<AddPublicationInput> {
  const arxiv = normalizeArxiv(idInput), payloads: string[] = [];
  const request = async (ids: string[]): Promise<ReturnType<typeof parseArxivVersions>> => {
    const response = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(ids.join(","))}&max_results=1000`);
    if (!response.ok) throw new MyPubError(`arXiv lookup failed (${response.status})`, "PROVIDER_FAILED");
    const xml = await response.text(); payloads.push(xml); return parseArxivVersions(xml);
  };
  const latest = (await request([arxiv]))[0];
  if (!latest) throw new MyPubError("arXiv record not found", "NOT_FOUND");
  if (normalizeArxiv(latest.id) !== arxiv) throw new MyPubError("arXiv returned a different paper", "PROVIDER_INVALID");
  const versions = [latest];
  for (let start = 1; start < latest.version; start += 50) {
    await new Promise(resolve => setTimeout(resolve, 3100));
    versions.push(...await request(Array.from({ length: Math.min(50, latest.version - start) }, (_, i) => `${arxiv}v${start + i}`)));
  }
  versions.sort((a, b) => a.version - b.version);
  if (versions.length !== latest.version || versions[0]?.submission_date !== latest.published || versions.some((v, i) => v.version !== i + 1 || normalizeArxiv(v.id) !== arxiv || v.published !== latest.published)) throw new MyPubError("arXiv returned an incomplete or inconsistent version history", "PROVIDER_INVALID");
  capture?.({ responses: payloads });
  return { citation_key: `arxiv_${arxiv.replace(/[^a-z0-9]/g, "_")}`, type: "arxiv", title: latest.title, abstract: latest.abstract, authors: latest.authors.map(name => ({ name })), publication_date: versions[0]!.submission_date, submission_date: versions[0]!.submission_date, arxiv_versions: versions.map(({ version, title, authors, abstract, submission_date }) => ({ version, title, authors, abstract, submission_date })), identifiers: { arxiv }, venue: { name: "arXiv" }, official_url: `https://arxiv.org/abs/${arxiv}`, paper_url: `https://arxiv.org/pdf/${arxiv}`, tags: [] };
}
function citationKey(author: unknown, year: unknown, title: string): string { const first = title.toLowerCase().match(/[a-z0-9]+/)?.[0] ?? "paper"; return `${String(author ?? "anon").replace(/[^a-z0-9]/gi, "")}${String(year ?? "nd")}${first}`; }
