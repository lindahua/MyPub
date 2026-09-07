import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Catalog, currentCitations } from "../core/catalog.js";
import { publicationYear } from "../core/paths.js";
import { resolveIdentity } from "../core/validation.js";
import { withLock } from "../core/utils.js";

export async function rebuildSearchIndex(catalog: Catalog): Promise<{ indexed: number; path: string }> {
  const state = await catalog.read(); const path = join(catalog.localDir, "index.sqlite"); await mkdir(dirname(path), { recursive: true });
  return withLock(join(catalog.localDir, "index.lock"), async () => {
    const db = new DatabaseSync(path);
    try {
      db.exec("BEGIN; DROP TABLE IF EXISTS publications; DROP TABLE IF EXISTS authorship; DROP TABLE IF EXISTS publication_search; CREATE TABLE publications (id TEXT PRIMARY KEY, citation_key TEXT, title TEXT, venue_id TEXT, venue TEXT, year INTEGER, type TEXT, archived_at TEXT, citation_count INTEGER); CREATE TABLE authorship (publication_id TEXT, position INTEGER, author_id TEXT, name TEXT, roles TEXT, PRIMARY KEY(publication_id,position)); CREATE VIRTUAL TABLE publication_search USING fts5(id UNINDEXED,title,authors,venue,identifiers,tags);");
      const pub = db.prepare("INSERT INTO publications VALUES (?,?,?,?,?,?,?,?,?)"); const credit = db.prepare("INSERT INTO authorship VALUES (?,?,?,?,?)"); const search = db.prepare("INSERT INTO publication_search VALUES (?,?,?,?,?,?)");
      for (const p of state.publications) {
        const v = resolveIdentity(state.venues, p.venue?.venue_id ?? ""); const names: string[] = [];
        p.authors.forEach((a, i) => { const identity = resolveIdentity(state.authors, a.author_id ?? ""); credit.run(p.id, i, identity?.id ?? null, a.name, JSON.stringify(a.roles ?? [])); names.push(a.name, ...(identity ? [identity.preferred_name, identity.author_key, ...identity.aliases] : [])); });
        pub.run(p.id, p.citation_key, p.title, v?.id ?? null, p.venue?.name ?? null, publicationYear(p) ?? null, p.type, p.archived_at ?? null, currentCitations(state, p));
        search.run(p.id, p.title, names.join("\n"), [p.venue?.name, v?.preferred_name, v?.abbreviation, ...(v?.aliases ?? [])].filter(Boolean).join("\n"), Object.values(p.identifiers).join("\n"), p.tags.join("\n"));
      }
      db.exec("COMMIT"); return { indexed: state.publications.length, path };
    } catch (e) { db.exec("ROLLBACK"); throw e; } finally { db.close(); }
  });
}
