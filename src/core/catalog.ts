import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { lookup as dnsLookup } from "node:dns/promises";
import type { AddPublicationInput, Attachment, AttachmentRole, CatalogOptions, IncomingRelation, Library, Publication, PublicationDetails, RelationType, SearchFilters, ValidationIssue, ValidationResult } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { assertLibrary, assertPublication, publicationIssues } from "./schemas.js";
import { atomicWriteJson, fileExists, normalizeArxiv, normalizeDoi, normalizeText, now, readJson, safePath, sha256, uuid, withLock } from "./utils.js";
import { MyPubError } from "./errors.js";

const MIME: Record<string, string> = { ".pdf": "application/pdf", ".mp4": "video/mp4", ".mov": "video/quicktime", ".zip": "application/zip", ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation" };

export class Catalog {
  readonly root: string;
  readonly catalogDir: string;
  readonly publicationsDir: string;
  readonly observationsDir: string;
  readonly reviewsDir: string;
  readonly localDir: string;
  readonly attachmentsDir: string;
  private readonly onProgress?: CatalogOptions["onProgress"];

  constructor(options: CatalogOptions) {
    this.root = options.root;
    this.catalogDir = join(this.root, "catalog");
    this.publicationsDir = join(this.catalogDir, "publications");
    this.observationsDir = join(this.catalogDir, "observations");
    this.reviewsDir = join(this.catalogDir, "reviews");
    this.localDir = join(this.root, "local");
    this.attachmentsDir = join(this.root, "attachments");
    this.onProgress = options.onProgress;
  }

  async initialize(name = "My Publications"): Promise<Library> {
    return withLock(join(this.localDir, "write.lock"), async () => {
      const libraryPath = join(this.catalogDir, "library.json");
      if (await fileExists(libraryPath)) { const library = await readJson<unknown>(libraryPath); assertLibrary(library); return library; }
      await Promise.all([this.publicationsDir, this.observationsDir, this.reviewsDir, join(this.catalogDir, "config"), this.attachmentsDir, join(this.localDir, "exports")].map((path) => mkdir(path, { recursive: true })));
      const attributesPath = join(this.root, ".gitattributes");
      if (!(await fileExists(attributesPath))) await writeFile(attributesPath, "attachments/** filter=lfs diff=lfs merge=lfs -text\n", "utf8");
      const ignorePath = join(this.root, ".gitignore");
      if (!(await fileExists(ignorePath))) await writeFile(ignorePath, "local/\n", "utf8");
      const timestamp = now();
      const library: Library = { schema_version: SCHEMA_VERSION, id: uuid(), name, created_at: timestamp, updated_at: timestamp };
      await atomicWriteJson(libraryPath, library);
      await atomicWriteJson(join(this.catalogDir, "config", "venues.json"), { schema_version: SCHEMA_VERSION, venues: [] });
      await atomicWriteJson(join(this.catalogDir, "config", "author.json"), { schema_version: SCHEMA_VERSION, names: [], profile_ids: {} });
      return library;
    });
  }

  async library(): Promise<Library> { const value = await readJson<unknown>(join(this.catalogDir, "library.json")); assertLibrary(value); return value; }
  private publicationPath(id: string): string { return join(this.publicationsDir, `${id}.json`); }

  async list(filters: SearchFilters = {}): Promise<Publication[]> {
    if (!(await fileExists(this.publicationsDir))) return [];
    const files = (await readdir(this.publicationsDir)).filter((file) => file.endsWith(".json")).sort();
    const records: Publication[] = [];
    for (const file of files) {
      const value = await readJson<unknown>(join(this.publicationsDir, file));
      try { assertPublication(value, `catalog/publications/${file}`); } catch (error) { throw new MyPubError(`Invalid publication ${file}: ${String(error)}`, "SCHEMA_INVALID"); }
      records.push(value);
    }
    const q = filters.query ? normalizeText(filters.query) : undefined;
    return records.filter((publication) => {
      if (!filters.includeArchived && publication.status === "archived") return false;
      if (filters.type && publication.type !== filters.type) return false;
      if (filters.status && publication.status !== filters.status) return false;
      if (filters.venue && normalizeText(publication.venue ?? "") !== normalizeText(filters.venue)) return false;
      if (filters.tag && !publication.tags.some((tag) => normalizeText(tag) === normalizeText(filters.tag!))) return false;
      if (filters.year && !Object.values(publication.dates).some((date) => date?.startsWith(String(filters.year)))) return false;
      if (q) {
        const haystack = normalizeText([publication.title, publication.citation_key, publication.venue, ...publication.authors.map((a) => a.name), ...publication.tags, publication.identifiers.doi, publication.identifiers.arxiv].filter(Boolean).join(" "));
        if (!haystack.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => (b.dates.issued ?? b.dates.online ?? "").localeCompare(a.dates.issued ?? a.dates.online ?? "") || a.title.localeCompare(b.title));
  }

  async get(idOrKey: string): Promise<Publication> {
    const direct = this.publicationPath(idOrKey);
    if (await fileExists(direct)) { const value = await readJson<unknown>(direct); assertPublication(value, direct); return value; }
    const matches = (await this.list({ includeArchived: true })).filter((record) => record.citation_key === idOrKey || record.identifiers.doi === normalizeDoi(idOrKey) || record.identifiers.arxiv === normalizeArxiv(idOrKey));
    if (matches.length === 0) throw new MyPubError(`Publication not found: ${idOrKey}`, "NOT_FOUND");
    if (matches.length > 1) throw new MyPubError(`Publication reference is ambiguous: ${idOrKey}`, "AMBIGUOUS");
    return matches[0]!;
  }

  async details(idOrKey: string): Promise<PublicationDetails> {
    const publication = await this.get(idOrKey);
    const incoming_relations: IncomingRelation[] = [];
    for (const source of await this.list({ includeArchived: true })) for (const relation of source.relations) if (relation.target_id === publication.id) incoming_relations.push({ source_id: source.id, source_title: source.title, type: relation.type, label: relation.type === "published_version_of" ? "Published version" : relation.type === "extends" ? "Extended by" : "Related publication", ...(relation.note ? { note: relation.note } : {}) });
    return { publication, incoming_relations };
  }

  async add(input: AddPublicationInput): Promise<Publication> {
    return withLock(join(this.localDir, "write.lock"), async () => {
      const records = await this.list({ includeArchived: true });
      if (records.some((record) => record.citation_key === input.citation_key)) throw new MyPubError(`Duplicate citation key: ${input.citation_key}`, "DUPLICATE_CITATION_KEY");
      const doi = input.identifiers?.doi ? normalizeDoi(input.identifiers.doi) : undefined;
      const arxiv = input.identifiers?.arxiv ? normalizeArxiv(input.identifiers.arxiv) : undefined;
      if (doi && records.some((record) => record.identifiers.doi === doi)) throw new MyPubError(`Duplicate DOI: ${doi}`, "DUPLICATE_IDENTIFIER");
      if (arxiv && records.some((record) => record.identifiers.arxiv === arxiv)) throw new MyPubError(`Duplicate arXiv id: ${arxiv}`, "DUPLICATE_IDENTIFIER");
      const timestamp = now();
      const record: Publication = {
        schema_version: SCHEMA_VERSION, id: input.id ?? uuid(), citation_key: input.citation_key, type: input.type, status: input.status ?? "published", title: input.title,
        authors: input.authors, dates: input.dates ?? {}, identifiers: { ...input.identifiers, ...(doi ? { doi } : {}), ...(arxiv ? { arxiv } : {}) }, urls: input.urls ?? [], tags: input.tags ?? [], relations: input.relations ?? [], attachments: input.attachments ?? [], created_at: timestamp, updated_at: timestamp,
        ...(input.venue ? { venue: input.venue } : {}), ...(input.volume ? { volume: input.volume } : {}), ...(input.issue ? { issue: input.issue } : {}), ...(input.pages ? { pages: input.pages } : {}), ...(input.article_number ? { article_number: input.article_number } : {}), ...(input.notes ? { notes: input.notes } : {}), ...(input.primary_attachment_id ? { primary_attachment_id: input.primary_attachment_id } : {})
      };
      assertPublication(record);
      await atomicWriteJson(this.publicationPath(record.id), record);
      return record;
    });
  }

  async update(idOrKey: string, patch: Partial<Omit<Publication, "schema_version" | "id" | "created_at">>): Promise<Publication> {
    return withLock(join(this.localDir, "write.lock"), async () => {
      const current = await this.get(idOrKey);
      const updated = { ...current, ...patch, id: current.id, schema_version: SCHEMA_VERSION, created_at: current.created_at, updated_at: now() } satisfies Publication;
      if (updated.identifiers.doi) updated.identifiers.doi = normalizeDoi(updated.identifiers.doi);
      if (updated.identifiers.arxiv) updated.identifiers.arxiv = normalizeArxiv(updated.identifiers.arxiv);
      assertPublication(updated);
      await atomicWriteJson(this.publicationPath(current.id), updated);
      return updated;
    });
  }

  async archive(idOrKey: string): Promise<Publication> { return this.update(idOrKey, { status: "archived", archived_at: now() }); }

  async addRelation(sourceRef: string, targetRef: string, type: RelationType, note?: string): Promise<Publication> {
    const source = await this.get(sourceRef); const target = await this.get(targetRef);
    if (source.id === target.id) throw new MyPubError("A publication cannot relate to itself", "SELF_RELATION");
    if (source.relations.some((relation) => relation.type === type && relation.target_id === target.id)) throw new MyPubError("Relation already exists", "DUPLICATE_RELATION");
    const relation = { type, target_id: target.id, ...(note ? { note } : {}) };
    return this.update(source.id, { relations: [...source.relations, relation] });
  }

  async removeRelation(sourceRef: string, targetRef: string, type?: RelationType): Promise<Publication> {
    const source = await this.get(sourceRef); const target = await this.get(targetRef);
    return this.update(source.id, { relations: source.relations.filter((relation) => relation.target_id !== target.id || (type && relation.type !== type)) });
  }

  async addAttachment(publicationRef: string, sourcePath: string, role: AttachmentRole, label?: string, primary = false): Promise<Attachment> {
    return withLock(join(this.localDir, "write.lock"), async () => {
      const publication = await this.get(publicationRef);
      const source = resolve(sourcePath);
      const sourceStat = await stat(source); if (!sourceStat.isFile()) throw new MyPubError("Attachment source must be a file", "INVALID_ATTACHMENT");
      const digest = await sha256(source);
      const existing = publication.attachments.find((item) => item.sha256 === digest);
      if (existing) return existing;
      const id = uuid(); const filename = basename(source); const rel = join("attachments", publication.id, id, filename).split("\\").join("/"); const destination = safePath(this.root, rel);
      await mkdir(join(this.attachmentsDir, publication.id, id), { recursive: true });
      const temporary = `${destination}.tmp`;
      await copyFile(source, temporary); if (await sha256(temporary) !== digest) { await unlink(temporary); throw new MyPubError("Attachment copy hash mismatch", "HASH_MISMATCH"); }
      await rename(temporary, destination);
      const attachment: Attachment = { id, role, ...(label ? { label } : {}), original_filename: filename, media_type: MIME[extname(filename).toLowerCase()] ?? "application/octet-stream", size_bytes: sourceStat.size, storage: "git-lfs", path: rel, sha256: digest };
      const updated: Publication = { ...publication, attachments: [...publication.attachments, attachment], updated_at: now(), ...((primary || (!publication.primary_attachment_id && role === "paper")) ? { primary_attachment_id: id } : {}) };
      assertPublication(updated); await atomicWriteJson(this.publicationPath(publication.id), updated);
      return attachment;
    });
  }

  async validate(verifyAttachments = true): Promise<ValidationResult> {
    const issues: ValidationIssue[] = []; const publications: Publication[] = [];
    if (!(await fileExists(join(this.catalogDir, "library.json")))) issues.push({ severity: "error", code: "LIBRARY_MISSING", message: "catalog/library.json is missing" });
    if (await fileExists(this.publicationsDir)) for (const file of (await readdir(this.publicationsDir)).filter((f) => f.endsWith(".json"))) {
      const path = join(this.publicationsDir, file);
      try { const value = await readJson<unknown>(path); const itemIssues = publicationIssues(value, relative(this.root, path)); issues.push(...itemIssues); if (itemIssues.length === 0) publications.push(value as Publication); } catch (error) { issues.push({ severity: "error", code: "INVALID_JSON", message: String(error), path: relative(this.root, path) }); }
    }
    const byId = new Map(publications.map((publication) => [publication.id, publication])); const identifiers = new Map<string, string>(); const keys = new Map<string, string>();
    for (const publication of publications) {
      if (keys.has(publication.citation_key)) issues.push({ severity: "error", code: "DUPLICATE_CITATION_KEY", message: `Duplicate citation key ${publication.citation_key}`, publication_id: publication.id }); else keys.set(publication.citation_key, publication.id);
      for (const [provider, id] of Object.entries(publication.identifiers)) if (id) { const key = `${provider}:${id.toLowerCase()}`; if (identifiers.has(key)) issues.push({ severity: "error", code: "DUPLICATE_IDENTIFIER", message: `Duplicate ${provider} ${id}`, publication_id: publication.id }); else identifiers.set(key, publication.id); }
      const relationKeys = new Set<string>();
      for (const relation of publication.relations) { const key = `${relation.type}:${relation.target_id}`; if (relationKeys.has(key)) issues.push({ severity: "error", code: "DUPLICATE_RELATION", message: `Duplicate relation ${key}`, publication_id: publication.id }); relationKeys.add(key); if (relation.target_id === publication.id) issues.push({ severity: "error", code: "SELF_RELATION", message: "Self relation", publication_id: publication.id }); if (!byId.has(relation.target_id)) issues.push({ severity: "error", code: "BROKEN_RELATION", message: `Missing target ${relation.target_id}`, publication_id: publication.id }); }
      if (verifyAttachments) for (const attachment of publication.attachments) { const path = safePath(this.root, attachment.path); if (!(await fileExists(path))) issues.push({ severity: "warning", code: "ATTACHMENT_NOT_LOCAL", message: `Attachment is not materialized: ${attachment.path}`, publication_id: publication.id }); else { const info = await stat(path); if (info.size !== attachment.size_bytes || await sha256(path) !== attachment.sha256) issues.push({ severity: "error", code: "ATTACHMENT_MISMATCH", message: `Attachment size/hash mismatch: ${attachment.path}`, publication_id: publication.id }); } }
    }
    for (const type of ["published_version_of", "extends"] as const) for (const publication of publications) { const seen = new Set<string>(); let current: Publication | undefined = publication; while (current) { if (seen.has(current.id)) { issues.push({ severity: "error", code: "RELATION_CYCLE", message: `Cycle in ${type} chain`, publication_id: publication.id }); break; } seen.add(current.id); const nextRelation: { target_id: string } | undefined = current.relations.find((relation) => relation.type === type); current = nextRelation ? byId.get(nextRelation.target_id) : undefined; } }
    return { valid: !issues.some((issue) => issue.severity === "error"), issues, publication_count: publications.length };
  }
}
