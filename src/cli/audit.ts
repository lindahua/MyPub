import type { AuditResult } from "../core/audit.js";
const line = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
export function formatAudit(r: AuditResult, details = false): string {
  const lines = [`Publications:    ${r.statistics.publications}`, `Scholar entries: ${r.statistics.scholar_entries}`, `Links:           ${r.statistics.links}`, `Errors:          ${r.errors}`, `Warnings:        ${r.warnings}`];
  if (!r.complete) lines.push("Audit incomplete: some sources could not be read reliably.");
  if (!r.counts_complete) lines.push("Counts are partial: invalid or ambiguous records were excluded from dependent statistics.");
  if (r.skipped.length) lines.push(`Skipped checks:  ${r.skipped.length}`);
  for (const f of r.findings) {
    lines.push("", `${f.severity.toUpperCase()} ${f.code}`, `  ${line(f.message)}`, ...f.paths.map(p => `  ${line(p)}`));
    if (details) { if (f.field) lines.push(`  Field: ${line(f.field)}`); if (f.record_ids.length) lines.push(`  IDs: ${f.record_ids.join(", ")}`); if (f.values !== undefined) lines.push(`  Values: ${JSON.stringify(f.values)}`); }
  }
  if (details) { lines.push("", "Coverage:", JSON.stringify(r.statistics, null, 2), "Type pairs:", JSON.stringify(r.cross_tab, null, 2), "Skipped checks:", JSON.stringify(r.skipped, null, 2)); }
  return lines.join("\n");
}
