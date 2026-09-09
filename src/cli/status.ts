import { managedPath } from "../core/sync.js";
import type { StatusResult } from "../core/types.js";

const line = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const pad = (value: number): string => String(value).padStart(2, "0");
function localTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return line(value);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
  const offsetMinutes = pad(Math.abs(offset) % 60);
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} UTC${sign}${offsetHours}:${offsetMinutes}`;
  return `${local} [${line(value)}]`;
}

export function formatStatus(s: StatusResult, root: string, details = false, color = false): string {
  // Use the terminal theme’s ANSI palette rather than fixed RGB colors.
  const emphasize = (text: string, tone = 35): string => color ? `\x1b[1;${tone}m${text}\x1b[0m` : text;
  const lines = [`Library:   ${line(root)}`];
  const changes = s.changes ?? [];
  if (s.git) {
    lines.push(`Branch:    ${s.branch ? line(s.branch) : emphasize("detached HEAD")}${s.upstream ? ` → ${line(s.upstream)}` : emphasize(" (no upstream)")}`);
    lines.push(`Commit:    ${s.commit ? line(s.commit) : "no commits"}`);
    lines.push(`Local:     ${s.dirty ? emphasize(changes.length ? count(changes.length, "uncommitted file") : "uncommitted changes") : "clean"}`);
    const commits = (n: number, direction: string): string => n > 0 ? emphasize(`${n} to ${direction}`) : `${n} to ${direction}`;
    lines.push(`Commits:   ${s.upstream && s.ahead !== undefined && s.behind !== undefined ? `${commits(s.ahead, "upload")}, ${commits(s.behind, "download")} (last fetched)` : emphasize("remote comparison unavailable")}`);
  } else lines.push(`Git:       ${emphasize("not initialized")}`);
  lines.push(`Last sync: ${s.last_successful_sync ? localTimestamp(s.last_successful_sync) : "not recorded"}`);

  const issues: string[] = [];
  if (s.catalog === "missing") issues.push("catalog missing");
  if (s.needs_review) issues.push("synchronization conflicts");
  if (!s.lfs) issues.push("Git LFS not installed");
  if (issues.length) lines.push(emphasize(`Attention: ${issues.join("; ")}`, 31));

  if (details && s.git && s.dirty && changes.length) {
    lines.push("", "Uncommitted files:");
    for (const change of changes) {
      const kind = change.path.startsWith("catalog/publications/") ? "publication" : change.path.startsWith("catalog/reviews/") ? "review" : change.path.startsWith("catalog/gscholar/") ? "Scholar" : change.path.startsWith("catalog/authors/") ? "author" : change.path.startsWith("catalog/venues/") ? "venue" : change.path.startsWith("attachments/") ? "attachment" : managedPath(change.path) ? "config" : "other";
      lines.push(`  ${emphasize(change.status.padEnd(10), change.status === "conflicted" ? 31 : 35)} ${kind.padEnd(12)} ${line(change.label ?? change.path)}`);
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
  if (next.length) lines.push("", emphasize(`Next: ${next.join("; ")}`, 34));
  return lines.join("\n");
}
