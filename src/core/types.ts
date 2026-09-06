export const SCHEMA_VERSION = 1 as const;

export type PublicationType = "arxiv" | "conference" | "workshop" | "journal" | "book-chapter" | "thesis" | "other";
export type PublicationStatus = "draft" | "submitted" | "accepted" | "published" | "archived";
export type RelationType = "published_version_of" | "extends" | "related_to";
export type AttachmentRole = "paper" | "supplement" | "slides" | "video" | "other";
export type ReviewState = "pending" | "accepted" | "rejected" | "deferred";

export interface Author { name: string; orcid?: string; }
export interface PublicationDates { submitted?: string; accepted?: string; online?: string; issued?: string; }
export interface PublicationIdentifiers { doi?: string; arxiv?: string; isbn?: string; }
export interface Relation { type: RelationType; target_id: string; note?: string; }
export interface Attachment {
  id: string;
  role: AttachmentRole;
  label?: string;
  original_filename: string;
  media_type: string;
  size_bytes: number;
  storage: "git-lfs";
  path: string;
  sha256: string;
  source_url?: string;
}
export interface Publication {
  schema_version: typeof SCHEMA_VERSION;
  id: string;
  citation_key: string;
  type: PublicationType;
  status: PublicationStatus;
  title: string;
  authors: Author[];
  venue?: string;
  dates: PublicationDates;
  identifiers: PublicationIdentifiers;
  volume?: string;
  issue?: string;
  pages?: string;
  article_number?: string;
  urls: string[];
  tags: string[];
  notes?: string;
  relations: Relation[];
  attachments: Attachment[];
  primary_attachment_id?: string;
  archived_at?: string;
  created_at: string;
  updated_at: string;
}

export interface Library { schema_version: typeof SCHEMA_VERSION; id: string; name: string; created_at: string; updated_at: string; }
export interface Observation {
  schema_version: typeof SCHEMA_VERSION;
  id: string;
  kind: "metadata" | "citation" | "scholar-profile";
  provider: string;
  provider_record_id?: string;
  publication_ids: string[];
  observed_at: string;
  source?: string;
  payload: unknown;
  completeness: "complete" | "partial" | "unknown";
  parser_version: string;
}
export interface FieldProposal { field: string; current: unknown; proposed: unknown; }
export interface Review {
  schema_version: typeof SCHEMA_VERSION;
  id: string;
  kind: "create" | "update" | "relation" | "mapping";
  state: ReviewState;
  publication_id?: string;
  observation_id?: string;
  proposed_publication?: Publication;
  changes: FieldProposal[];
  candidate_ids: string[];
  source_fingerprint: string;
  created_at: string;
  decided_at?: string;
  decision_note?: string;
}
export interface IncomingRelation { source_id: string; source_title: string; type: RelationType; label: string; note?: string; }
export interface PublicationDetails { publication: Publication; incoming_relations: IncomingRelation[]; }
export interface SearchFilters { query?: string; year?: number; venue?: string; type?: PublicationType; status?: PublicationStatus; tag?: string; includeArchived?: boolean; }
export interface ValidationIssue { severity: "error" | "warning"; code: string; message: string; path?: string; publication_id?: string; }
export interface ValidationResult { valid: boolean; issues: ValidationIssue[]; publication_count: number; }
export interface ImportResult { observation_id: string; review_ids: string[]; created: number; matched: number; duplicates: number; }
export interface ProgressEvent { phase: string; message: string; current?: number; total?: number; }
export type ProgressHandler = (event: ProgressEvent) => void;
export interface SyncConflict { id: string; path: string; base?: string; ours?: string; theirs?: string; created_at: string; }
export interface SyncResult { state: "up-to-date" | "pushed" | "pulled" | "merged" | "needs-review"; commit?: string; conflicts: SyncConflict[]; }
export interface StatusResult { catalog: "ready" | "missing"; git: boolean; lfs: boolean; branch?: string; upstream?: string; ahead?: number; behind?: number; dirty: boolean; pending_upload: boolean; needs_review: boolean; last_successful_sync?: string; }
export interface ScholarRow { title: string; year?: number; venue?: string; scholar_id?: string; article_url?: string; citation_count?: number; observed_at: string; matched_publication_ids: string[]; match: "exact-id" | "title-year" | "ambiguous" | "unmatched"; }
export interface ScholarReconciliation { observation_id: string; observed_at: string; completeness: "complete" | "partial" | "unknown"; local_only: string[]; source_only: ScholarRow[]; matched: ScholarRow[]; ambiguous: ScholarRow[]; differences: Array<{ publication_id: string; field: "title" | "year" | "venue"; local: string; observed: string }>; shared_counts: Array<{ scholar_id: string; publication_ids: string[]; citation_count?: number }> ; }

export interface AddPublicationInput extends Partial<Omit<Publication, "schema_version" | "id" | "created_at" | "updated_at">> {
  id?: string;
  citation_key: string;
  type: PublicationType;
  title: string;
  authors: Author[];
}

export interface CatalogOptions { root: string; onProgress?: ProgressHandler; }
