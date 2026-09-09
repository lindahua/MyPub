import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isObject, recordIssues, validDate, validUuid } from "./schemas.js";
import type { RecordKind } from "./schemas.js";
import type { CatalogState, Publication, ScholarEntry } from "./types.js";
import { auditState, resolveIdentity, validateState } from "./validation.js";
import { catalogFiles, publicationYear } from "./paths.js";
import { scholarEntryIds } from "./scholar-links.js";

export interface RepoAuditFinding {
  code: string; severity: "error" | "warning"; aspect: string; message: string;
  paths: string[]; record_ids: string[]; field?: string; values?: unknown; blocks_write?: false;
}
export interface AuditResult {
  complete: boolean; counts_complete: boolean;
  files: { discovered: number; parsed: number; unreadable: number };
  records: Record<string, number>; skipped: Array<{ path: string; check: string; reason: string }>;
  statistics: Record<string, number>;
  cross_tab: Array<{ publication_type: string; scholar_pub_type: string; count: number }>;
  errors: number; warnings: number;
  by_rule: Record<string, { errors: number; warnings: number }>;
  by_aspect: Record<string, { errors: number; warnings: number }>;
  findings: RepoAuditFinding[];
}
type Row = { kind: RecordKind; path: string; value: Record<string, unknown>; valid: boolean };
const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const namesMatch = (a: string, b: string): boolean => {
  const x = norm(a).split(" "), y = norm(b).split(" ");
  return x.length === y.length && x.every((t, i) => t === y[i] || ((t.length === 1 || y[i]!.length === 1) && t[0] === y[i]![0]));
};
const bylineMatch = (a: string[], b: string[], partial = false): boolean => {
  if (!partial) return a.length === b.length && a.every((n, i) => namesMatch(n, b[i]!));
  let at = 0;
  for (const name of b.filter(n => !/…|\.\.\.|et al/i.test(n))) {
    while (at < a.length && !namesMatch(a[at]!, name)) at++;
    if (at === a.length) return false;
    at++;
  }
  return true;
};
function interval(s: string): [string, string] {
  return [s.length === 4 ? `${s}-01-01` : s.length === 7 ? `${s}-01` : s,
    s.length === 4 ? `${s}-12-31` : s.length === 7 ? `${s}-${new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5)), 0)).getUTCDate()}` : s];
}

/** JSON.parse discards repeated keys; tokenize the already syntax-checked source first. */
export function duplicateJsonKeys(source: string): string[] {
  const tokens = source.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? [];
  let i = 0; const duplicates: string[] = [];
  function value(path: string): void {
    const t = tokens[i++];
    if (t === "{") {
      const seen = new Set<string>();
      while (tokens[i] !== "}") {
        const key = JSON.parse(tokens[i++]!) as string; i++;
        const child = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
        if (seen.has(key)) duplicates.push(child); seen.add(key); value(child);
        if (tokens[i] !== ",") break; i++;
      }
      i++;
    } else if (t === "[") {
      let index = 0;
      while (tokens[i] !== "]") { value(`${path}/${index++}`); if (tokens[i] !== ",") break; i++; }
      i++;
    }
  }
  value(""); return duplicates;
}

