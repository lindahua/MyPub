/** Device preferences; no changes to catalog records or their schema. */
export interface PageSizes {
  max_pagesize_main: number;
  max_pagesize_dropdown: number;
}
export const DEFAULT_PAGE_SIZES: Readonly<PageSizes> = {
  max_pagesize_main: 30,
  max_pagesize_dropdown: 15,
};

export function paginate<T>(
  items: readonly T[],
  requestedPage: number,
  pageSize: number,
) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1)
    throw new Error("Page size must be a positive safe integer");
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(
    pages,
    Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1),
  );
  const start = (page - 1) * pageSize;
  return {
    page,
    pages,
    total: items.length,
    start,
    end: Math.min(start + pageSize, items.length),
    items: items.slice(start, start + pageSize),
  };
}
