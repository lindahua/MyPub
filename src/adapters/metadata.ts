import type { AddPublicationInput } from "../core/types.js";
import { normalizeArxiv, normalizeDoi } from "../core/utils.js";
import { MyPubError } from "../core/errors.js";

export async function lookupDoi(doiInput: string): Promise<AddPublicationInput> {
  const doi = normalizeDoi(doiInput); const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { headers: { "User-Agent": "mypub/0.1 (mailto:local-user@example.invalid)" } });
  if (!response.ok) throw new MyPubError(`Crossref lookup failed (${response.status})`, "PROVIDER_FAILED");
  const body = await response.json() as { message?: Record<string, unknown> }; const message = body.message ?? {}; const title = Array.isArray(message.title) ? String(message.title[0] ?? "") : ""; if (!title) throw new MyPubError("Crossref response has no title", "PROVIDER_INVALID");
  const authorValues = Array.isArray(message.author) ? message.author as Array<Record<string, unknown>> : []; const issued = message.issued as { [key: string]: unknown } | undefined; const parts = issued?.["date-parts"] as unknown[][] | undefined; const year = parts?.[0]?.[0]; const venue = Array.isArray(message["container-title"]) ? String((message["container-title"] as unknown[])[0] ?? "") : undefined;
  return { citation_key: citationKey(authorValues[0]?.family, year, title), type: String(message.type ?? "").includes("journal") ? "journal" : String(message.type ?? "").includes("proceedings") ? "conference" : "other", status: "published", title, authors: authorValues.map((author) => ({ name: [author.given, author.family].filter(Boolean).join(" "), ...(author.ORCID ? { orcid: String(author.ORCID) } : {}) })), ...(venue ? { venue } : {}), dates: year ? { issued: String(year) } : {}, identifiers: { doi }, urls: message.URL ? [String(message.URL)] : [], tags: [] };
}

export async function lookupArxiv(idInput: string): Promise<AddPublicationInput> {
  const arxiv = normalizeArxiv(idInput); const response = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxiv)}`); if (!response.ok) throw new MyPubError(`arXiv lookup failed (${response.status})`, "PROVIDER_FAILED"); const xml = await response.text();
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1]; if (!entry) throw new MyPubError("arXiv record not found", "NOT_FOUND"); const extract = (tag: string): string | undefined => entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.replace(/\s+/g, " ").trim(); const title = extract("title"); if (!title) throw new MyPubError("arXiv response has no title", "PROVIDER_INVALID"); const authorNames = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((match) => ({ name: match[1]!.replace(/\s+/g, " ").trim() })); const published = extract("published")?.slice(0, 10); const doi = extract("arxiv:doi");
  return { citation_key: citationKey(authorNames[0]?.name.split(/\s+/).at(-1), published?.slice(0, 4), title), type: "arxiv", status: "submitted", title, authors: authorNames, dates: published ? { submitted: published } : {}, identifiers: { arxiv, ...(doi ? { doi: normalizeDoi(doi) } : {}) }, urls: [`https://arxiv.org/abs/${arxiv}`], tags: [] };
}
function citationKey(author: unknown, year: unknown, title: string): string { const first = title.toLowerCase().match(/[a-z0-9]+/)?.[0] ?? "paper"; return `${String(author ?? "anon").replace(/[^a-z0-9]/gi, "")}${String(year ?? "nd")}${first}`; }
