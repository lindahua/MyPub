import type { Attachment, AuthorIdentity, Library, OwnerConfig, Publication, Relation, Review, ScholarEntry, ScholarProfile, ValidationIssue, VenueIdentity } from "./types.js";
import { MyPubError } from "./errors.js";

type Rule = { check: (value: unknown, path: string, errors: string[]) => void; optional?: boolean };
const rule = (test: (value: unknown) => boolean, message: string): Rule => ({ check: (v, p, e) => { if (!test(v)) e.push(`${p}: ${message}`); } });
const optional = (r: Rule): Rule => ({ ...r, optional: true });
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const object = (fields: Record<string, Rule>): Rule => ({ check: (v, p, e) => {
  if (!isObject(v)) { e.push(`${p}: expected object`); return; }
  for (const k of Object.keys(v)) if (!(k in fields) || !Object.hasOwn(fields, k)) e.push(`${p}/${k}: unknown property`);
  for (const [k, r] of Object.entries(fields)) { if (!Object.hasOwn(v, k)) { if (!r.optional) e.push(`${p}/${k}: required`); } else r.check(v[k], `${p}/${k}`, e); }
} });
const array = (r: Rule, unique = false, min = 0): Rule => ({ check: (v, p, e) => {
  if (!Array.isArray(v)) { e.push(`${p}: expected array`); return; }
  if (v.length < min) e.push(`${p}: too few items`);
  if (unique && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) e.push(`${p}: duplicate values`);
  v.forEach((x, i) => r.check(x, `${p}/${i}`, e));
} });
const enumeration = (...values: unknown[]): Rule => rule((v) => values.includes(v), `expected ${values.join(" | ")}`);
const text = rule((v) => typeof v === "string" && v.trim().length > 0, "expected non-empty string");
const regex = (pattern: RegExp, message: string): Rule => rule((v) => typeof v === "string" && pattern.test(v), message);
export const validUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const id = rule(validUuid, "expected canonical RFC 4122 UUID");
const key = regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/, "invalid key");
export function validDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(v)) return false;
  const [y, m = 1, d = 1] = v.split("-").map(Number) as [number, number?, number?];
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const days = [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[m - 1]!;
}
export const validTimestamp = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v) && validDate(v.slice(0, 10)) && Number(v.slice(11, 13)) < 24 && Number(v.slice(14, 16)) < 60 && Number(v.slice(17, 19)) < 60;
const timestamp = rule(validTimestamp, "expected UTC timestamp");
const date = rule(validDate, "invalid local date");
const integer = (min: number, max = Number.MAX_SAFE_INTEGER): Rule => rule((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max, `expected integer ${min}..${max}`);
const count = rule((v) => v === null || typeof v === "number" && Number.isSafeInteger(v) && v >= 0, "expected non-negative count or null");
const uri = rule((v) => { try { return typeof v === "string" && !!new URL(v).protocol && !/\s/.test(v); } catch { return false; } }, "expected absolute URI");
export const validRepositoryPath = (v: unknown): v is string => typeof v === "string" && !/^[\\/]|^[A-Za-z]:|\\|\0/.test(v) && v.split("/").every((p) => !!p && p !== "." && p !== "..");
const path = rule(validRepositoryPath, "unsafe repository path");
const hash = regex(/^[a-f0-9]{64}$/, "expected SHA-256");
const json: Rule = { check: (v, p, e) => {
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "number") { if (!Number.isFinite(v)) e.push(`${p}: invalid JSON number`); return; }
  if (typeof v === "string") { if (/^(?:\/Users\/|\/home\/|[A-Za-z]:\\)/.test(v)) e.push(`${p}: machine-absolute path`); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => json.check(x, `${p}/${i}`, e)); return; }
  if (isObject(v)) { for (const [k, x] of Object.entries(v)) { if (/^(password(?:_hash)?|access_token|refresh_token|api_key|client_secret|private_key)$/i.test(k)) e.push(`${p}/${k}: credential forbidden`); json.check(x, `${p}/${k}`, e); } return; }
  e.push(`${p}: not JSON`);
} };
const base = { schema_version: enumeration(2), id, created_at: timestamp, updated_at: timestamp };
const coverage = enumeration("complete", "partial", "unknown");
const nameParts = object({ family: optional(text), given: optional(text), suffix: optional(text) });
const roles = enumeration("co_first", "corresponding", "co_last", "equal_contributor");
const credit = object({ name: text, author_id: optional(id), name_parts: optional(nameParts), roles: optional(array(roles, true)), equal_contribution_group: optional(text), note: optional(text) });
const relation = object({ type: enumeration("published_version_of", "extends", "related_to"), target_id: id, note: optional(text) });
const attachment = object({ id, role: enumeration("paper", "supplement", "slides", "video", "other"), label: optional(text), original_filename: regex(/^(?!\.{1,2}$)[^/\\\0]+$/, "invalid basename"), media_type: regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/, "invalid MIME type"), size_bytes: integer(0), storage: enumeration("git-lfs"), path, sha256: hash, source_url: optional(uri) });
export function validOrcid(v: unknown): boolean {
  if (typeof v !== "string" || !/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(v)) return false;
  const digits = v.replaceAll("-", ""); let total = 0;
  for (const c of digits.slice(0, 15)) total = (total + Number(c)) * 2;
  const check = (12 - total % 11) % 11; return digits[15] === (check === 10 ? "X" : String(check));
}
const isbn = rule((v) => { if (typeof v !== "string") return false; if (/^\d{9}[\dX]$/.test(v)) return [...v].reduce((s, c, i) => s + (c === "X" ? 10 : Number(c)) * (10 - i), 0) % 11 === 0; if (/^\d{13}$/.test(v)) return [...v].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0) % 10 === 0; return false; }, "invalid ISBN/checksum");
const identifiers = object({ doi: optional(regex(/^10\.\d{4,9}\/[^\sA-Z]+$/, "invalid normalized DOI")), arxiv: optional(regex(/^(?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z.-]*\/\d{2}(?:0[1-9]|1[0-2])\d{3})$/, "invalid normalized arXiv ID")), isbn: optional(isbn) });
const publication = object({ ...base, citation_key: key, gscholar_entry_id: optional(id), type: enumeration("arxiv", "conference", "workshop", "journal", "book-chapter", "thesis", "other"), title: text, authors: array(credit), authorship_note: optional(text), venue: optional(object({ name: text, venue_id: optional(id), event_year: optional(integer(1000, 9999)) })), publication_date: optional(date), submission_date: optional(date), acceptance_date: optional(date), online_date: optional(date), issued_date: optional(date), identifiers, arxiv_versions: optional(array(object({ version: integer(1), submission_date: date, source_review_id: optional(id) }), false, 1)), volume: optional(text), issue: optional(text), pages: optional(text), article_number: optional(text), urls: array(uri, true), tags: array(text, true), notes: optional(text), relations: array(relation), attachments: array(attachment), primary_attachment_id: optional(id), archived_at: optional(timestamp) });
const author = object({ ...base, author_key: key, preferred_name: text, name_parts: optional(nameParts), aliases: array(text, true), identifiers: object({ google_scholar: optional(text), orcid: optional(rule(validOrcid, "invalid ORCID")) }), identifier_aliases: optional(array(object({ provider: enumeration("google_scholar", "orcid"), value: text, note: optional(text) }), true)), disambiguation_note: optional(text), archived_at: optional(timestamp), merged_into: optional(id) });
const venue = object({ ...base, venue_key: key, kind: enumeration("journal", "conference", "workshop", "repository", "other"), preferred_name: text, abbreviation: optional(text), aliases: array(text, true), urls: array(uri, true), disambiguation_note: optional(text), archived_at: optional(timestamp), merged_into: optional(id) });
const sample = object({ observed_at: timestamp, count, estimated: optional(enumeration(true, false)), source_review_id: id });
const annual = object({ observed_at: timestamp, counts: { check: (v, p, e) => { if (!isObject(v)) { e.push(`${p}: expected counts object`); return; } for (const [k, n] of Object.entries(v)) { if (!/^\d{4}$/.test(k)) e.push(`${p}/${k}: invalid year`); count.check(n, `${p}/${k}`, e); } } }, source_review_id: id });
const scholar = object({ ...base, profile_id: text, scholar_id: text, title: text, authors: array(text), authors_text: optional(text), authors_completeness: coverage, venue: optional(text), year: optional(integer(1000, 9999)), publication_date: optional(text), volume: optional(text), issue: optional(text), pages: optional(text), publisher: optional(text), patent_office: optional(text), application_number: optional(text), description: optional(text), scholar_url: optional(uri), cited_by_url: optional(uri), matching: object({ policy: enumeration("eligible", "excluded"), reason: optional(text), decision_review_id: optional(id) }), first_seen_at: timestamp, last_seen_at: timestamp, presence: enumeration("present", "missing"), missing_since: optional(timestamp), source_review_id: id, citation_history: array(sample), annual_citations: optional(array(annual)) });
const target = object({ entity_type: enumeration("library", "publication", "author", "venue", "gscholar_profile", "gscholar_entry"), entity_id: optional(id) });
const proposal = object({ id, target, operation: enumeration("create", "replace", "remove", "link", "unlink", "archive", "restore", "merge"), path: optional(regex(/^(?:\/(?:[^~]|~[01])*)*$/, "invalid JSON Pointer")), expected_revision: optional(hash), current: optional(json), proposed: optional(json), candidate_ids: optional(array(id, true)), state: enumeration("pending", "accepted", "rejected", "deferred"), decided_at: optional(timestamp), decision_note: optional(text) });
const review = object({ ...base, summary: text, kind: enumeration("import", "change", "identity", "merge", "migration", "sync"), state: enumeration("pending", "accepted", "rejected", "deferred", "partially_accepted"), targets: array(target, true), source_review_id: optional(id), evidence: optional(object({ provider: text, captured_at: timestamp, source_reference: optional(text), payload: json, completeness: coverage, parser_version: text, input_fingerprint: hash })), proposals: array(proposal), decision_note: optional(text), decided_at: optional(timestamp) });
const profile = object({ schema_version: enumeration(2), profile_id: text, captures: array(object({ captured_at: timestamp, coverage, source_review_id: id, observed_entry_ids: array(id, true), totals: optional(object({ citations: optional(count), h_index: optional(count), i10_index: optional(count) })) })), created_at: timestamp, updated_at: timestamp });
const library = object({ ...base, name: text });
const owner = object({ schema_version: enumeration(2), self_author_id: optional(id) });
export const recordRules = { publication, author, venue, gscholar_entry: scholar, gscholar_profile: profile, review, library, owner };
export type RecordKind = keyof typeof recordRules;
export function recordIssues(kind: RecordKind, value: unknown, path?: string): ValidationIssue[] {
  const errors: string[] = []; recordRules[kind].check(value, "", errors);
  if (isObject(value)) {
    if (validTimestamp(value.created_at) && validTimestamp(value.updated_at) && value.updated_at < value.created_at) errors.push("updated_at precedes created_at");
    if (isObject(value.name_parts) && !Object.keys(value.name_parts).length) errors.push("empty name_parts");
    if (kind === "publication" && Array.isArray(value.authors)) for (const c of value.authors) if (isObject(c) && isObject(c.name_parts) && !Object.keys(c.name_parts).length) errors.push("empty credit name_parts");
  }
  return errors.map((message) => ({ severity: "error", code: "SCHEMA_INVALID", message, ...(path ? { path } : {}) }));
}
export function assertRecord(kind: RecordKind, value: unknown): void { const issues = recordIssues(kind, value); if (issues.length) throw new MyPubError(`Invalid ${kind}: ${issues.map((x) => x.message).join("; ")}`, "SCHEMA_INVALID", issues); }
export const publicationIssues = (v: unknown, p?: string): ValidationIssue[] => recordIssues("publication", v, p);
export function assertPublication(v: unknown): asserts v is Publication { assertRecord("publication", v); }
export function assertLibrary(v: unknown): asserts v is Library { assertRecord("library", v); }
export function assertReview(v: unknown): asserts v is Review { assertRecord("review", v); }
export function assertAuthor(v: unknown): asserts v is AuthorIdentity { assertRecord("author", v); }
export function assertVenue(v: unknown): asserts v is VenueIdentity { assertRecord("venue", v); }
export function assertScholar(v: unknown): asserts v is ScholarEntry { assertRecord("gscholar_entry", v); }
export function assertProfile(v: unknown): asserts v is ScholarProfile { assertRecord("gscholar_profile", v); }
export function assertOwner(v: unknown): asserts v is OwnerConfig { assertRecord("owner", v); }
export const asPublication = (v: unknown): Publication => { assertPublication(v); return v; };
export const asReview = (v: unknown): Review => { assertReview(v); return v; };
export function relationIssues(v: unknown): string[] { const e: string[] = []; relation.check(v, "", e); return e; }
export function attachmentIssues(v: unknown): string[] { const e: string[] = []; attachment.check(v, "", e); return e; }
export const isRelation = (v: unknown): v is Relation => !relationIssues(v).length;
export const isAttachment = (v: unknown): v is Attachment => !attachmentIssues(v).length;
