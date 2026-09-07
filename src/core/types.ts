export const SCHEMA_VERSION = 2 as const;
export type PublicationType = "arxiv" | "conference" | "workshop" | "journal" | "book-chapter" | "thesis" | "other";
export type RelationType = "published_version_of" | "extends" | "related_to";
export type AttachmentRole = "paper" | "supplement" | "slides" | "video" | "other";
export type AuthorRole = "co_first" | "corresponding" | "co_last" | "equal_contributor";
export type Coverage = "complete" | "partial" | "unknown";
export type ProposalState = "pending" | "accepted" | "rejected" | "deferred";
export type ReviewState = ProposalState | "partially_accepted";
export interface RecordBase { schema_version: 2; id: string; created_at: string; updated_at: string; }
export interface NameParts { family?: string; given?: string; suffix?: string; }
export interface AuthorCredit { name: string; author_id?: string; name_parts?: NameParts; roles?: AuthorRole[]; equal_contribution_group?: string; note?: string; }
/** A printed credit; shared people are AuthorIdentity records. */
export type Author = AuthorCredit;
export interface AuthorIdentity extends RecordBase {
  author_key: string; preferred_name: string; name_parts?: NameParts; aliases: string[];
  identifiers: { google_scholar?: string; orcid?: string };
  identifier_aliases?: Array<{ provider: "google_scholar" | "orcid"; value: string; note?: string }>;
  disambiguation_note?: string; archived_at?: string; merged_into?: string;
}
export interface VenueUrl { url: string; role: "homepage" | "proceedings" | "submission" | "other"; label?: string; }
export interface VenueIdentity extends RecordBase {
  venue_key: string; kind: "journal" | "conference" | "workshop" | "repository" | "other";
  preferred_name: string; abbreviation?: string; aliases: string[]; urls: VenueUrl[];
  disambiguation_note?: string; archived_at?: string; merged_into?: string;
}
export interface PublicationVenue { name: string; venue_id?: string; event_year?: number; }
export interface PublicationIdentifiers { doi?: string; arxiv?: string; isbn?: string; }
export interface Relation { type: RelationType; target_id: string; note?: string; }
export interface Attachment {
  id: string; role: AttachmentRole; label?: string; original_filename: string; media_type: string;
  size_bytes: number; storage: "git-lfs"; path: string; sha256: string; source_url?: string;
}
export interface Publication extends RecordBase {
  citation_key: string; gscholar_entry_id?: string; type: PublicationType; title: string;
  authors: AuthorCredit[]; authorship_note?: string; venue?: PublicationVenue;
  publication_date?: string; submission_date?: string; acceptance_date?: string; online_date?: string; issued_date?: string;
  identifiers: PublicationIdentifiers;
  arxiv_versions?: Array<{ version: number; submission_date: string; title: string; authors: string[]; abstract: string; source_review_id?: string }>;
  volume?: string; issue?: string; pages?: string; article_number?: string; urls: string[]; tags: string[]; notes?: string;
  relations: Relation[]; attachments: Attachment[]; primary_attachment_id?: string; archived_at?: string;
}
export interface Library extends RecordBase { name: string; }
export interface OwnerConfig { schema_version: 2; self_author_id?: string; }
export interface CitationSample { observed_at: string; count: number | null; estimated?: boolean; source_review_id: string; }
export interface AnnualCitations { observed_at: string; counts: Record<string, number | null>; source_review_id: string; }
export interface MatchingPolicy { policy: "eligible" | "excluded"; reason?: string; decision_review_id?: string; }
export interface ScholarEntry extends RecordBase {
  profile_id: string; scholar_id: string; title: string; authors: string[]; authors_text?: string; authors_completeness: Coverage;
  venue?: string; year?: number; publication_date?: string; volume?: string; issue?: string; pages?: string;
  publisher?: string; patent_office?: string; application_number?: string; description?: string; scholar_url?: string; cited_by_url?: string;
  matching: MatchingPolicy; first_seen_at: string; last_seen_at: string; presence: "present" | "missing"; missing_since?: string;
  source_review_id: string; citation_history: CitationSample[]; annual_citations?: AnnualCitations[];
}
export interface ScholarCapture {
  captured_at: string; coverage: Coverage; source_review_id: string; observed_entry_ids: string[];
  totals?: { citations?: number | null; h_index?: number | null; i10_index?: number | null };
}
export interface ScholarProfile { schema_version: 2; profile_id: string; captures: ScholarCapture[]; created_at: string; updated_at: string; }
export type EntityType = "library" | "publication" | "author" | "venue" | "gscholar_profile" | "gscholar_entry";
export interface ReviewTarget { entity_type: EntityType; entity_id?: string; }
export interface Evidence { provider: string; captured_at: string; source_reference?: string; payload: unknown; completeness: Coverage; parser_version: string; input_fingerprint: string; }
export interface Proposal {
  id: string; target: ReviewTarget; operation: "create" | "replace" | "remove" | "link" | "unlink" | "archive" | "restore" | "merge";
  path?: string; expected_revision?: string; current?: unknown; proposed?: unknown; candidate_ids?: string[]; state: ProposalState; decided_at?: string; decision_note?: string;
}
export interface Review extends RecordBase {
  summary: string; kind: "import" | "change" | "identity" | "merge" | "migration" | "sync"; state: ReviewState;
  targets: ReviewTarget[]; source_review_id?: string; evidence?: Evidence; proposals: Proposal[]; decision_note?: string; decided_at?: string;
}
export interface CatalogState {
  library: Library; owner: OwnerConfig; publications: Publication[]; authors: AuthorIdentity[]; venues: VenueIdentity[];
  gscholar_profile?: ScholarProfile; gscholar_entries: ScholarEntry[]; reviews: Review[];
}
export type EntityRecord = Publication | AuthorIdentity | VenueIdentity | ScholarEntry | Review;
export interface IncomingRelation { source_id: string; source_title: string; type: RelationType; label: string; note?: string; }
export interface PublicationDetails { publication: Publication; record_revision: string; incoming_relations: IncomingRelation[]; citation_count: number | null; }
export interface SearchFilters { query?: string; year?: number; venue?: string; author?: string; role?: AuthorRole | "first" | "first_listed"; type?: PublicationType; tag?: string; includeArchived?: boolean; }
export interface ValidationIssue { severity: "error" | "warning"; code: string; message: string; path?: string; publication_id?: string; entity_id?: string; }
export interface ValidationResult { valid: boolean; issues: ValidationIssue[]; publication_count: number; }
export interface AuditFinding { severity: "error"; blocks_write: false; code: "duplicate_arxiv_id"; identifier: string; publication_ids: string[]; }
export interface ImportResult { source_review_id: string; review_ids: string[]; created: number; matched: number; duplicates: number; }
export interface ProgressEvent { phase: string; message: string; current?: number; total?: number; }
export type ProgressHandler = (event: ProgressEvent) => void;
export interface SyncConflict {
  schema_version: 2; id: string; kind: "record" | "path" | "identifier" | "key" | "reference" | "attachment";
  record_type?: EntityType | "review" | "owner"; record_id?: string; path?: string; base: unknown | null; ours: unknown | null; theirs: unknown | null;
  details?: Record<string, unknown>; created_at: string;
}
export interface CommitResult { state: "committed" | "no-changes"; commit?: string; message?: string; }
export interface SyncResult { state: "up-to-date" | "pushed" | "pulled" | "merged" | "needs-review"; commit?: string; conflicts: SyncConflict[]; }
export interface StatusChange { path: string; previous_path?: string; status: "added" | "modified" | "deleted" | "renamed" | "copied" | "conflicted"; label?: string; }
export interface StatusResult { changes?: StatusChange[]; catalog: "ready" | "missing"; git: boolean; lfs: boolean; branch?: string; upstream?: string; ahead?: number; behind?: number; dirty: boolean; pending_upload: boolean; needs_review: boolean; last_successful_sync?: string; }
export interface ScholarReconciliation {
  source_review_id?: string; local_only: string[]; matched: string[]; source_only: string[]; excluded: string[]; missing: string[];
  candidates: Array<{ entry_id: string; publication_ids: string[] }>; rejected_pairs: Array<{ entry_id: string; publication_id: string }>;
  differences: Array<{ publication_id: string; entry_id: string; field: string; local: unknown; observed: unknown }>;
  shared_counts: Array<{ entry_id: string; publication_ids: string[]; citation_count: number | null }>;
}
export interface AddPublicationInput extends Partial<Omit<Publication, "schema_version" | "created_at" | "updated_at">> { citation_key: string; type: PublicationType; title: string; authors: AuthorCredit[]; }
export interface CatalogOptions { root: string; onProgress?: ProgressHandler; }
export interface NativeExport {
  format: "mypub-native"; format_version: 1; exported_at: string;
  source_library: Pick<Library, "id" | "name" | "schema_version">; selection: { publication_ids: string[] };
  publications: Publication[]; authors: AuthorIdentity[]; venues: VenueIdentity[]; gscholar_profile: ScholarProfile | null;
  gscholar_entries: ScholarEntry[]; reviews: Review[];
}
export interface HistoryEvent { commit: string; parents: string[]; committer: { name: string; email: string; time: string }; author: { name: string; email: string }; subject: string; paths: string[]; }
