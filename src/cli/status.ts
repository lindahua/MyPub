import { managedPath } from "../core/sync.js";
import type { StatusResult } from "../core/types.js";

const line = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function formatStatus(s: StatusResult, root: string): string {
  const lines = [`Library:   ${line(root)}`];
  const changes = s.changes ?? [];
  if (s.git) {
    lines.push(`Branch:    ${s.branch ? line(s.branch) : "detached HEAD"}${s.upstream ? ` → ${line(s.upstream)}` : " (no upstream)"}`);
    lines.push(`Local:     ${s.dirty ? changes.length ? `${count(changes.length, "uncommitted file")}` : "uncommitted changes" : "clean"}`);
    lines.push(`Commits:   ${s.upstream && s.ahead !== undefined && s.behind !== undefined ? `${s.ahead} to upload, ${s.behind} to download (last fetched)` : "remote comparison unavailable"}`);
  } else lines.push("Git:       not initialized");
  lines.push(`Last sync: ${s.last_successful_sync ? line(s.last_successful_sync) : "not recorded"}`);

  const issues: string[] = [];
  if (s.catalog === "missing") issues.push("catalog missing");
  if (s.needs_review) issues.push("synchronization conflicts");
  if (!s.lfs) issues.push("Git LFS not installed");
  if (issues.length) lines.push(`Attention: ${issues.join("; ")}`);

  if (s.git && s.dirty && changes.length) {
    lines.push("", "Uncommitted files:");
    for (const change of changes) {
      const kind = change.path.startsWith("catalog/publications/") ? "publication" : change.path.startsWith("catalog/reviews/") ? "review" : change.path.startsWith("catalog/gscholar/") ? "Scholar" : change.path.startsWith("catalog/authors/") ? "author" : change.path.startsWith("catalog/venues/") ? "venue" : change.path.startsWith("attachments/") ? "attachment" : managedPath(change.path) ? "config" : "other";
      lines.push(`  ${change.status.padEnd(10)} ${kind.padEnd(12)} ${line(change.label ?? change.path)}`);
    }
  }

  const next: string[] = [];
  if (s.catalog === "missing") next.push("select a valid library (--root PATH)");
  else if (!s.git) next.push("initialize Git for this library");
  else if (s.needs_review) next.push("mypub conflicts");
  else if (!s.branch) next.push("select a branch");
  else if (s.dirty) {
    if (changes.some(change => managedPath(change.path))) next.push("mypub commit");
    if (!changes.length || changes.some(change => !managedPath(change.path))) next.push("handle other files with Git or ignore them");
  } else if (!s.upstream) next.push("configure an upstream branch");
  else if (!s.lfs) next.push("install Git LFS");
  else if (s.pending_upload || s.behind) next.push("mypub sync");
  if (next.length) lines.push("", `Next: ${next.join("; ")}`);
  return lines.join("\n");
}
