import type { Publication } from "./types.js";

/** Normalize the backward-compatible scalar-or-array catalog representation. */
export function scholarEntryIds(publication: Publication): string[] {
  const value = publication.gscholar_entry_id;
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** Serialize no link as absent, one link as a scalar, and multiple links as an array. */
export function scholarLinkValue(ids: string[]): string | string[] | undefined {
  const unique = [...new Set(ids)];
  return unique.length === 0 ? undefined : unique.length === 1 ? unique[0] : unique;
}
