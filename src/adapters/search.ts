import type { Catalog } from "../core/catalog.js";

/** Explicit repair command; ordinary catalog operations refresh automatically. */
export async function rebuildSearchIndex(catalog: Catalog): Promise<{ indexed: number; path: string }> {
  return catalog.rebuildIndex();
}
