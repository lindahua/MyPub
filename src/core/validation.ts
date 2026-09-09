import type { AuditFinding, CatalogState, EntityType, Review, ValidationIssue, ValidationResult } from "./types.js";
import { recordIssues, validOrcid } from "./schemas.js";
import { fingerprint, normalizeArxiv, normalizeDoi } from "./utils.js";
import { scholarEntryIds } from "./scholar-links.js";

export function reviewState(review: Review): Review["state"] {
  if (!review.proposals.length) return review.state;
  const states = review.proposals.map((p) => p.state);
  if (states.every((s) => s === "accepted")) return "accepted";
  if (states.every((s) => s === "rejected")) return "rejected";
  if (states.some((s) => s === "accepted" || s === "rejected")) return "partially_accepted";
  if (states.every((s) => s === "deferred")) return "deferred";
  return "pending";
}
export function resolveIdentity<T extends { id: string; merged_into?: string }>(records: T[], id: string): T | undefined {
  const seen = new Set<string>(); let item = records.find((r) => r.id === id);
  while (item?.merged_into) { if (seen.has(item.id)) return undefined; seen.add(item.id); item = records.find((r) => r.id === item!.merged_into); }
  return item;
}
export function validateState(s: CatalogState): ValidationResult {
  const issues: ValidationIssue[] = [];
  const issue = (code: string, message: string, entity_id?: string, severity: "error" | "warning" = "error"): void => { issues.push({ code, message, severity, ...(entity_id ? { entity_id } : {}) }); };
  const collections = { publication: s.publications, author: s.authors, venue: s.venues, gscholar_entry: s.gscholar_entries, review: s.reviews };
  issues.push(...recordIssues("library", s.library), ...recordIssues("owner", s.owner));
  if (s.gscholar_profile) issues.push(...recordIssues("gscholar_profile", s.gscholar_profile));
  for (const [kind, rows] of Object.entries(collections)) for (const row of rows) issues.push(...recordIssues(kind as keyof typeof collections, row));
  if (issues.some((i) => i.severity === "error")) return { valid: false, issues, publication_count: s.publications.length };
  const allIds = new Set([s.library.id]);
  for (const rows of Object.values(collections)) for (const row of rows) { if (allIds.has(row.id)) issue("DUPLICATE_UUID", `Duplicate UUID ${row.id}`, row.id); allIds.add(row.id); }
  const reviews = new Map(s.reviews.map((r) => [r.id, r]));
  const reference = (id: string | undefined, kind: keyof typeof collections, owner: string): void => { if (id && !collections[kind].some((r) => r.id === id)) issue("BROKEN_REFERENCE", `${kind} ${id} does not exist`, owner); };
  const hasTarget = (type: EntityType, id?: string): boolean => type === "library" ? id === undefined : type === "gscholar_profile" ? id === undefined && !!s.gscholar_profile : !!id && collections[type].some((r) => r.id === id);
  function unique(values: Array<[string, string]>, code: string): void { const seen = new Map<string, string>(); for (const [v, id] of values) { if (seen.has(v)) issue(code, `Duplicate ${v}`, id); else seen.set(v, id); } }
  unique(s.publications.map((r) => [r.citation_key, r.id]), "DUPLICATE_CITATION_KEY");
  unique(s.authors.map((r) => [r.author_key, r.id]), "DUPLICATE_AUTHOR_KEY");
  unique(s.venues.map((r) => [r.venue_key, r.id]), "DUPLICATE_VENUE_KEY");
  unique(s.publications.filter((p) => p.identifiers.doi).map((p) => [normalizeDoi(p.identifiers.doi!), p.id]), "DUPLICATE_IDENTIFIER");
  unique(s.gscholar_entries.map((g) => [g.scholar_id.startsWith(`${g.profile_id}:`) ? g.scholar_id : `${g.profile_id}:${g.scholar_id}`, g.id]), "DUPLICATE_SCHOLAR_ID");
  const external: Array<[string, string]> = [];
  for (const a of s.authors) {
    if (a.aliases.includes(a.preferred_name)) issue("IDENTITY_ALIAS", "Alias repeats preferred name", a.id);
    for (const alias of a.identifier_aliases ?? []) if (alias.provider === "orcid" && !validOrcid(alias.value)) issue("ORCID_INVALID", "Invalid ORCID alias", a.id);
    for (const [provider, value] of Object.entries(a.identifiers)) if (value && /\s|:\/\//.test(value)) issue("IDENTIFIER_INVALID", "Use a normalized identifier, not a URL", a.id);
    if (!a.merged_into) { for (const [provider, value] of Object.entries(a.identifiers)) if (value) external.push([`${provider}:${value}`, a.id]); for (const alias of a.identifier_aliases ?? []) external.push([`${alias.provider}:${alias.value}`, a.id]); }
  }
  unique(external, "DUPLICATE_AUTHOR_IDENTIFIER");
  for (const [kind, rows] of [["author", s.authors], ["venue", s.venues]] as const) for (const r of rows) {
    if (r.aliases.includes(r.preferred_name)) issue("IDENTITY_ALIAS", "Alias repeats preferred name", r.id);
    if (r.merged_into) { reference(r.merged_into, kind, r.id); if (!r.archived_at || r.merged_into === r.id || !resolveIdentity(rows as Array<{ id: string; merged_into?: string }>, r.id)) issue("REDIRECT_INVALID", "Invalid merge tombstone or redirect cycle", r.id); }
  }
  for (const v of s.venues) unique(v.urls.map(link => [link.url, v.id]), "DUPLICATE_VENUE_URL");
  const owner = s.owner.self_author_id ? s.authors.find((a) => a.id === s.owner.self_author_id) : undefined;
  if (s.owner.self_author_id && (!owner || owner.merged_into)) issue("OWNER_INVALID", "self_author_id must identify a non-merged author");
  if (s.gscholar_profile && (!owner || ![owner.identifiers.google_scholar, ...(owner.identifier_aliases ?? []).filter((a) => a.provider === "google_scholar").map((a) => a.value)].includes(s.gscholar_profile.profile_id))) issue("PROFILE_OWNER", "Selected Scholar profile must be a confirmed owner identifier");
  const allAttachments: Array<[string, string]> = [];
  for (const p of s.publications) {
    reference(p.venue?.venue_id, "venue", p.id); scholarEntryIds(p).forEach(id => reference(id, "gscholar_entry", p.id));
    if (p.archived_at && scholarEntryIds(p).length) issue("ARCHIVED_SCHOLAR_LINK", "Archived publications cannot have confirmed Scholar links", p.id);
    if (p.venue && !p.venue.venue_id) issue("UNRESOLVED_VENUE", "Venue identity is unresolved", p.id, "warning");
    if (!p.authors.length) issue("EMPTY_BYLINE", "No authors recorded", p.id, "warning");
    const ids = new Set<string>();
    for (const c of p.authors) {
      reference(c.author_id, "author", p.id);
      const a = c.author_id ? resolveIdentity(s.authors, c.author_id) : undefined;
      if (a) { if (ids.has(a.id)) issue("REPEATED_AUTHOR", "Resolved person occurs in multiple credit slots", p.id); ids.add(a.id); if (a.archived_at) issue("ARCHIVED_AUTHOR", "Credit links to archived identity", p.id, "warning"); }
      else if (!c.author_id) issue("UNRESOLVED_AUTHOR", "Author identity is unresolved", p.id, "warning");
    }
    for (const role of ["co_first", "co_last"] as const) if (p.authors.filter((a) => a.roles?.includes(role)).length === 1) issue("SINGLETON_ROLE", `Only one ${role} credit`, p.id, "warning");
    for (const group of new Set(p.authors.flatMap((a) => a.equal_contribution_group ? [a.equal_contribution_group] : []))) if (p.authors.filter((a) => a.equal_contribution_group === group).length < 2) issue("SINGLETON_GROUP", `Only one credit in ${group}`, p.id, "warning");
    const pairs = new Set<string>();
    for (const r of p.relations) {
      reference(r.target_id, "publication", p.id); const pair = `${r.type}:${r.target_id}`;
      if (r.target_id === p.id) issue("SELF_RELATION", "Self relation", p.id);
      if (pairs.has(pair)) issue("DUPLICATE_RELATION", "Repeated relation", p.id); pairs.add(pair);
      if (r.type === "related_to" && s.publications.find((q) => q.id === r.target_id)?.relations.some((x) => x.type === r.type && x.target_id === p.id)) issue("DUPLICATE_RELATION", "Symmetric relation is stored twice", p.id);
    }
    for (const a of p.attachments) { allAttachments.push([a.id, p.id]); if (a.path !== `attachments/${p.id}/${a.id}/${a.original_filename}`) issue("ATTACHMENT_PATH", "Attachment path does not match containing IDs/filename", p.id); }
    if (p.primary_attachment_id && !p.attachments.some((a) => a.id === p.primary_attachment_id)) issue("PRIMARY_ATTACHMENT", "Primary attachment does not belong to publication", p.id);
    const revisions = p.arxiv_versions ?? [];
    if (p.type === "preprint" && (p.identifiers.arxiv || revisions.length)) {
      if (!p.identifiers.arxiv || !revisions.length) issue("ARXIV_HISTORY", "arXiv-backed preprints require an ID and complete version history", p.id);
      if (revisions.length && (p.publication_date !== revisions[0]!.submission_date || p.submission_date !== revisions[0]!.submission_date)) issue("ARXIV_FIRST_DATE", "Publication and submission dates must equal the v1 date", p.id);
      for (const [index, revision] of revisions.entries()) {
        if (revision.version !== index + 1 || !/^\d{4}-\d{2}-\d{2}$/.test(revision.submission_date) || !revision.title || !Array.isArray(revision.authors) || !revision.abstract) issue("ARXIV_HISTORY", "Store every version from v1 with its full date, title, ordered authors, and abstract", p.id);
        if (index && revision.submission_date < revisions[index - 1]!.submission_date) issue("ARXIV_REVISION", "Revision dates must not decrease", p.id);
      }
    }

    if (revisions.length && (p.type !== "preprint" || !p.submission_date || p.submission_date !== revisions.map((r) => r.submission_date).sort()[0])) issue("ARXIV_REVISION", "arXiv revisions require a preprint record and its original submission date", p.id);
    for (let i = 0; i < revisions.length; i++) { if (i && revisions[i]!.version <= revisions[i - 1]!.version) issue("ARXIV_REVISION", "Revision numbers must ascend", p.id); reference(revisions[i]!.source_review_id, "review", p.id); }
    if (p.submission_date && p.acceptance_date && p.submission_date > p.acceptance_date) issue("DATE_ORDER", "Acceptance predates submission", p.id, "warning");
  }
  unique(allAttachments, "DUPLICATE_ATTACHMENT_ID");
  for (const type of ["published_version_of", "extends"] as const) {
    const active = new Set<string>(); const done = new Set<string>(); const byId = new Map(s.publications.map((p) => [p.id, p]));
    const walk = (id: string): void => { if (active.has(id)) { issue("RELATION_CYCLE", `Cycle in ${type}`, id); return; } if (done.has(id)) return; active.add(id); for (const r of byId.get(id)?.relations ?? []) if (r.type === type) walk(r.target_id); active.delete(id); done.add(id); };
    for (const p of s.publications) walk(p.id);
  }
  const citationEvidence = (id: string, seen = new Set<string>()): boolean => { if (seen.has(id)) return false; seen.add(id); const r = reviews.get(id); return !!r && (r.evidence?.provider === "google_scholar" || !!r.source_review_id && citationEvidence(r.source_review_id, seen)); };
  for (const g of s.gscholar_entries) {
    if (g.profile_id !== s.gscholar_profile?.profile_id) issue("PROFILE_MEMBERSHIP", "Entry does not belong to selected profile", g.id);
    reference(g.source_review_id, "review", g.id); reference(g.matching.decision_review_id, "review", g.id);
    if (g.reviewed_corrections && !Object.keys(g.reviewed_corrections).length) issue("SCHOLAR_CORRECTION", "reviewed_corrections cannot be empty", g.id);
    for (const [field, reviewId] of Object.entries(g.reviewed_corrections ?? {})) {
      reference(reviewId, "review", g.id); const decision = reviews.get(reviewId);
      const accepted = decision?.state === "accepted" && decision.targets.some((target) => target.entity_type === "gscholar_entry" && target.entity_id === g.id) && decision.proposals.some((proposal) => {
        if (proposal.state !== "accepted" || proposal.target.entity_type !== "gscholar_entry" || proposal.target.entity_id !== g.id || proposal.path !== `/${field}`) return false;
        const value = (g as unknown as Record<string, unknown>)[field];
        return value === undefined ? proposal.operation === "remove" : Object.hasOwn(proposal, "proposed") && fingerprint(proposal.proposed) === fingerprint(value);
      });
      if (!accepted) issue("SCHOLAR_CORRECTION", `Reviewed correction for ${field} needs a matching accepted decision`, g.id);
    }
    if (Date.parse(g.last_seen_at) < Date.parse(g.first_seen_at)) issue("PRESENCE_TIME", "last_seen precedes first_seen", g.id);
    if ((g.presence === "absent") !== !!g.absent_since) issue("PRESENCE_STATE", "absent_since must accompany absent presence only", g.id);
    if (g.presence === "absent" && !s.gscholar_profile?.captures.some((c) => c.coverage === "complete" && c.captured_at === g.absent_since && Date.parse(c.captured_at) > Date.parse(g.last_seen_at) && !c.observed_entry_ids.includes(g.id))) issue("PRESENCE_EVIDENCE", "Absent state needs a newer complete capture", g.id);
    if (g.matching.policy === "excluded") {
      const decision = reviews.get(g.matching.decision_review_id ?? "");
      if (!g.matching.reason || !decision || !(decision.state === "accepted" || decision.proposals.some((p) => p.state === "accepted" && p.target.entity_id === g.id && p.path === "/matching"))) issue("EXCLUSION_DECISION", "Exclusion requires reason and accepted decision", g.id);
      if (s.publications.some((p) => scholarEntryIds(p).includes(g.id))) issue("EXCLUDED_LINK", "Excluded entry has confirmed publication links", g.id);
    }
    if (g.scholar_url) { const q = new URL(g.scholar_url).searchParams; const expected = g.scholar_id.startsWith(`${g.profile_id}:`) ? g.scholar_id : g.scholar_id.startsWith(`${g.profile_id}:`) ? g.scholar_id : `${g.profile_id}:${g.scholar_id}`; if (q.has("user") && q.get("user") !== g.profile_id || q.has("citation_for_view") && q.get("citation_for_view") !== expected) issue("SCHOLAR_URL", "URL identity disagrees with entry", g.id); }
    const captures = new Set<string>(); const counts = new Map<number, string>(); let previous = -Infinity;
    for (const sample of g.citation_history) {
      reference(sample.source_review_id, "review", g.id); if (!citationEvidence(sample.source_review_id)) issue("CITATION_SOURCE", "Citation evidence must originate from Google Scholar", g.id);
      const time = Date.parse(sample.observed_at); const key = `${time}:${sample.source_review_id}`;
      if (captures.has(key) || time < previous) issue("CITATION_ORDER", "Duplicate or out-of-order citation sample", g.id); captures.add(key); previous = time;
      const value = JSON.stringify([sample.count, sample.estimated ?? false]); if (counts.has(time) && counts.get(time) !== value) issue("CITATION_CONFLICT", "Conflicting counts for the same observation time", g.id); counts.set(time, value);
    }
    for (const a of g.annual_citations ?? []) { reference(a.source_review_id, "review", g.id); if (!citationEvidence(a.source_review_id)) issue("CITATION_SOURCE", "Annual counts need Scholar evidence", g.id); }
  }
  let previousCapture = -Infinity; const captureKeys = new Set<string>();
  for (const c of s.gscholar_profile?.captures ?? []) { reference(c.source_review_id, "review", "profile"); c.observed_entry_ids.forEach((id) => reference(id, "gscholar_entry", "profile")); const t = Date.parse(c.captured_at); const key = `${t}:${c.source_review_id}`; if (t < previousCapture || captureKeys.has(key)) issue("CAPTURE_ORDER", "Duplicate/out-of-order capture"); previousCapture = t; captureKeys.add(key); }
  for (const r of s.reviews) {
    reference(r.source_review_id, "review", r.id);
    if (r.source_review_id === r.id) issue("REVIEW_CYCLE", "Review references itself", r.id);
    let current: Review | undefined = r; const seen = new Set<string>(); while (current) { if (seen.has(current.id)) { issue("REVIEW_CYCLE", "Review reference cycle", r.id); break; } seen.add(current.id); current = current.source_review_id ? reviews.get(current.source_review_id) : undefined; }
    if (["import", "migration"].includes(r.kind) && !r.evidence && !r.source_review_id) issue("EVIDENCE_REQUIRED", "Import/migration requires evidence", r.id);
    if ((r.state === "accepted" || r.state === "rejected") !== !!r.decided_at || r.state !== reviewState(r)) issue("REVIEW_STATE", "Review state/decision time disagrees with proposals", r.id);
    const proposalIds = new Set<string>();
    for (const p of r.proposals) {
      if (proposalIds.has(p.id)) issue("DUPLICATE_PROPOSAL", "Duplicate proposal ID", r.id); proposalIds.add(p.id);
      if (!["library", "gscholar_profile"].includes(p.target.entity_type) && !p.target.entity_id) issue("REVIEW_TARGET", "Proposal target needs UUID", r.id);
      if ((p.state === "accepted" || p.state === "rejected") !== !!p.decided_at) issue("PROPOSAL_STATE", "Invalid proposal decision time", r.id);
      if (["replace", "remove", "link", "unlink"].includes(p.operation) !== (p.path !== undefined)) issue("PROPOSAL_PATH", "Invalid operation/path combination", r.id);
      if (["create", "replace", "link", "merge"].includes(p.operation) && !Object.hasOwn(p, "proposed")) issue("PROPOSAL_VALUE", "Missing proposed value", r.id);
      if (["remove", "unlink"].includes(p.operation) && !Object.hasOwn(p, "current")) issue("PROPOSAL_VALUE", "Missing current value", r.id);
      if (p.operation !== "create" && !p.expected_revision) issue("PROPOSAL_REVISION", "Existing-record proposal requires expected_revision", r.id);
      if (p.operation === "create" && p.proposed && typeof p.proposed === "object") {
        const type = p.target.entity_type;
        if (type in recordKind) {
          const proposed = type === "publication" && ["accepted", "rejected"].includes(p.state) && (p.proposed as { type?: unknown }).type === "arxiv"
            ? { ...p.proposed, type: "preprint" }
            : p.proposed;
          issues.push(...recordIssues(recordKind[type]!, proposed));
        }
      }
    }
    for (const t of r.targets) if (!hasTarget(t.entity_type, t.entity_id) && !r.proposals.some((p) => p.operation === "create" && p.target.entity_id === t.entity_id)) issue("REVIEW_TARGET", "Target must resolve or have a creation proposal", r.id);
  }
  return { valid: !issues.some((i) => i.severity === "error"), issues, publication_count: s.publications.length };
}
const recordKind = { library: "library", publication: "publication", author: "author", venue: "venue", gscholar_entry: "gscholar_entry", gscholar_profile: "gscholar_profile" } as const;
export function auditState(s: CatalogState): AuditFinding[] {
  const groups = new Map<string, string[]>(); for (const p of s.publications) if (p.identifiers.arxiv) { const key = normalizeArxiv(p.identifiers.arxiv); groups.set(key, [...(groups.get(key) ?? []), p.id]); }
  return [...groups].filter(([, ids]) => ids.length > 1).map(([identifier, publication_ids]) => ({ code: "duplicate_arxiv_id", severity: "error", blocks_write: false, identifier, publication_ids: publication_ids.sort() }));
}
export function assertUnchangedEvidence(before: CatalogState, after: CatalogState): void {
  for (const previous of before.reviews) { const next = after.reviews.find((r) => r.id === previous.id); if (!next || fingerprint(previous.evidence ?? null) !== fingerprint(next.evidence ?? null)) throw new Error(`Review evidence is immutable: ${previous.id}`); }
}
