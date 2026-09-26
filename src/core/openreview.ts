/** OpenReview forum IDs are case-sensitive and are not DOI or ISBN values. */
export function openReviewForumId(urlValue: string | undefined): string | undefined {
  if (!urlValue) return undefined;
  let url: URL;
  try { url = new URL(urlValue); } catch { return undefined; }
  if (url.hostname.toLowerCase() !== "openreview.net" || url.pathname !== "/forum") return undefined;
  const id = url.searchParams.get("id");
  return id && /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined;
}
