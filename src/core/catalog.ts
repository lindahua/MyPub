import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { AddPublicationInput, Attachment, AttachmentRole, AuthorCredit, AuthorIdentity, CatalogOptions, CatalogState, EntityRecord, Library, Publication, PublicationDetails, RelationType, Review, SearchFilters, ValidationResult, VenueIdentity } from "./types.js";
import { assertRecord } from "./schemas.js";
import { fileExists, fingerprint, normalizeArxiv, normalizeDoi, normalizeText, now, safePath, sha256, uuid, withLock } from "./utils.js";
import { catalogFiles, publicationDate, publicationYear } from "./paths.js";
import { loadState, pendingTransaction, recoverTransactions, writeState } from "./storage.js";
import { assertUnchangedEvidence, auditState, resolveIdentity, validateState } from "./validation.js";
import { MyPubError } from "./errors.js";

export const clean = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const touch = (record: { updated_at: string }): void => { record.updated_at = new Date(Math.ceil(Math.max(Date.parse(record.updated_at), Date.parse(now())) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"); };
export function publicationFromInput(input: AddPublicationInput): Publication {
  for (const key of ["status", "dates", "schema_version", "created_at", "updated_at"]) if (Object.hasOwn(input, key)) throw new MyPubError(`Unsupported add field: ${key}`, "SCHEMA_INVALID");
  const time = now(); const value = clean({ urls: [], tags: [], relations: [], attachments: [], identifiers: {}, ...input, schema_version: 2, id: input.id ?? uuid(), created_at: time, updated_at: time }) as Publication;
  if (value.identifiers?.doi) value.identifiers.doi = normalizeDoi(value.identifiers.doi);
  if (value.identifiers?.arxiv) value.identifiers.arxiv = normalizeArxiv(value.identifiers.arxiv);
  if (value.identifiers?.isbn) value.identifiers.isbn = value.identifiers.isbn.replace(/[- ]/g, "").toUpperCase();
  assertRecord("publication", value); return value;
}
export function findPublication(s: CatalogState, ref: string): Publication {
  const exact = s.publications.find((p) => p.id === ref || p.citation_key === ref); if (exact) return exact;
  const matches = s.publications.filter((p) => p.identifiers.doi === normalizeDoi(ref) || p.identifiers.arxiv === normalizeArxiv(ref));
  if (!matches.length) throw new MyPubError(`Publication not found: ${ref}`, "NOT_FOUND");
  if (matches.length > 1) throw new MyPubError(`Publication reference is ambiguous: ${ref}`, "AMBIGUOUS", matches.map((p) => p.id));
  return matches[0]!;
}
export function pairRejected(s: CatalogState, publicationId: string, entryId: string): boolean {
  return s.reviews.some((r) => r.proposals.some((p) => p.state === "rejected" && ["link", "replace"].includes(p.operation) && p.path === "/gscholar_entry_id" && p.target.entity_id === publicationId && p.proposed === entryId));
}
export function currentCitations(s: CatalogState, publication: Publication): number | null { const g = s.gscholar_entries.find((g) => g.id === publication.gscholar_entry_id); return g?.citation_history.at(-1)?.count ?? null; }
export function manualReview(summary: string, targets: Review["targets"], proposals: Review["proposals"] = []): Review {
  const time = now(); return { schema_version: 2, id: uuid(), summary, kind: "change", state: "accepted", targets, proposals, created_at: time, updated_at: time, decided_at: time };
}

export class Catalog {
  readonly root: string; readonly catalogDir: string; readonly publicationsDir: string; readonly authorsDir: string; readonly venuesDir: string;
  readonly reviewsDir: string; readonly localDir: string; readonly attachmentsDir: string;
  constructor(options: CatalogOptions) { this.root = resolve(options.root); this.catalogDir = join(this.root, "catalog"); this.publicationsDir = join(this.catalogDir, "publications"); this.authorsDir = join(this.catalogDir, "authors"); this.venuesDir = join(this.catalogDir, "venues"); this.reviewsDir = join(this.catalogDir, "reviews"); this.localDir = join(this.root, "local"); this.attachmentsDir = join(this.root, "attachments"); }
  async initialize(name = "My Publications"): Promise<Library> {
    return withLock(join(this.localDir, "write.lock"), async () => {
      await recoverTransactions(this.root);
      if (await fileExists(join(this.catalogDir, "library.json"))) return (await loadState(this.root)).state.library;
      // An existing catalog tree without a library must not be overwritten.
      const { jsonFiles } = await import("./paths.js"); if ((await jsonFiles(this.catalogDir)).length) throw new MyPubError("Catalog directory contains records without a library", "CATALOG_EXISTS");
      const time = now(); const s: CatalogState = { library: { schema_version: 2, id: uuid(), name, created_at: time, updated_at: time }, owner: { schema_version: 2 }, publications: [], authors: [], venues: [], gscholar_entries: [], reviews: [] };
      this.assertValid(s); await mkdir(this.attachmentsDir, { recursive: true });
      for (const [file, content] of [[".gitattributes", "attachments/** filter=lfs diff=lfs merge=lfs -text\n"], [".gitignore", "local/\n"]]) if (!await fileExists(join(this.root, file!))) await writeFile(join(this.root, file!), content!, "utf8");
      await writeState(this.root, new Map(), s); return s.library;
    });
  }
  async read(): Promise<CatalogState> {
    return withLock(join(this.localDir, "write.lock"), async () => { await recoverTransactions(this.root); const s = (await loadState(this.root)).state; this.assertValid(s); return s; });
  }

  async recover(): Promise<void> { await withLock(join(this.localDir, "write.lock"), () => recoverTransactions(this.root)); }
  assertValid(s: CatalogState): void { const result = validateState(s); if (!result.valid) throw new MyPubError("Catalog validation failed", "VALIDATION_FAILED", result); }
  async change<T>(action: (state: CatalogState, binary: Map<string, Buffer>) => T | Promise<T>): Promise<T> {
    return withLock(join(this.localDir, "write.lock"), async () => {
      await recoverTransactions(this.root); const loaded = await loadState(this.root); const before = clean(loaded.state); const originalFiles = new Map([...loaded.files].map(([path, value]) => [path, clean(value)])); const binaries = new Map<string, Buffer>();
      const result = await action(loaded.state, binaries); this.assertValid(loaded.state); assertUnchangedEvidence(before, loaded.state);
      for (const collection of ["publications", "authors", "venues", "gscholar_entries", "reviews"] as const) for (const old of before[collection]) {
        const next = loaded.state[collection].find((r) => r.id === old.id); if (!next) throw new MyPubError("Retain records; archive rather than delete", "RECORD_DELETION");
        if (old.created_at !== next.created_at || Date.parse(next.updated_at) < Date.parse(old.updated_at)) throw new MyPubError("Record lifecycle timestamps are immutable/monotonic", "TIMESTAMP_INVALID");
      }
      for (const [old, next] of [[before.library, loaded.state.library], [before.gscholar_profile, loaded.state.gscholar_profile]] as const) {
        if (old && (!next || old.created_at !== next.created_at || Date.parse(next.updated_at) < Date.parse(old.updated_at) || ("id" in old ? !("id" in next) || old.id !== next.id : !("profile_id" in next) || old.profile_id !== next.profile_id))) throw new MyPubError("Library/profile identity and lifecycle timestamps are immutable", "TIMESTAMP_INVALID");
      }
      // New links cannot target archived identities or bypass a rejected match.
      for (const p of loaded.state.publications) {
        const previous = before.publications.find((x) => x.id === p.id);
        for (const c of p.authors) if (c.author_id && !previous?.authors.some((a) => a.author_id === c.author_id) && resolveIdentity(loaded.state.authors, c.author_id)?.archived_at) throw new MyPubError("Restore the author before linking", "ARCHIVED_IDENTITY");
        if (p.venue?.venue_id && previous?.venue?.venue_id !== p.venue.venue_id && resolveIdentity(loaded.state.venues, p.venue.venue_id)?.archived_at) throw new MyPubError("Restore the venue before linking", "ARCHIVED_IDENTITY");
        if (p.gscholar_entry_id && p.gscholar_entry_id !== previous?.gscholar_entry_id && pairRejected(loaded.state, p.id, p.gscholar_entry_id)) throw new MyPubError("Reopen the rejected pair before linking", "MATCH_REJECTED");
      }
      await writeState(this.root, originalFiles, loaded.state, binaries); return result === undefined ? result : clean(result);
    });
  }
  async library(): Promise<Library> { return (await this.read()).library; }
  async list(filters: SearchFilters = {}): Promise<Publication[]> {
    const s = await this.read(); let authorId: string | undefined; let venueId: string | undefined;
    if (filters.author) { const author = s.authors.find((a) => a.id === filters.author || a.author_key === filters.author); if (!author) throw new MyPubError("Author not found", "NOT_FOUND"); authorId = resolveIdentity(s.authors, author.id)?.id; }
    if (filters.venue) { const v = s.venues.find((v) => v.id === filters.venue || v.venue_key === filters.venue); venueId = v ? resolveIdentity(s.venues, v.id)?.id : undefined; }
    const q = filters.query ? normalizeText(filters.query) : undefined;
    return s.publications.filter((p) => {
      if (!filters.includeArchived && p.archived_at || filters.type && p.type !== filters.type || filters.year !== undefined && publicationYear(p) !== filters.year) return false;
      if (filters.venue && (venueId ? resolveIdentity(s.venues, p.venue?.venue_id ?? "")?.id !== venueId : normalizeText(p.venue?.name ?? "") !== normalizeText(filters.venue))) return false;
      if (filters.tag && !p.tags.some((t) => normalizeText(t) === normalizeText(filters.tag!))) return false;
      if (authorId || filters.role) { if (!p.authors.some((c, i) => {
        const personMatches = !authorId || resolveIdentity(s.authors, c.author_id ?? "")?.id === authorId;
        const role = filters.role; const roleMatches = !role || (role === "first_listed" ? i === 0 : role === "first" ? i === 0 || !!c.roles?.includes("co_first") : !!c.roles?.includes(role));
        return personMatches && roleMatches;
      })) return false; }
      if (q) { const identities = p.authors.flatMap((c) => { const a = resolveIdentity(s.authors, c.author_id ?? ""); return a ? [a.preferred_name, a.author_key, ...a.aliases] : []; }); const venue = resolveIdentity(s.venues, p.venue?.venue_id ?? ""); const haystack = normalizeText([p.title, p.citation_key, p.venue?.name, venue?.preferred_name, venue?.abbreviation, ...(venue?.aliases ?? []), ...p.authors.map((a) => a.name), ...identities, ...p.tags, ...Object.values(p.identifiers)].filter(Boolean).join(" ")); if (!haystack.includes(q)) return false; }
      return true;
    }).sort((a, b) => (publicationDate(b) ?? "").localeCompare(publicationDate(a) ?? "") || a.title.localeCompare(b.title));
  }
  async get(ref: string): Promise<Publication> { return findPublication(await this.read(), ref); }
  async details(ref: string): Promise<PublicationDetails> { const s = await this.read(); const publication = findPublication(s, ref); return { publication, record_revision: fingerprint(publication), citation_count: currentCitations(s, publication), incoming_relations: s.publications.flatMap((p) => p.relations.filter((r) => r.target_id === publication.id).map((r) => ({ source_id: p.id, source_title: p.title, type: r.type, label: r.type === "published_version_of" ? "Published version" : r.type === "extends" ? "Extended by" : "Related publication", ...(r.note ? { note: r.note } : {}) }))) }; }
  async add(input: AddPublicationInput): Promise<Publication> { return this.change((s) => { const p = publicationFromInput(input); s.publications.push(p); return p; }); }
  async update(ref: string, patch: Partial<Omit<Publication, "schema_version" | "id" | "created_at">>, expected?: string): Promise<Publication> {
    return this.change((s) => { const p = findPublication(s, ref); if (expected && fingerprint(p) !== expected) throw new MyPubError("Publication changed", "STALE_REVISION"); for (const field of ["id", "schema_version", "created_at", "updated_at", "status", "dates"]) if (Object.hasOwn(patch, field)) throw new MyPubError(`Cannot update ${field}`, "SCHEMA_INVALID"); const updated = clean({ ...p, ...patch }); if (updated.identifiers?.doi) updated.identifiers.doi = normalizeDoi(updated.identifiers.doi); if (updated.identifiers?.arxiv) updated.identifiers.arxiv = normalizeArxiv(updated.identifiers.arxiv); touch(updated); s.publications[s.publications.indexOf(p)] = updated; return updated; });
  }
  async archive(ref: string): Promise<Publication> { return this.update(ref, { archived_at: now() }); }
  async restorePublication(ref: string): Promise<Publication> { return this.change((s) => { const p = findPublication(s, ref); delete p.archived_at; touch(p); return p; }); }
  async addRelation(source: string, target: string, type: RelationType, note?: string): Promise<Publication> { return this.change((s) => { const p = findPublication(s, source); p.relations.push({ type, target_id: findPublication(s, target).id, ...(note ? { note } : {}) }); touch(p); return p; }); }
  async removeRelation(source: string, target: string, type?: RelationType): Promise<Publication> { return this.change((s) => { const p = findPublication(s, source); const id = findPublication(s, target).id; p.relations = p.relations.filter((r) => r.target_id !== id || type && r.type !== type); touch(p); return p; }); }
  async addAttachment(ref: string, source: string, role: AttachmentRole, label?: string, primary = false): Promise<Attachment> {
    const data = await readFile(resolve(source)); const filename = basename(source); const hash = createHash("sha256").update(data).digest("hex");
    return this.change((s, binary) => { const p = findPublication(s, ref); const existing = p.attachments.find((a) => a.sha256 === hash); if (existing) return existing;
      const id = uuid(); const path = `attachments/${p.id}/${id}/${filename}`; const mime: Record<string, string> = { ".pdf": "application/pdf", ".mp4": "video/mp4", ".mov": "video/quicktime", ".zip": "application/zip", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
      const a: Attachment = { id, role, ...(label ? { label } : {}), original_filename: filename, media_type: mime[extname(filename).toLowerCase()] ?? "application/octet-stream", size_bytes: data.length, storage: "git-lfs", path, sha256: hash };
      p.attachments.push(a); if (primary || !p.primary_attachment_id && role === "paper") p.primary_attachment_id = id; touch(p); binary.set(path, data); return a;
    });
  }
  async validate(verifyAttachments = true): Promise<ValidationResult> {
    try {
      const loaded = await withLock(join(this.localDir, "write.lock"), async () => { await recoverTransactions(this.root); return loadState(this.root); }); const result = validateState(loaded.state);
      if (result.valid) for (const path of catalogFiles(loaded.state).keys()) if (!loaded.files.has(path)) result.issues.push({ code: "PATH_MISMATCH", severity: "warning", message: `Derived filename needs repair: ${path}`, path });
      if (verifyAttachments) for (const p of loaded.state.publications) for (const a of p.attachments) {
        const path = safePath(this.root, a.path); if (!await fileExists(path)) { result.issues.push({ code: "ATTACHMENT_NOT_LOCAL", severity: "warning", message: `Unavailable locally: ${a.path}`, publication_id: p.id }); continue; }
        const bytes = await readFile(path); if (bytes.subarray(0, 42).toString().startsWith("version https://git-lfs.github.com/spec/v1")) { result.issues.push({ code: "ATTACHMENT_NOT_LOCAL", severity: "warning", message: `LFS pointer is not materialized: ${a.path}`, publication_id: p.id }); continue; }
        if ((await stat(path)).size !== a.size_bytes || await sha256(path) !== a.sha256) result.issues.push({ code: "ATTACHMENT_MISMATCH", severity: "error", message: `Attachment size/hash mismatch: ${a.path}`, publication_id: p.id });
      }
      result.valid = !result.issues.some((i) => i.severity === "error"); return result;
    } catch (e) { return { valid: false, publication_count: 0, issues: [{ severity: "error", code: e instanceof MyPubError ? e.code : "INVALID_JSON", message: String(e) }] }; }
  }
  async audit(): Promise<ReturnType<typeof auditState>> { return auditState(await this.read()); }
  async repairPaths(): Promise<void> { await this.change(() => null); }
}
