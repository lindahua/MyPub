import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Catalog } from "../core/catalog.js";

export async function rebuildSearchIndex(catalog: Catalog): Promise<{ indexed: number; path: string }> {
  const path = join(catalog.localDir, "index.sqlite"); await mkdir(dirname(path), { recursive: true }); const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS publications (id TEXT PRIMARY KEY, citation_key TEXT NOT NULL, title TEXT NOT NULL, authors TEXT NOT NULL, venue TEXT, identifiers TEXT NOT NULL, tags TEXT NOT NULL, year INTEGER, type TEXT NOT NULL, status TEXT NOT NULL); DELETE FROM publications;");
    const insert = database.prepare("INSERT INTO publications (id,citation_key,title,authors,venue,identifiers,tags,year,type,status) VALUES (?,?,?,?,?,?,?,?,?,?)");
    const records = await catalog.list({ includeArchived: true }); database.exec("BEGIN");
    try { for (const item of records) insert.run(item.id, item.citation_key, item.title, item.authors.map((author) => author.name).join("\n"), item.venue ?? null, Object.values(item.identifiers).filter(Boolean).join("\n"), item.tags.join("\n"), Number((item.dates.issued ?? item.dates.online ?? "").slice(0, 4)) || null, item.type, item.status); database.exec("COMMIT"); } catch (error) { database.exec("ROLLBACK"); throw error; }
    return { indexed: records.length, path };
  } finally { database.close(); }
}
