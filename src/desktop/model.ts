import type {
  AuthorCredit,
  AuthorIdentity,
  Publication,
  ScholarEntry,
  VenueIdentity,
} from "../core/types.js";
import { publicationDate, publicationYear } from "../core/dates.js";
import { scholarEntryIds } from "../core/scholar-links.js";
import type { Collection, Snapshot } from "./types.js";
export type Value = string | number | null | string[];
export interface Row {
  id: string;
  label: string;
  sub: string;
  fields: Record<string, Value>;
  search: string;
  publicationIds: string[];
}
export type Operator =
  | "is"
  | "is not"
  | "contains"
  | "at least"
  | "at most"
  | "between"
  | "known"
  | "unknown";
export interface Rule {
  kind: "rule";
  id: string;
  field: string;
  operator: Operator;
  value: string;
  upper: string;
  role: string;
  includeUnknown: boolean;
}
export interface Group {
  kind: "group";
  id: string;
  mode: "all" | "any";
  scope: "record" | "related";
  children: Expression[];
}
export type Expression = Rule | Group;
export const emptyGroup = (): Group => ({
  kind: "group",
  id: crypto.randomUUID(),
  mode: "all",
  scope: "record",
  children: [],
});
export const newRule = (field = "year", value = ""): Rule => ({
  kind: "rule",
  id: crypto.randomUUID(),
  field,
  operator: "is",
  value,
  upper: "",
  role: "",
  includeUnknown: false,
});
export const normalize = (s: string): string =>
  s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
export const searchMatches = (text: string, query: string): boolean =>
  (query.match(/"[^"]*"|\S+/g) ?? []).every((term) =>
    text.includes(normalize(term.replace(/^"|"$/g, ""))),
  );
export const yearOf = (p: Publication): number | null =>
  publicationYear(p) ?? null;
