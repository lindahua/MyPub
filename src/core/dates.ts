import type { Publication } from "./types.js";

/** Shared by SQLite indexing, exports and the desktop viewer. */
export function publicationDate(p: Publication): string | undefined {
  return p.publication_date ?? p.issued_date ?? p.online_date ?? (p.type === "arxiv" ? p.submission_date : undefined);
}
export function publicationYear(p: Publication): number | undefined {
  const date = publicationDate(p);
  return date ? Number(date.slice(0, 4)) : undefined;
}
