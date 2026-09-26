import type { Publication } from "./types.js";
import { normalizeDoi } from "./utils.js";

/** DOI encoded by a trusted official landing-page URL, if one is present. */
export function officialUrlDoi(publication: Pick<Publication, "type" | "official_url" | "identifiers">): string | undefined {
  if (!publication.official_url) return undefined;
  let url: URL;
  try { url = new URL(publication.official_url); } catch { return undefined; }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { return undefined; }
  if (publication.type === "preprint" && host === "arxiv.org") {
    const match = pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?(?:v\d+)?$/i);
    const arxiv = match?.[1]?.replace(/v\d+$/i, "");
    if (arxiv && (!publication.identifiers.arxiv || arxiv.toLowerCase() === publication.identifiers.arxiv.toLowerCase()))
      return normalizeDoi(`10.48550/arxiv.${arxiv}`);
  }
  const prefix = host === "doi.org" || host === "dx.doi.org" ? /^\/(10\.\d{4,9}\/[^?#]+)$/i
    : host === "dl.acm.org" || host === "epubs.siam.org" || host === "pubs.acs.org" ? /^\/doi\/(?:abs\/|full\/|pdf\/)?(10\.\d{4,9}\/[^?#]+)$/i
    : host === "link.springer.com" ? /^\/(?:article|chapter)\/(10\.\d{4,9}\/[^?#]+)$/i
    : undefined;
  const value = prefix && pathname.match(prefix)?.[1];
  return value ? normalizeDoi(value.replace(/\/$/, "")) : undefined;
}
