import { MyPubError } from "./errors.js";
/** CSV including quoted commas, escaped quotes and embedded newlines. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === '"') { if (quoted && input[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && c === ",") { row.push(field); field = ""; }
    else if (!quoted && (c === "\n" || c === "\r")) { if (c === "\r" && input[i + 1] === "\n") i++; row.push(field); if (row.some((x) => x !== "")) rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (quoted) throw new MyPubError("Unterminated CSV quote", "IMPORT_INVALID");
  row.push(field); if (row.some((x) => x !== "")) rows.push(row);
  const headers = rows.shift()?.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_")) ?? [];
  if (new Set(headers).size !== headers.length) throw new MyPubError("Duplicate CSV headers", "IMPORT_INVALID");
  return rows.map((r) => { if (r.length !== headers.length) throw new MyPubError("CSV row length differs from header", "IMPORT_INVALID"); return Object.fromEntries(headers.map((h, i) => [h, r[i]!])); });
}