/** Read-only, tolerant inspection: never uses Catalog.read or its writable index. */
export async function auditRepository(root: string): Promise<AuditResult> {
  const result: AuditResult = { complete: true, counts_complete: true, files: { discovered: 0, parsed: 0, unreadable: 0 }, records: {}, skipped: [], statistics: {}, cross_tab: [], errors: 0, warnings: 0, by_rule: {}, by_aspect: {}, findings: [] };
  const rows: Row[] = []; const sources = new Map<string, string>();
  const directories = new Map<string, string>();
  const add = (code: string, severity: "error" | "warning", message: string, owners: Row[] = [], field?: string, values?: unknown, aspect?: string): void => {
    result.findings.push({ code, severity, message, paths: owners.map(r => r.path).sort(), record_ids: [...new Set(owners.flatMap(r => typeof r.value.id === "string" ? [r.value.id] : []))].sort(), aspect: aspect ?? owners[0]?.kind ?? "repository", ...(field ? { field } : {}), ...(values !== undefined ? { values } : {}) });
  };
  const failure = (path: string, error: unknown): void => {
    result.complete = false; result.counts_complete = false; result.files.unreadable++;
    add("AUDIT_READ_FAILED", "error", String(error), [{ path, kind: "library", value: {}, valid: false }]);
    result.skipped.push({ path, check: "read", reason: "Unavailable source" });
  };
  async function file(path: string, kind: RecordKind, optional = false): Promise<void> {
    let source: string;
    try { const info = await lstat(join(root, path)); result.files.discovered++; if (info.isSymbolicLink() || !info.isFile()) throw new Error("Expected regular catalog file, not a symlink"); source = await readFile(join(root, path), "utf8"); }
    catch (e) { if (optional && (e as NodeJS.ErrnoException).code === "ENOENT") return; failure(path, e); return; }
    sources.set(path, source);
    let value: unknown;
    try { value = JSON.parse(source); } catch (e) { result.counts_complete = false; add("INVALID_JSON", "error", String(e), [{ path, kind, value: {}, valid: false }]); result.skipped.push({ path, check: "record", reason: "Invalid JSON" }); return; }
    result.files.parsed++; result.records[kind] = (result.records[kind] ?? 0) + 1;
    const row: Row = { path, kind, value: isObject(value) ? value : {}, valid: true }; rows.push(row);
    const issues = recordIssues(kind, value);
    for (const issue of issues) add(issue.code, issue.severity, issue.message, [row], issue.message.startsWith("/") ? issue.message.split(":")[0] : undefined);
    for (const field of duplicateJsonKeys(source)) { add("DUPLICATE_JSON_KEY", "error", "Repeated JSON property", [row], field); row.valid = false; }
    if (issues.length) row.valid = false;
    if (!row.valid) { result.counts_complete = false; result.skipped.push({ path, check: "semantic comparisons", reason: "Structurally invalid record" }); }
  }
  async function walk(path: string, kind: RecordKind): Promise<void> {
    try {
      if ((await lstat(join(root, path))).isSymbolicLink()) throw new Error("Catalog symlink is not permitted");
      const entries = (await readdir(join(root, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      directories.set(path, JSON.stringify(entries.map(e => e.name)));
      for (const e of entries) {
        const child = `${path}/${e.name}`;
        if (e.isDirectory()) await walk(child, kind);
        else if (e.name.endsWith(".json") || e.isSymbolicLink()) await file(child, kind);
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") failure(path, e); }
  }
  await file("catalog/library.json", "library"); await file("catalog/config/author.json", "owner"); await file("catalog/gscholar/profile.json", "gscholar_profile", true);
  for (const [dir, kind] of [["publications", "publication"], ["authors", "author"], ["venues", "venue"], ["reviews", "review"], ["gscholar/entries", "gscholar_entry"]] as const) await walk(`catalog/${dir}`, kind);
  const groups = new Map<string, Row[]>();
  for (const r of rows) if (validUuid(r.value.id)) groups.set(r.value.id, [...(groups.get(r.value.id) ?? []), r]);
  for (const [id, group] of groups) if (group.length > 1) { add("DUPLICATE_UUID", "error", `Duplicate UUID ${id}`, group); result.counts_complete = false; for (const row of group) result.skipped.push({ path: row.path, check: "semantic comparisons", reason: "Ambiguous UUID" }); }
  const usable = rows.filter(r => r.valid && (!r.value.id || groups.get(String(r.value.id))?.length === 1));
  const collection = (kind: RecordKind) => usable.filter(r => r.kind === kind).map(r => r.value);
  const state = { library: collection("library")[0], owner: collection("owner")[0], publications: collection("publication"), authors: collection("author"), venues: collection("venue"), reviews: collection("review"), gscholar_entries: collection("gscholar_entry"), ...(collection("gscholar_profile")[0] ? { gscholar_profile: collection("gscholar_profile")[0] } : {}) } as unknown as CatalogState;
  const ownerRows = (...ids: string[]): Row[] => ids.flatMap(id => groups.get(id) ?? []);
  const warn = (code: string, message: string, id: string, field?: string) => add(code, "warning", message, ownerRows(id), field);
  const groupedUniqueRules = new Set(["DUPLICATE_CITATION_KEY", "DUPLICATE_IDENTIFIER", "DUPLICATE_SCHOLAR_ID"]);
  for (const [code, field, pairs] of [
    ["DUPLICATE_CITATION_KEY", "/citation_key", state.publications.map(p => [p.citation_key, p.id])],
    ["DUPLICATE_IDENTIFIER", "/identifiers/doi", state.publications.filter(p => p.identifiers.doi).map(p => [p.identifiers.doi!, p.id])],
    ["DUPLICATE_SCHOLAR_ID", "/scholar_id", state.gscholar_entries.map(g => [g.scholar_id.startsWith(`${g.profile_id}:`) ? g.scholar_id : `${g.profile_id}:${g.scholar_id}`, g.id])],
  ] as const) {
    const grouped = new Map<string, string[]>();
    for (const [key, id] of pairs) grouped.set(key!, [...(grouped.get(key!) ?? []), id!]);
    for (const [key, ids] of grouped) if (ids.length > 1) add(code, "error", `Duplicate ${key}`, ownerRows(...ids), field, key);
  }
  if (state.library && state.owner) {
    const invalidIds = new Set(rows.filter(r => !usable.includes(r)).map(r => r.value.id));
    for (const issue of validateState(state).issues) {
      if (issue.code === "DATE_ORDER") continue; // Precision-aware checks below.
      if (groupedUniqueRules.has(issue.code)) continue;
      const owners = issue.entity_id ? ownerRows(issue.entity_id) : usable.filter(r => ["library", "owner", "gscholar_profile"].includes(r.kind));
      if (issue.severity === "warning" && owners.some(r => r.value.archived_at) && ["EMPTY_BYLINE", "UNRESOLVED_AUTHOR", "UNRESOLVED_VENUE"].includes(issue.code)) continue;
      if (issue.code === "BROKEN_REFERENCE" && issue.message.startsWith("gscholar_entry") && owners.some(r => r.kind === "publication")) continue;
      if (issue.code === "BROKEN_REFERENCE" && [...invalidIds].some(id => typeof id === "string" && issue.message.includes(id))) {
        add("AMBIGUOUS_REFERENCE", "error", issue.message.replace("does not exist", "is invalid or ambiguous"), owners); continue;
      }
      add(issue.code, issue.severity, issue.message, owners);
    }
    for (const f of auditState(state)) {
      add(f.code, "error", `Duplicate arXiv identifier ${f.identifier}`, ownerRows(...f.publication_ids), "/identifiers/arxiv", f.identifier);
      result.findings.at(-1)!.blocks_write = false;
    }
    for (const [path, value] of catalogFiles(state)) {
      const row = usable.find(r => r.value === value);
      if (row && row.path !== path) warn("PATH_MISMATCH", `Expected ${path}`, String(row.value.id));
    }
  } else { result.counts_complete = false; result.skipped.push({ path: "catalog", check: "structural cross-record validation", reason: "Invalid library or owner configuration" }); }

  for (const p of state.publications) {
    if (!p.archived_at) {
      const missing = (test: boolean, code: string, field: string) => { if (test) warn(code, `Missing expected ${field}`, p.id, `/${field}`); };
      missing(!p.publication_date, "PUB_MISSING_DATE", "publication_date");
      missing(["journal", "conference", "workshop", "book-chapter"].includes(p.type) && !p.venue, "PUB_MISSING_VENUE", "venue");
      missing(p.type === "journal" && !p.volume, "PUB_MISSING_VOLUME", "volume");
      missing(p.type === "journal" && !p.pages && !p.article_number, "PUB_MISSING_PAGES", "pages or article_number");
      missing(p.type === "journal" && !p.identifiers.doi, "PUB_MISSING_DOI", "identifiers/doi");
      missing(p.type === "book-chapter" && !p.identifiers.doi && !p.identifiers.isbn, "PUB_MISSING_BOOK_IDENTIFIER", "DOI or ISBN");
      missing(!Object.values(p.identifiers).length && !p.official_url && !p.paper_url, "PUB_MISSING_LOCATOR", "identifier or URL");
    }
    const venue = p.venue?.venue_id ? resolveIdentity(state.venues, p.venue.venue_id) : undefined;
    if (venue?.archived_at) warn("ARCHIVED_VENUE", "Venue identity is archived", p.id, "/venue");
    const expected = p.type === "preprint" ? "repository" : p.type;
    if (venue && ["journal", "conference", "workshop", "repository"].includes(expected) && venue.kind !== "other" && venue.kind !== expected) add("PUB_VENUE_TYPE", "error", "Publication type conflicts with venue kind", ownerRows(p.id, venue.id), "/venue", [p.type, venue.kind]);
    for (const r of p.relations) if (r.type === "published_version_of") {
      const target = state.publications.find(q => q.id === r.target_id);
      if (target && (!["journal", "conference", "workshop"].includes(p.type) || target.type !== "preprint")) add("PUB_RELATION_TYPE", "error", "Published version must point from a journal/conference/workshop to a preprint", ownerRows(p.id, target.id), "/relations");
    }
    if (p.type === "journal" && p.publication_date && p.issued_date && p.publication_date.slice(0, Math.min(p.publication_date.length, p.issued_date.length)) !== p.issued_date.slice(0, Math.min(p.publication_date.length, p.issued_date.length))) add("PUB_ISSUE_DATE", "error", "Issue and publication dates disagree", ownerRows(p.id), "/publication_date", [p.publication_date, p.issued_date]);
    for (const [a, b] of [[p.submission_date, p.acceptance_date], [p.acceptance_date, p.publication_date]]) if (a && b && interval(a)[0] > interval(b)[1]) warn("DATE_ORDER", `Date ${b} definitely precedes ${a}`, p.id);
    const latest = p.arxiv_versions?.at(-1);
    if (latest && (!latest.title || !latest.authors || !latest.abstract)) result.skipped.push({ path: ownerRows(p.id)[0]!.path, check: "current arXiv metadata", reason: "Incomplete latest revision metadata; only available fields compared" });
    if (latest && (latest.title && norm(p.title) !== norm(latest.title) || latest.authors && JSON.stringify(p.authors.map(a => norm(a.name))) !== JSON.stringify(latest.authors.map(norm)) || p.abstract && latest.abstract && norm(p.abstract) !== norm(latest.abstract))) add("ARXIV_CURRENT_VERSION", "error", "Current metadata disagrees with latest stored arXiv version", ownerRows(p.id), "/arxiv_versions");
  }
  for (const g of state.gscholar_entries) {
    if (g.matching.policy !== "excluded") {
      for (const [missing, code, field] of [[!g.pub_type, "SCHOLAR_MISSING_TYPE", "pub_type"], [!g.authors.length, "SCHOLAR_EMPTY_AUTHORS", "authors"], [g.authors_completeness !== "complete", "SCHOLAR_PARTIAL_AUTHORS", "authors_completeness"], [!g.year, "SCHOLAR_MISSING_YEAR", "year"], [!g.venue && ["journal", "conference", "workshop", "preprint"].includes(g.pub_type ?? ""), "SCHOLAR_MISSING_VENUE", "venue"], [!g.scholar_url, "SCHOLAR_MISSING_URL", "scholar_url"], [!g.citation_history.length, "SCHOLAR_EMPTY_CITATIONS", "citation_history"]] as const) if (missing) warn(code, `Missing or incomplete ${field}`, g.id, `/${field}`);
    }
    if (g.pub_type === "incomplete" && g.matching.policy !== "excluded") add("SCHOLAR_INCOMPLETE_ELIGIBLE", "error", "Incomplete Scholar entry must be excluded", ownerRows(g.id), "/matching");
    if (g.scholar_id.includes(":") && g.scholar_id.split(":")[0] !== g.profile_id) add("SCHOLAR_PROFILE_PREFIX", "error", "Scholar ID prefix disagrees with profile", ownerRows(g.id), "/scholar_id");
    if (g.authors_completeness === "complete" && (!g.authors.length || g.authors.some(a => /…|\.\.\.|\bet al\b/i.test(a)))) warn("SCHOLAR_COMPLETE_BYLINE", "Complete byline is empty or truncated", g.id, "/authors");
    const sourceDate = g.publication_date?.split(/[-/]/).map((s, i) => i ? s.padStart(2, "0") : s).join("-");
    if (g.year && sourceDate && validDate(sourceDate) && Number(sourceDate.slice(0, 4)) !== g.year) warn("SCHOLAR_YEAR_DATE", "Source date and year disagree", g.id, "/publication_date");
  }
  const linkedPubs = new Set<string>(), linkedEntries = new Set<string>(), refs = new Map<string, Set<string>>(), cross = new Map<string, number>(); let links = 0;
  for (const row of rows.filter(r => r.kind === "publication")) {
    const raw = row.value.gscholar_entry_id;
    const ids = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
    for (const id of new Set(ids)) {
      const owners = refs.get(id) ?? new Set<string>(); if (validUuid(row.value.id)) owners.add(row.value.id); refs.set(id, owners);
      const targets = rows.filter(r => r.kind === "gscholar_entry" && r.value.id === id);
      if (!targets.length) add("LINK_MISSING", "error", "Scholar link target is missing", [row], "/gscholar_entry_id", id, "links");
      if (targets.length === 1 && !targets[0]!.valid) add("LINK_INVALID_TARGET", "error", "Scholar link target is structurally invalid", [row, targets[0]!], "/gscholar_entry_id", id, "links");
      if ((groups.get(id)?.length ?? 0) > 1) add("LINK_AMBIGUOUS", "error", "Scholar link target is ambiguous", [row, ...groups.get(id)!], "/gscholar_entry_id", id, "links");
      if (!row.valid || targets.length !== 1 || !targets[0]!.valid || groups.get(id)?.length !== 1 || groups.get(String(row.value.id))?.length !== 1) { result.skipped.push({ path: row.path, check: `link ${id}`, reason: "Invalid, missing or ambiguous endpoint" }); continue; }
      const p = row.value as unknown as Publication, g = targets[0]!.value as unknown as ScholarEntry;
      links++; linkedPubs.add(p.id); linkedEntries.add(g.id); const key = `${p.type}:${g.pub_type ?? "(missing)"}`; cross.set(key, (cross.get(key) ?? 0) + 1);
      const finding = (code: string, severity: "error" | "warning", message: string, field: string, values?: unknown) => add(code, severity, message, [row, targets[0]!], field, values, "links");
      if (g.presence === "absent") finding("LINK_ABSENT", "warning", "Linked Scholar entry is absent", "/presence");
      if (g.pub_type) { if (["other", "book-chapter"].includes(p.type)) finding("LINK_TYPE_REVIEW", "warning", "No exact Scholar type correspondence", "/type", [p.type, g.pub_type]); else if (p.type !== g.pub_type) finding("LINK_TYPE", "error", "Linked types disagree", "/type", [p.type, g.pub_type]); }
      else result.skipped.push({ path: row.path, check: `type ${id}`, reason: "Missing Scholar classification" });
      const versions = p.arxiv_versions ?? [];
      if (![p.title, ...versions.flatMap(v => v.title ? [v.title] : [])].some(title => norm(title) === norm(g.title))) finding("LINK_TITLE", "warning", "No stored title variant matches", "/title", [p.title, g.title]);
      const partial = g.authors_completeness !== "complete";
      const names = g.authors.filter(n => !partial || !/…|\.\.\.|et al/i.test(n));
      let position = 0;
      const identityMatch = names.every(name => {
        while (position < p.authors.length) {
          const credit = p.authors[position++]!;
          const identity = credit.author_id ? resolveIdentity(state.authors, credit.author_id) : undefined;
          if ([credit.name, ...(identity ? [identity.preferred_name, ...identity.aliases] : [])].some(n => namesMatch(n, name))) return true;
          if (!partial) return false;
        }
        return false;
      }) && (partial || names.length === p.authors.length);
      if (p.authors.length && g.authors.length && !identityMatch && !versions.some(v => v.authors && bylineMatch(v.authors, g.authors, partial))) finding("LINK_AUTHORS", "warning", "Comparable bylines disagree", "/authors", [p.authors.map(a => a.name), g.authors]);
      for (const [check, available] of [["authors", p.authors.length && g.authors.length], ["year", publicationYear(p) && g.year], ["venue", p.venue && g.venue], ["volume", p.volume && g.volume], ["issue", p.issue && g.issue], ["pages", (p.pages ?? p.article_number) && g.pages]] as const) if (!available) result.skipped.push({ path: row.path, check: `${check} ${id}`, reason: "Missing comparison input" });
      const year = publicationYear(p); if (year && g.year && year !== g.year) finding("LINK_YEAR", "warning", "Bibliographic years disagree", "/publication_date", [year, g.year]);
      const v = p.venue?.venue_id ? resolveIdentity(state.venues, p.venue.venue_id) : undefined;
      const venues = [p.venue?.name, v?.preferred_name, v?.abbreviation, ...(v?.aliases ?? [])].filter((x): x is string => !!x);
      if (g.venue && venues.length && !venues.some(n => (` ${norm(g.venue!)} `).includes(` ${norm(n)} `))) finding("LINK_VENUE", "warning", "Venue names disagree", "/venue", [venues, g.venue]);
      for (const field of ["volume", "issue", "pages"] as const) { const a = field === "pages" ? p.pages ?? p.article_number : p[field]; if (a && g[field] && norm(a) !== norm(g[field]!)) finding(`LINK_${field.toUpperCase()}`, "warning", `${field} disagree`, `/${field}`, [a, g[field]]); }
      for (const url of [g.scholar_url, g.cited_by_url].filter((x): x is string => !!x)) {
        const u = new URL(url); let pathname = u.pathname; try { pathname = decodeURIComponent(pathname); } catch { /* Malformed percent escapes cannot establish an identifier. */ }
        const doi = /^(?:dx\.)?doi\.org$/i.test(u.hostname) ? pathname.slice(1).toLowerCase() : undefined;
        const arxiv = /^(?:www\.)?arxiv\.org$/i.test(u.hostname) ? u.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/)?.[1]?.replace(/v\d+$/, "") : undefined;
        if ((doi && p.identifiers.doi && doi !== p.identifiers.doi.toLowerCase()) || (arxiv && p.identifiers.arxiv && arxiv !== p.identifiers.arxiv)) finding("LINK_IDENTIFIER", "error", "Explicit source URL identifier contradicts publication", "/identifiers", [p.identifiers, url]);
      }
    }
  }
  for (const [id, owners] of refs) if (owners.size > 1) add("SCHOLAR_MULTIPLE_PUBLICATIONS", "error", "Scholar entry is associated with multiple publications", ownerRows(id, ...owners), "/gscholar_entry_id", { scholar_entry_id: id, publication_ids: [...owners].sort() }, "cardinality");
  const titles = new Map<string, Publication[]>();
  for (const p of state.publications.filter(p => !p.archived_at)) { const key = `${p.type}:${norm(p.title)}`; for (const q of titles.get(key) ?? []) if (p.publication_date && q.publication_date && interval(p.publication_date)[0] <= interval(q.publication_date)[1] && interval(q.publication_date)[0] <= interval(p.publication_date)[1] && p.authors.length && bylineMatch(p.authors.map(a => a.name), q.authors.map(a => a.name)) && !Object.entries(p.identifiers).some(([k, v]) => q.identifiers[k as keyof typeof q.identifiers] === v)) add("PUB_POSSIBLE_DUPLICATE", "warning", "Same type, title, byline and overlapping date", ownerRows(q.id, p.id)); titles.set(key, [...(titles.get(key) ?? []), p]); }
  result.statistics = { publications: result.records.publication ?? 0, scholar_entries: result.records.gscholar_entry ?? 0, links, linked_publications: linkedPubs.size, linked_scholar_entries: linkedEntries.size, unlinked_publications: state.publications.filter(p => !scholarEntryIds(p).length).length, unlinked_scholar_entries: state.gscholar_entries.filter(g => !refs.has(g.id)).length, archived_publications: state.publications.filter(p => p.archived_at).length, excluded_scholar_entries: state.gscholar_entries.filter(g => g.matching.policy === "excluded").length, absent_scholar_entries: state.gscholar_entries.filter(g => g.presence === "absent").length };
  result.cross_tab = [...cross].sort().map(([key, count]) => ({ publication_type: key.split(":")[0]!, scholar_pub_type: key.split(":")[1]!, count }));
  for (const [path, source] of sources) {
    try { if (await readFile(join(root, path), "utf8") !== source) { result.complete = false; result.counts_complete = false; add("AUDIT_SOURCE_CHANGED", "error", "Source changed during audit; rerun for consistent results", rows.filter(r => r.path === path)); } }
    catch (e) { failure(path, e); }
  }
  for (const [path, entries] of directories) {
    try { if (JSON.stringify((await readdir(join(root, path))).sort((a, b) => a.localeCompare(b))) !== entries) { result.complete = false; result.counts_complete = false; add("AUDIT_SOURCE_CHANGED", "error", "Directory changed during audit; rerun", [{ path, kind: "library", value: {}, valid: false }]); } }
    catch (e) { failure(path, e); }
  }
  result.findings = [...new Map(result.findings.map(f => [JSON.stringify(f), f])).values()].sort((a, b) => a.severity.localeCompare(b.severity) || a.code.localeCompare(b.code) || a.paths.join().localeCompare(b.paths.join()));
  for (const f of result.findings) { const key = f.severity === "error" ? "errors" : "warnings"; result[key]++; for (const [map, name] of [[result.by_rule, f.code], [result.by_aspect, f.aspect]] as const) { map[name] ??= { errors: 0, warnings: 0 }; map[name][key]++; } }
  return result;
}
