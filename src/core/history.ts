import { Catalog } from "./catalog.js";
import type { HistoryEvent } from "./types.js";
import { run } from "../adapters/process.js";
import { validUuid } from "./schemas.js";
import { MyPubError } from "./errors.js";

/** Attribution is read from each commit object, never the current Git config. */
export async function history(c: Catalog, id?: string): Promise<HistoryEvent[]> {
  if (id && !validUuid(id)) throw new MyPubError("History requires a record UUID", "SCHEMA_INVALID");
  const log = await run("git", ["log", "--format=%H", "--", "catalog"], c.root, true); if (log.code !== 0) return [];
  const events: HistoryEvent[] = [];
  for (const commit of log.stdout.trim().split("\n").filter(Boolean)) {
    const fields = (await run("git", ["show", "-s", "--format=%H%x00%P%x00%cn%x00%ce%x00%cI%x00%an%x00%ae%x00%s", commit], c.root)).stdout.trimEnd().split("\0");
    const parents = fields[1]!.split(" ").filter(Boolean);
    const paths = [...new Set((await run("git", ["diff-tree", "--root", "-m", "--no-commit-id", "--name-only", "-r", "-z", commit, "--", "catalog"], c.root)).stdout.split("\0").filter(Boolean))];
    const matching: string[] = [];
    for (const path of paths) {
      if (!id) { matching.push(path); continue; }
      for (const rev of [commit, ...parents]) { const shown = await run("git", ["show", `${rev}:${path}`], c.root, true); if (shown.code === 0) { try { if ((JSON.parse(shown.stdout) as { id?: string }).id === id) { matching.push(path); break; } } catch { /* Non-record historical file. */ } } }
    }
    if (matching.length) events.push({ commit, parents, committer: { name: fields[2]!, email: fields[3]!, time: fields[4]! }, author: { name: fields[5]!, email: fields[6]! }, subject: fields[7] ?? "", paths: matching });
  }
  return events;
}
