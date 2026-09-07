import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CatalogState, Publication, SearchFilters } from "../core/types.js";
import { fingerprint, normalizeText, uuid } from "../core/utils.js";
import { publicationDate, publicationYear } from "../core/paths.js";
import { resolveIdentity } from "../core/validation.js";
import { MyPubError } from "../core/errors.js";

export const DATABASE_VERSION = 1;
export const databasePath = (root: string): string => join(root, "local/index.sqlite");

/** Keep the final rule authoritative even when an existing file contains negations. */
export async function ensureLocalIgnored(root: string): Promise<void> {
  const path = join(root, ".gitignore");
  let previous = "";
  try { previous = await readFile(path, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (previous.trimEnd().split(/\r?\n/).at(-1) === "/local/") return;
  await writeFile(path, `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}/local/\n`);
}

const schema = `
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE records (path TEXT PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(kind,id));
CREATE INDEX records_kind ON records(kind);
CREATE TABLE authors (id TEXT PRIMARY KEY, author_key TEXT, preferred_name TEXT, resolved_id TEXT, archived_at TEXT, json TEXT NOT NULL);
CREATE INDEX authors_key ON authors(author_key);
CREATE TABLE venues (id TEXT PRIMARY KEY, venue_key TEXT, preferred_name TEXT, resolved_id TEXT, archived_at TEXT, json TEXT NOT NULL);
CREATE INDEX venues_key ON venues(venue_key);
CREATE TABLE publications (id TEXT PRIMARY KEY, citation_key TEXT, title TEXT, venue_id TEXT, venue TEXT, normalized_venue TEXT, year INTEGER, date TEXT, type TEXT, archived_at TEXT, gscholar_entry_id TEXT, citation_count INTEGER, search_text TEXT, json TEXT NOT NULL);
CREATE INDEX publication_key ON publications(citation_key);
CREATE INDEX publication_year ON publications(year,type);
CREATE INDEX publication_venue ON publications(venue_id);
CREATE INDEX publication_scholar ON publications(gscholar_entry_id);
CREATE TABLE authorship (publication_id TEXT, position INTEGER, author_id TEXT, original_author_id TEXT, name TEXT, roles TEXT, json TEXT NOT NULL, PRIMARY KEY(publication_id,position));
CREATE INDEX authorship_author ON authorship(author_id,publication_id);
CREATE TABLE identifiers (publication_id TEXT, provider TEXT, value TEXT, PRIMARY KEY(publication_id,provider));
CREATE INDEX identifier_lookup ON identifiers(provider,value);
CREATE TABLE tags (publication_id TEXT, position INTEGER, value TEXT, normalized_value TEXT, PRIMARY KEY(publication_id,position));
CREATE INDEX tag_lookup ON tags(normalized_value,publication_id);
CREATE TABLE relations (source_id TEXT, position INTEGER, target_id TEXT, type TEXT, note TEXT, PRIMARY KEY(source_id,position));
CREATE INDEX relation_target ON relations(target_id);
CREATE TABLE attachments (id TEXT PRIMARY KEY, publication_id TEXT, role TEXT, path TEXT, sha256 TEXT, size_bytes INTEGER, is_primary INTEGER, json TEXT NOT NULL);
CREATE INDEX attachment_publication ON attachments(publication_id);
CREATE TABLE gscholar_entries (id TEXT PRIMARY KEY, profile_id TEXT, scholar_id TEXT, title TEXT, year INTEGER, presence TEXT, matching_policy TEXT, citation_count INTEGER, json TEXT NOT NULL);
CREATE TABLE citation_observations (entry_id TEXT, position INTEGER, observed_at TEXT, count INTEGER, source_review_id TEXT, json TEXT NOT NULL, PRIMARY KEY(entry_id,position));
CREATE TABLE annual_citations (entry_id TEXT, position INTEGER, observed_at TEXT, year INTEGER, count INTEGER, source_review_id TEXT, PRIMARY KEY(entry_id,position,year));
CREATE TABLE scholar_captures (profile_id TEXT, position INTEGER, captured_at TEXT, coverage TEXT, source_review_id TEXT, json TEXT NOT NULL, PRIMARY KEY(profile_id,position));
CREATE TABLE reviews (id TEXT PRIMARY KEY, summary TEXT, kind TEXT, state TEXT, source_review_id TEXT, json TEXT NOT NULL);
CREATE INDEX review_state ON reviews(state);
CREATE TABLE proposals (review_id TEXT, id TEXT, entity_type TEXT, entity_id TEXT, operation TEXT, state TEXT, json TEXT NOT NULL, PRIMARY KEY(review_id,id));
CREATE INDEX proposal_target ON proposals(entity_type,entity_id,state);
CREATE TABLE review_targets (review_id TEXT, position INTEGER, entity_type TEXT, entity_id TEXT, PRIMARY KEY(review_id,position));
CREATE VIRTUAL TABLE publication_search USING fts5(id UNINDEXED,title,authors,venue,identifiers,tags);
CREATE VIEW author_bibliography AS SELECT a.author_id,a.position,a.name,a.roles,p.* FROM authorship a JOIN publications p ON p.id=a.publication_id;
CREATE VIEW venue_year_summary AS SELECT p.venue_id,COALESCE(v.preferred_name,p.venue) AS venue,p.year,p.type,COUNT(*) AS publication_count FROM publications p LEFT JOIN venues v ON v.id=p.venue_id WHERE p.archived_at IS NULL GROUP BY p.venue_id,COALESCE(v.preferred_name,p.venue),p.year,p.type;
CREATE VIEW review_queue AS SELECT * FROM reviews WHERE state IN ('pending','partially_accepted','deferred');
`;
const schemaFingerprint = fingerprint(schema);

export function currentDatabaseCount(path: string, source: string): number | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const metadata = Object.fromEntries(db.prepare("SELECT key,value FROM metadata").all().map(r => [r.key, r.value]));
    return metadata.version === String(DATABASE_VERSION) && metadata.schema === schemaFingerprint && metadata.source === source
      && db.prepare("PRAGMA quick_check").get()?.quick_check === "ok"
      && metadata.structure === fingerprint(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all())
      ? Number(metadata.publication_count) : undefined;
  } catch { return undefined; } finally { db?.close(); }
}

