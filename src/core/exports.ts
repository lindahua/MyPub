import { publicationDate } from "./paths.js";
import type { Publication } from "./types.js";

const bibEscape = (value: string): string => value.replace(/([{}])/g, "\\$1");
export function toBibtex(publications: Publication[]): string {
  return publications.map((publication) => {
    const kind = publication.type === "journal" ? "article" : publication.type === "conference" || publication.type === "workshop" ? "inproceedings" : publication.type === "thesis" ? "phdthesis" : "misc";
    const fields: Array<[string, string | undefined]> = [["title", publication.title], ["abstract", publication.abstract], ["author", publication.authors.map((author) => author.name).join(" and ")], [publication.type === "journal" ? "journal" : "booktitle", publication.venue?.name], ["year", publicationDate(publication)?.slice(0, 4)], ["volume", publication.volume], ["number", publication.issue], ["pages", publication.pages], ["doi", publication.identifiers.doi], ["eprint", publication.identifiers.arxiv], ["url", publication.urls[0]], ["keywords", publication.tags.join(", ")]];
    return `@${kind}{${publication.citation_key},\n${fields.filter(([, value]) => value).map(([key, value]) => `  ${key} = {${bibEscape(value!)}},`).join("\n")}\n}`;
  }).join("\n\n") + (publications.length ? "\n" : "");
}
const csv = (value: string): string => /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
export function toCsv(publications: Publication[]): string { const rows = [["citation_key", "type", "title", "authors", "venue", "year", "doi", "arxiv", "tags", "abstract"], ...publications.map((publication) => [publication.citation_key, publication.type, publication.title, publication.authors.map((author) => author.name).join("; "), publication.venue?.name ?? "", publicationDate(publication)?.slice(0, 4) ?? "", publication.identifiers.doi ?? "", publication.identifiers.arxiv ?? "", publication.tags.join("; "), publication.abstract ?? ""])]; return `${rows.map((row) => row.map(csv).join(",")).join("\n")}\n`; }
