import type { Attachment, Library, Observation, Publication, Relation, Review, ValidationIssue } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const optionalText = (value: unknown): boolean => value === undefined || typeof value === "string";
const enumValue = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === "string" && values.includes(value as T);
const uuidLike = (value: unknown): boolean => text(value) && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value);

export function publicationIssues(value: unknown, path?: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (code: string, message: string): void => { issues.push({ severity: "error", code, message, ...(path ? { path } : {}) }); };
  if (!object(value)) { error("PUBLICATION_OBJECT", "Publication must be an object"); return issues; }
  if (value.schema_version !== SCHEMA_VERSION) error("SCHEMA_VERSION", `Expected schema_version ${SCHEMA_VERSION}`);
  if (!uuidLike(value.id)) error("PUBLICATION_ID", "Publication id must be a UUID");
  if (!text(value.citation_key)) error("CITATION_KEY", "citation_key is required");
  if (!enumValue(value.type, ["arxiv", "conference", "workshop", "journal", "book-chapter", "thesis", "other"])) error("PUBLICATION_TYPE", "Invalid publication type");
  if (!enumValue(value.status, ["draft", "submitted", "accepted", "published", "archived"])) error("PUBLICATION_STATUS", "Invalid publication status");
  if (!text(value.title)) error("TITLE", "title is required");
  if (!Array.isArray(value.authors) || value.authors.some((author) => !object(author) || !text(author.name) || !optionalText(author.orcid))) error("AUTHORS", "authors must be an ordered array of named authors");
  if (!object(value.dates) || Object.values(value.dates).some((date) => typeof date !== "string")) error("DATES", "dates must contain strings");
  if (!object(value.identifiers) || !optionalText(value.identifiers.doi) || !optionalText(value.identifiers.arxiv)) error("IDENTIFIERS", "identifiers is invalid");
  if (!Array.isArray(value.urls) || value.urls.some((url) => typeof url !== "string")) error("URLS", "urls must be strings");
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")) error("TAGS", "tags must be strings");
  if (!Array.isArray(value.relations) || value.relations.some((relation) => relationIssues(relation).length > 0)) error("RELATIONS", "relations contains an invalid relation");
  if (!Array.isArray(value.attachments) || value.attachments.some((attachment) => attachmentIssues(attachment).length > 0)) error("ATTACHMENTS", "attachments contains an invalid attachment");
  if (!text(value.created_at) || !text(value.updated_at)) error("TIMESTAMPS", "created_at and updated_at are required");
  return issues;
}

export function relationIssues(value: unknown): string[] {
  if (!object(value)) return ["not an object"];
  const result: string[] = [];
  if (!enumValue(value.type, ["published_version_of", "extends", "related_to"])) result.push("invalid type");
  if (!uuidLike(value.target_id)) result.push("invalid target_id");
  if (!optionalText(value.note)) result.push("invalid note");
  return result;
}

export function attachmentIssues(value: unknown): string[] {
  if (!object(value)) return ["not an object"];
  const result: string[] = [];
  if (!uuidLike(value.id)) result.push("invalid id");
  if (!enumValue(value.role, ["paper", "supplement", "slides", "video", "other"])) result.push("invalid role");
  if (!text(value.original_filename) || !text(value.media_type) || !text(value.path)) result.push("missing file metadata");
  if (typeof value.size_bytes !== "number" || value.size_bytes < 0) result.push("invalid size");
  if (value.storage !== "git-lfs") result.push("invalid storage");
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) result.push("invalid sha256");
  return result;
}

export function assertPublication(value: unknown, path?: string): asserts value is Publication {
  const issues = publicationIssues(value, path);
  if (issues.length) throw new Error(issues.map((issue) => issue.message).join("; "));
}

export function assertLibrary(value: unknown): asserts value is Library {
  if (!object(value) || value.schema_version !== SCHEMA_VERSION || !uuidLike(value.id) || !text(value.name)) throw new Error("Invalid library.json");
}

export function assertObservation(value: unknown): asserts value is Observation {
  if (!object(value) || value.schema_version !== SCHEMA_VERSION || !uuidLike(value.id) || !text(value.provider) || !Array.isArray(value.publication_ids)) throw new Error("Invalid observation");
}

export function assertReview(value: unknown): asserts value is Review {
  if (!object(value) || value.schema_version !== SCHEMA_VERSION || !uuidLike(value.id) || !enumValue(value.state, ["pending", "accepted", "rejected", "deferred"]) || !Array.isArray(value.changes)) throw new Error("Invalid review");
}

export const asPublication = (value: unknown): Publication => { assertPublication(value); return value; };
export const asObservation = (value: unknown): Observation => { assertObservation(value); return value; };
export const asReview = (value: unknown): Review => { assertReview(value); return value; };

export const isRelation = (value: unknown): value is Relation => relationIssues(value).length === 0;
export const isAttachment = (value: unknown): value is Attachment => attachmentIssues(value).length === 0;