/** Caller holds the catalog write lock and supplies an already validated snapshot. */
export async function refreshDatabase(root: string, state: CatalogState, files: Map<string, unknown>, source: string, force = false): Promise<{ indexed: number; path: string }> {
  const path = databasePath(root);
  const temporary = join(root, "local", `index-${uuid()}.sqlite.tmp`);
  try {
    await ensureLocalIgnored(root);
    if (!force && currentDatabaseCount(path, source) !== undefined) return { indexed: state.publications.length, path };
    await mkdir(join(root, "local"), { recursive: true });
    const db = new DatabaseSync(temporary);
    try {
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN; ${schema}`);
      populate(db, state, files);
      const insert = db.prepare("INSERT INTO metadata VALUES (?,?)");
      for (const [key, value] of Object.entries({ version: String(DATABASE_VERSION), schema: schemaFingerprint, source, publication_count: String(state.publications.length), structure: fingerprint(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()), built_at: new Date().toISOString() })) insert.run(key, value);
      db.exec("COMMIT");
    } finally { db.close(); }
    // Each app reader closes its read-only connection under the same catalog lock.
    // A complete new file replaces even a corrupt cache without modifying the old snapshot.
    for (const suffix of ["-wal", "-shm", "-journal"]) await rm(`${path}${suffix}`, { force: true });
    await rename(temporary, path);
    return { indexed: state.publications.length, path };
  } catch (cause) {
    throw new MyPubError("Local database is stale or unavailable; canonical JSON is preserved. Retry the operation to rebuild it.", "CACHE_STALE", { cause: String(cause) });
  } finally {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) await rm(`${temporary}${suffix}`, { force: true }).catch(() => {});
  }
}

function populate(db: DatabaseSync, state: CatalogState, files: Map<string, unknown>): void {
  const record = db.prepare("INSERT INTO records VALUES (?,?,?,?)");
  for (const [path, value] of files) {
    const r = value as { id?: string; profile_id?: string };
    const kind = path === "catalog/library.json" ? "library" : path === "catalog/config/author.json" ? "owner" : path === "catalog/gscholar/profile.json" ? "gscholar_profile" : path.startsWith("catalog/gscholar/entries/") ? "gscholar_entries" : path.split("/")[1]!;
    record.run(path, kind, r.id ?? r.profile_id ?? kind, JSON.stringify(value));
  }
  const author = db.prepare("INSERT INTO authors VALUES (?,?,?,?,?,?)");
  for (const a of state.authors) author.run(a.id, a.author_key, a.preferred_name, resolveIdentity(state.authors, a.id)?.id ?? null, a.archived_at ?? null, JSON.stringify(a));
  const venue = db.prepare("INSERT INTO venues VALUES (?,?,?,?,?,?)");
  for (const v of state.venues) venue.run(v.id, v.venue_key, v.preferred_name, resolveIdentity(state.venues, v.id)?.id ?? null, v.archived_at ?? null, JSON.stringify(v));
  const pub = db.prepare("INSERT INTO publications VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const credit = db.prepare("INSERT INTO authorship VALUES (?,?,?,?,?,?,?)");
  const identifier = db.prepare("INSERT INTO identifiers VALUES (?,?,?)");
  const tag = db.prepare("INSERT INTO tags VALUES (?,?,?,?)");
  const relation = db.prepare("INSERT INTO relations VALUES (?,?,?,?,?)");
  const attachment = db.prepare("INSERT INTO attachments VALUES (?,?,?,?,?,?,?,?)");
  const search = db.prepare("INSERT INTO publication_search VALUES (?,?,?,?,?,?)");
  for (const p of state.publications) {
    const v = resolveIdentity(state.venues, p.venue?.venue_id ?? "");
    const names = p.authors.map(a => a.name);
    p.authors.forEach((a, i) => {
      const identity = resolveIdentity(state.authors, a.author_id ?? "");
      credit.run(p.id, i, identity?.id ?? null, a.author_id ?? null, a.name, JSON.stringify(a.roles ?? []), JSON.stringify(a));
      if (identity) names.push(identity.preferred_name, identity.author_key, ...identity.aliases);
    });
    const venues = [p.venue?.name, v?.preferred_name, v?.abbreviation, ...(v?.aliases ?? [])].filter(Boolean).join(" ");
    const text = normalizeText([p.title, p.citation_key, venues, ...p.authors.map(a => a.name), ...names.slice(p.authors.length), ...p.tags, ...Object.values(p.identifiers)].filter(Boolean).join(" "));
    pub.run(p.id, p.citation_key, p.title, v?.id ?? null, p.venue?.name ?? null, normalizeText(p.venue?.name ?? ""), publicationYear(p) ?? null, publicationDate(p) ?? null, p.type, p.archived_at ?? null, p.gscholar_entry_id ?? null, state.gscholar_entries.find(g => g.id === p.gscholar_entry_id)?.citation_history.at(-1)?.count ?? null, text, JSON.stringify(p));
    for (const [provider, value] of Object.entries(p.identifiers)) identifier.run(p.id, provider, value);
    p.tags.forEach((t, i) => tag.run(p.id, i, t, normalizeText(t)));
    p.relations.forEach((r, i) => relation.run(p.id, i, r.target_id, r.type, r.note ?? null));
    for (const a of p.attachments) attachment.run(a.id, p.id, a.role, a.path, a.sha256, a.size_bytes, Number(p.primary_attachment_id === a.id), JSON.stringify(a));
    search.run(p.id, p.title, names.join(" "), venues, Object.values(p.identifiers).join(" "), p.tags.join(" "));
  }
  const entry = db.prepare("INSERT INTO gscholar_entries VALUES (?,?,?,?,?,?,?,?,?)");
  const observation = db.prepare("INSERT INTO citation_observations VALUES (?,?,?,?,?,?)");
  const annual = db.prepare("INSERT INTO annual_citations VALUES (?,?,?,?,?,?)");
  for (const g of state.gscholar_entries) {
    entry.run(g.id, g.profile_id, g.scholar_id, g.title, g.year ?? null, g.presence, g.matching.policy, g.citation_history.at(-1)?.count ?? null, JSON.stringify(g));
    g.citation_history.forEach((s, i) => observation.run(g.id, i, s.observed_at, s.count, s.source_review_id, JSON.stringify(s)));
    g.annual_citations?.forEach((s, i) => { for (const [year, count] of Object.entries(s.counts)) annual.run(g.id, i, s.observed_at, Number(year), count, s.source_review_id); });
  }
  const capture = db.prepare("INSERT INTO scholar_captures VALUES (?,?,?,?,?,?)");
  state.gscholar_profile?.captures.forEach((c, i) => capture.run(state.gscholar_profile!.profile_id, i, c.captured_at, c.coverage, c.source_review_id, JSON.stringify(c)));
  const review = db.prepare("INSERT INTO reviews VALUES (?,?,?,?,?,?)");
  const proposal = db.prepare("INSERT INTO proposals VALUES (?,?,?,?,?,?,?)");
  const target = db.prepare("INSERT INTO review_targets VALUES (?,?,?,?)");
  for (const r of state.reviews) {
    review.run(r.id, r.summary, r.kind, r.state, r.source_review_id ?? null, JSON.stringify(r));
    for (const p of r.proposals) proposal.run(r.id, p.id, p.target.entity_type, p.target.entity_id ?? null, p.operation, p.state, JSON.stringify(p));
    r.targets.forEach((t, i) => target.run(r.id, i, t.entity_type, t.entity_id ?? null));
  }
}

export function readDatabaseState(db: DatabaseSync): CatalogState {
  const state: CatalogState = { library: undefined!, owner: { schema_version: 2 }, publications: [], authors: [], venues: [], gscholar_entries: [], reviews: [] };
  for (const row of db.prepare("SELECT kind,json FROM records ORDER BY path").all()) {
    const value = JSON.parse(row.json as string) as never;
    const kind = row.kind as keyof CatalogState;
    if (kind === "library" || kind === "owner" || kind === "gscholar_profile") state[kind] = value;
    else state[kind].push(value);
  }
  return state;
}

/** Preserve the CLI's literal, normalized substring search and exact role semantics. */
export function listDatabase(db: DatabaseSync, filters: SearchFilters): Publication[] {
  const where: string[] = []; const args: SQLInputValue[] = [];
  const add = (sql: string, ...values: SQLInputValue[]) => { where.push(sql); args.push(...values); };
  if (!filters.includeArchived) where.push("p.archived_at IS NULL");
  if (filters.type) add("p.type=?", filters.type);
  if (filters.year !== undefined) add("p.year=?", filters.year);
  if (filters.query) add("instr(p.search_text,?)>0", normalizeText(filters.query));
  if (filters.tag) add("EXISTS(SELECT 1 FROM tags t WHERE t.publication_id=p.id AND t.normalized_value=?)", normalizeText(filters.tag));
  if (filters.venue) {
    const venue = db.prepare("SELECT resolved_id FROM venues WHERE id=? OR venue_key=?").get(filters.venue, filters.venue);
    if (venue?.resolved_id) add("p.venue_id=?", venue.resolved_id);
    else add("p.normalized_venue=?", normalizeText(filters.venue));
  }
  if (filters.author || filters.role) {
    const conditions = ["a.publication_id=p.id"]; const values: SQLInputValue[] = [];
    if (filters.author) {
      const author = db.prepare("SELECT resolved_id FROM authors WHERE id=? OR author_key=?").get(filters.author, filters.author);
      if (!author) throw new MyPubError("Author not found", "NOT_FOUND");
      conditions.push("a.author_id=?"); values.push(author.resolved_id ?? null);
    }
    if (filters.role === "first_listed") conditions.push("a.position=0");
    else if (filters.role === "first") conditions.push("(a.position=0 OR EXISTS(SELECT 1 FROM json_each(a.roles) WHERE value='co_first'))");
    else if (filters.role) { conditions.push("EXISTS(SELECT 1 FROM json_each(a.roles) WHERE value=?)"); values.push(filters.role); }
    add(`EXISTS(SELECT 1 FROM authorship a WHERE ${conditions.join(" AND ")})`, ...values);
  }
  const rows = db.prepare(`SELECT p.json FROM publications p ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`).all(...args);
  // Retain existing locale-aware ordering rather than changing public CLI ordering to SQLite BINARY.
  return rows.map(r => JSON.parse(r.json as string) as Publication).sort((a, b) => (publicationDate(b) ?? "").localeCompare(publicationDate(a) ?? "") || a.title.localeCompare(b.title));
}