export function resolved<T extends { id: string; merged_into?: string }>(
  map: Map<string, T>,
  id?: string,
): T | undefined {
  const seen = new Set<string>();
  let record = id ? map.get(id) : undefined;
  while (record?.merged_into && !seen.has(record.id)) {
    seen.add(record.id);
    record = map.get(record.merged_into);
  }
  return record;
}
export function roleMatches(
  credit: AuthorCredit,
  position: number,
  role: string,
): boolean {
  return (
    !role ||
    (role === "first_listed"
      ? position === 0
      : role === "first"
        ? position === 0 || !!credit.roles?.includes("co_first")
        : !!credit.roles?.some((r) => r === role))
  );
}
export class ViewModel {
  authors: Map<string, AuthorIdentity>;
  venues: Map<string, VenueIdentity>;
  publications: Map<string, Publication>;
  scholar: Map<string, ScholarEntry>;
  rows: Record<Collection, Row[]>;
  constructor(readonly snapshot: Snapshot) {
    const s = snapshot.state;
    this.authors = new Map(s.authors.map((a) => [a.id, a]));
    this.venues = new Map(s.venues.map((v) => [v.id, v]));
    this.publications = new Map(s.publications.map((p) => [p.id, p]));
    this.scholar = new Map(s.gscholar_entries.map((g) => [g.id, g]));
    const publicationRows: Row[] = s.publications.map((p) => {
      const authors = p.authors.flatMap((a) => {
        const person = resolved(this.authors, a.author_id);
        return person ? [person] : [];
      });
      const venue = resolved(this.venues, p.venue?.venue_id),
        entries = scholarEntryIds(p).flatMap(id => this.scholar.get(id) ?? []),
        counts = entries.map(entry => entry.citation_history.at(-1)?.count ?? null),
        citationCount = !counts.length || counts.some(count => count === null) ? null : counts.reduce<number>((sum, count) => sum + count!, 0);
      const fileStates = p.attachments.map(
        (a) => snapshot.availability[a.id] ?? "error",
      );
      const fields = {
        year: yearOf(p),
        date: publicationDate(p) ?? null,
        venue: venue?.id ?? null,
        venue_text: p.venue?.name ?? null,
        type: p.type,
        author: authors.map((a) => a.id),
        tag: p.tags,
        citations: citationCount,
        link: entries.length ? "linked" : "unlinked",
        doi: p.identifiers.doi ?? null,
        arxiv: p.identifiers.arxiv ?? null,
        files: p.attachments.length ? fileStates : ["none"],
        archive: p.archived_at ? "archived" : "active",
        updated: p.updated_at,
        title: p.title,
        role: p.authors.flatMap((a, i) => [
          ...(a.roles ?? []),
          ...(i === 0
            ? ["first_listed", "first"]
            : a.roles?.includes("co_first")
              ? ["first"]
              : []),
        ]),
      };
      return {
        id: p.id,
        label: p.title,
        sub: p.authors.map((a) => a.name).join(", "),
        fields,
        publicationIds: [p.id],
        search: normalize(
          [
            p.title,
            p.citation_key,
            ...Object.values(p.identifiers),
            ...p.authors.map((a) => a.name),
            ...authors.flatMap((a) => [
              a.preferred_name,
              a.author_key,
              ...a.aliases,
            ]),
            p.venue?.name,
            venue?.preferred_name,
            venue?.abbreviation,
            ...(venue?.aliases ?? []),
            ...p.tags,
          ]
            .filter(Boolean)
            .join(" "),
        ),
      };
    });
    const active = publicationRows.filter((p) => p.fields.archive === "active");
    const authorRows: Row[] = s.authors.map((a) => {
      const id = resolved(this.authors, a.id)?.id ?? a.id;
      const pubs = active.filter((p) =>
        (p.fields.author as string[]).includes(id),
      );
      const credits = pubs.flatMap((p) =>
        this.publications
          .get(p.id)!
          .authors.filter((c) => resolved(this.authors, c.author_id)?.id === id)
          .map((c) => c.name),
      );
      return {
        id: a.id,
        label: a.preferred_name,
        sub: [a.author_key, a.disambiguation_note].filter(Boolean).join(" · "),
        publicationIds: pubs.map((p) => p.id),
        fields: {
          name: a.preferred_name,
          publications: pubs.length,
          orcid: a.identifiers.orcid ?? null,
          profile: a.identifiers.google_scholar ?? null,
          archive: a.merged_into
            ? "merged"
            : a.archived_at
              ? "archived"
              : "active",
          year: this.latestYear(pubs),
          updated: a.updated_at,
        },
        search: normalize(
          [
            a.preferred_name,
            a.author_key,
            ...a.aliases,
            ...credits,
            a.disambiguation_note,
            ...Object.values(a.identifiers),
            ...(a.identifier_aliases ?? []).map((i) => i.value),
          ].join(" "),
        ),
      };
    });
    const venueRows: Row[] = s.venues.map((v) => {
      const id = resolved(this.venues, v.id)?.id ?? v.id,
        pubs = active.filter((p) => p.fields.venue === id);
      return {
        id: v.id,
        label: v.preferred_name,
        sub: [v.abbreviation, v.venue_key, v.disambiguation_note]
          .filter(Boolean)
          .join(" · "),
        publicationIds: pubs.map((p) => p.id),
        fields: {
          name: v.preferred_name,
          kind: v.kind,
          publications: pubs.length,
          archive: v.merged_into
            ? "merged"
            : v.archived_at
              ? "archived"
              : "active",
          year: this.latestYear(pubs),
          updated: v.updated_at,
        },
        search: normalize(
          [
            v.preferred_name,
            v.abbreviation,
            v.venue_key,
            ...v.aliases,
            v.disambiguation_note,
          ].join(" "),
        ),
      };
    });
    const scholarRows: Row[] = s.gscholar_entries.map((g) => {
      const pubs = publicationRows.filter(
        (p) => scholarEntryIds(this.publications.get(p.id)!).includes(g.id),
      );
      const proposals = s.reviews.flatMap((r) =>
        r.proposals.filter(
          (p) => p.path === "/gscholar_entry_id" && (p.proposed === g.id || p.candidate_ids?.includes(g.id)),
        ),
      );
      return {
        id: g.id,
        label: g.title,
        sub: g.authors_text ?? g.authors.join(", "),
        publicationIds: pubs.map((p) => p.id),
        fields: {
          year: g.year ?? null,
          citations: g.citation_history.at(-1)?.count ?? null,
          venue_text: g.venue ?? null,
          link: pubs.length ? "linked" : "unlinked",
          publications: pubs.length,
          policy: g.matching.policy,
          presence: g.presence,
          completeness: g.authors_completeness,
          seen: g.last_seen_at,
          observed: g.citation_history.at(-1)?.observed_at ?? null,
          candidates: [...new Set(proposals.map((p) => p.state))],
          updated: g.updated_at,
        },
        search: normalize(
          [
            g.title,
            ...g.authors,
            g.authors_text,
            g.venue,
            g.description,
            g.scholar_id,
            g.profile_id,
          ].join(" "),
        ),
      };
    });
    this.rows = {
      publications: publicationRows,
      authors: authorRows,
      venues: venueRows,
      scholar: scholarRows,
    };
  }
  private latestYear(rows: Row[]): number | null {
    const years = rows
      .map((r) => r.fields.year)
      .filter((y): y is number => typeof y === "number");
    return years.length ? Math.max(...years) : null;
  }
  venueLabel(p: Publication): string {
    const v = resolved(this.venues, p.venue?.venue_id);
    return v?.abbreviation ?? v?.preferred_name ?? p.venue?.name ?? "No venue";
  }
  groupKey(p: Publication, group: string): string {
    return group === "year"
      ? String(yearOf(p) ?? "unknown")
      : (resolved(this.venues, p.venue?.venue_id)?.id ??
          (p.venue?.name ? `literal:${p.venue.name}` : "unknown"));
  }
  groupLabel(key: string, group: string): string {
    return group === "year"
      ? key === "unknown"
        ? "Unknown year"
        : key
      : key === "unknown"
        ? "No venue"
        : key.startsWith("literal:")
          ? `${key.slice(8)} · unresolved`
          : (this.venues.get(key)?.abbreviation ??
            this.venues.get(key)?.preferred_name ??
            key);
  }
  matches(row: Row, expression: Expression, collection: Collection): boolean {
    if (expression.kind === "group") {
      if (expression.scope === "related") {
        if (!expression.children.length) return true;
        return row.publicationIds.some((id) => {
          const pub = this.rows.publications.find((p) => p.id === id);
          return (
            !!pub &&
            this.matches(
              pub,
              { ...expression, scope: "record" },
              "publications",
            )
          );
        });
      }
      if (!expression.children.length) return true;
      return expression.mode === "all"
        ? expression.children.every((c) => this.matches(row, c, collection))
        : expression.children.some((c) => this.matches(row, c, collection));
    }
    const r = expression;
    let value = row.fields[r.field] ?? null;
    if (r.field === "author" && r.role && collection === "publications") {
      const p = this.publications.get(row.id)!;
      value = p.authors.flatMap((a, i) => {
        const id = resolved(this.authors, a.author_id)?.id;
        return id && roleMatches(a, i, r.role) ? [id] : [];
      });
    }
    const missing =
      value === null || (Array.isArray(value) && value.length === 0);
    if (r.operator === "unknown") return missing;
    if (r.operator === "known") return !missing;
    if (missing) return r.includeUnknown;
    const values = Array.isArray(value) ? value : [value];
    const equals = (v: string | number | null) =>
      typeof v === "number"
        ? v === Number(r.value)
        : normalize(String(v)) === normalize(r.value);
    if (r.operator === "is not") return values.every((v) => !equals(v));
    if (r.operator === "contains")
      return values.some((v) =>
        normalize(String(v)).includes(normalize(r.value)),
      );
    if (r.operator === "is") return values.some(equals);
    if (typeof value !== "number") return false;
    const n = Number(r.value);
    if (r.operator === "at least") return value >= n;
    if (r.operator === "at most") return value <= n;
    return value >= n && value <= Number(r.upper);
  }
  query(
    collection: Collection,
    query: string,
    expression: Group,
    archive = "active",
    notes = false,
  ): Row[] {
    return this.rows[collection].filter(
      (r) =>
        (collection === "scholar" ||
          archive === "all" ||
          r.fields.archive === archive) &&
        searchMatches(
          r.search +
            (notes && collection === "publications"
              ? " " + normalize(this.publications.get(r.id)?.notes ?? "")
              : ""),
          query,
        ) &&
        this.matches(r, expression, collection),
    );
  }
}
export function filterError(expression: Expression, depth = 0): string | null {
  if (depth > 3) return "Use at most three nested groups.";
  if (expression.kind === "group")
    return (
      expression.children.map((c) => filterError(c, depth + 1)).find(Boolean) ??
      null
    );
  if (["known", "unknown"].includes(expression.operator)) return null;
  if (!expression.value.trim()) return "Enter a value for each condition.";
  if (
    ["at least", "at most", "between"].includes(expression.operator) &&
    !Number.isFinite(Number(expression.value))
  )
    return "Enter a valid number.";
  if (
    expression.operator === "between" &&
    (!expression.upper.trim() ||
      !Number.isFinite(Number(expression.upper)) ||
      Number(expression.upper) < Number(expression.value))
  )
    return "Enter an upper bound at least as large as the lower bound.";
  return null;
}
export function sortRows(rows: Row[], sort: string): Row[] {
  const [field = "year", direction = "desc"] = sort.split(":");
  return [...rows].sort((a, b) => {
    const av = field === "title" ? a.label : a.fields[field],
      bv = field === "title" ? b.label : b.fields[field];
    if (av == null && bv != null) return 1;
    if (bv == null && av != null) return -1;
    const order =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av ?? "").localeCompare(String(bv ?? ""));
    return (
      order * (direction === "asc" ? 1 : -1) ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id)
    );
  });
}
export interface Field {
  key: string;
  label: string;
  type: "text" | "number" | "choice";
  options?: Array<[string, string]>;
}
export function fieldsFor(collection: Collection, model: ViewModel): Field[] {
  const text = (key: string, label: string): Field => ({
    key,
    label,
    type: "text",
  });
  const number = (key: string, label: string): Field => ({
    key,
    label,
    type: "number",
  });
  const choice = (
    key: string,
    label: string,
    options: string[] | Array<[string, string]>,
  ): Field => ({
    key,
    label,
    type: "choice",
    options: options.map((v) => (typeof v === "string" ? [v, v] : v)),
  });
  const link = choice("link", "Scholar link", ["linked", "unlinked"]);
  if (collection === "publications")
    return [
      number("year", "Publication year"),
      choice(
        "venue",
        "Venue identity",
        [...model.venues.values()]
          .filter((v) => !v.merged_into)
          .map((v): [string, string] => [
            v.id,
            `${v.abbreviation ?? v.preferred_name} · ${v.venue_key}`,
          ]),
      ),
      text("venue_text", "Printed venue"),
      choice("type", "Publication type", [
        "arxiv",
        "conference",
        "workshop",
        "journal",
        "book-chapter",
        "thesis",
        "other",
      ]),
      choice(
        "author",
        "Author identity",
        [...model.authors.values()]
          .filter((a) => !a.merged_into)
          .map((a): [string, string] => [
            a.id,
            `${a.preferred_name} · ${a.author_key}`,
          ]),
      ),
      text("tag", "Tag"),
      number("citations", "Citations"),
      link,
      text("doi", "DOI"),
      text("arxiv", "arXiv ID"),
      choice("files", "Attachment availability", [
        "local",
        "not-downloaded",
        "missing",
        "error",
        "none",
      ]),
      choice("role", "Any author's role", [
        "first",
        "first_listed",
        "co_first",
        "corresponding",
        "co_last",
        "equal_contributor",
      ]),
    ];
  if (collection === "authors")
    return [
      text("name", "Preferred name"),
      number("publications", "Linked publications"),
      number("year", "Latest publication year"),
      text("orcid", "ORCID"),
      text("profile", "Scholar profile ID"),
    ];
  if (collection === "venues")
    return [
      text("name", "Venue name"),
      choice("kind", "Venue kind", [
        "journal",
        "conference",
        "workshop",
        "repository",
        "other",
      ]),
      number("publications", "Linked publications"),
      number("year", "Latest publication year"),
    ];
  return [
    number("year", "Source year"),
    number("citations", "Citations"),
    text("venue_text", "Source venue"),
    { ...link, label: "Publication link" },
    choice("policy", "Matching policy", ["eligible", "excluded"]),
    choice("presence", "Source presence", ["present", "missing"]),
    choice("completeness", "Author list completeness", [
      "complete",
      "partial",
      "unknown",
    ]),
    text("seen", "Last seen (ISO date)"),
    text("observed", "Citation observation (ISO date)"),
    choice("candidates", "Candidate decision", [
      "pending",
      "deferred",
      "accepted",
      "rejected",
    ]),
  ];
}
