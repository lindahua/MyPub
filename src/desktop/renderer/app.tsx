import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import type { DesktopAPI, DesktopState, Collection, Page } from "../types.js";
import {
  ViewModel,
  emptyGroup,
  fieldsFor,
  filterError,
  newRule,
  resolved,
  sortRows,
  yearOf,
} from "../model.js";
import type { Expression, Group, Row, Rule } from "../model.js";
import type { Publication, ScholarEntry } from "../../core/types.js";
import { scholarEntryIds } from "../../core/scholar-links.js";
import { DEFAULT_PAGE_SIZES, paginate } from "../pagination.js";
import type { PageSizes } from "../pagination.js";
import "./style.css";

declare global {
  interface Window {
    mypub: DesktopAPI;
  }
}
const names: Record<Page, string> = {
  overview: "Overview",
  publications: "Publications",
  authors: "Authors",
  venues: "Venues",
  scholar: "Google Scholar",
};
const collectionPages: Collection[] = [
  "publications",
  "authors",
  "venues",
  "scholar",
];
const roles = [
  ["", "Any role"],
  ["first_listed", "First listed"],
  ["first", "First author (including co-first)"],
  ["co_first", "Co-first"],
  ["corresponding", "Corresponding"],
  ["co_last", "Co-last"],
  ["equal_contributor", "Equal contributor"],
];
const formatTime = (value?: string): string =>
  value
    ? new Date(value).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Not observed";
const pretty = (value: unknown): string =>
  value == null
    ? "Unknown"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
interface View {
  page: Page;
  query: string;
  expression: Group;
  archive: string;
  group: string;
  selectedGroup: string;
  sort: string;
  expanded: string[];
  showFilters: boolean;
  notes: boolean;
  limit: number;
  resultPage: number;
  focusId: string;
  global: string;
  minYear: string;
  maxYear: string;
}
function freshView(page: Page): View {
  return {
    page,
    query: "",
    expression: emptyGroup(),
    archive: "active",
    group: "year",
    selectedGroup: "",
    sort:
      page === "publications"
        ? "date:desc"
        : page === "scholar"
          ? "citations:desc"
          : "title:asc",
    expanded: [],
    showFilters: false,
    notes: false,
    limit: 100,
    resultPage: 1,
    focusId: "",
    global: "",
    minYear: "",
    maxYear: "",
  };
}
interface Context {
  pageSizes: PageSizes;
  model: ViewModel;
  visit: (page: Page, patch?: Partial<View>) => void;
  perform: (action: () => Promise<unknown>, message?: string) => void;
  toggle: (id: string) => void;
  expanded: string[];
}
const UI = createContext<Context>(null!);
const useUI = () => useContext(UI);
function LinkButton({
  url,
  children,
}: {
  url?: string | undefined;
  children: React.ReactNode;
}) {
  const { perform } = useUI();
  return url && /^https?:\/\//i.test(url) ? (
    <button
      className="link"
      onClick={() => perform(() => window.mypub.openURL(url))}
    >
      {children} ↗
    </button>
  ) : null;
}
function EntityLink({
  page,
  id,
  children,
}: {
  page: Collection;
  id: string;
  children: React.ReactNode;
}) {
  const { visit } = useUI();
  return (
    <button
      className="link"
      onClick={() =>
        visit(page, { focusId: id, expanded: [id], archive: "all" })
      }
    >
      {children}
    </button>
  );
}
function Datum({ name, value }: { name: string; value: unknown }) {
  return value == null || value === "" ? null : (
    <div className="datum">
      <dt>{name}</dt>
      <dd>{pretty(value)}</dd>
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
function Bars({
  rows,
  onSelect,
}: {
  rows: Array<{ id: string; label: string; count: number }>;
  onSelect?: (id: string) => void;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="bars">
      {rows.map((r) => (
        <button
          key={r.id}
          className="bar"
          disabled={!onSelect}
          onClick={() => onSelect?.(r.id)}
          aria-label={`${r.label}, ${r.count} publications`}
        >
          <span className="bar-label">{r.label}</span>
          <span className="bar-track">
            <span style={{ width: `${(r.count / max) * 100}%` }} />
          </span>
          <b>{r.count.toLocaleString()}</b>
        </button>
      ))}
    </div>
  );
}
function FilterEditor({
  value,
  onChange,
  collection,
  depth = 0,
}: {
  value: Group;
  onChange: (value: Group) => void;
  collection: Collection;
  depth?: number;
}) {
  const { model } = useUI();
  const context = value.scope === "related" ? "publications" : collection;
  const fields = fieldsFor(context, model);
  const update = (index: number, child: Expression) =>
    onChange({
      ...value,
      children: value.children.map((v, i) => (i === index ? child : v)),
    });
  return (
    <div className="filter-group">
      <div className="filter-group-head">
        <strong>
          {value.scope === "related"
            ? "Has a linked publication matching"
            : depth
              ? "Condition group"
              : "Combine conditions"}
        </strong>
        <label>
          Match{" "}
          <select
            aria-label={`Match conditions at level ${depth}`}
            value={value.mode}
            onChange={(e) =>
              onChange({ ...value, mode: e.target.value as "all" | "any" })
            }
          >
            <option value="all">all (AND)</option>
            <option value="any">any (OR)</option>
          </select>
        </label>
      </div>
      {value.children.map((child, i) => (
        <div className="condition" key={child.id}>
          {child.kind === "group" ? (
            <FilterEditor
              value={child}
              collection={context}
              depth={depth + 1}
              onChange={(v) => update(i, v)}
            />
          ) : (
            <RuleEditor
              rule={child}
              fields={fields}
              onChange={(r) => update(i, r)}
            />
          )}
          <button
            className="remove"
            aria-label="Remove condition"
            onClick={() =>
              onChange({
                ...value,
                children: value.children.filter((_, index) => index !== i),
              })
            }
          >
            ×
          </button>
        </div>
      ))}
      <div className="actions">
        <button
          onClick={() =>
            onChange({
              ...value,
              children: [...value.children, newRule(fields[0]!.key)],
            })
          }
        >
          + Condition
        </button>
        {depth < 2 && (
          <button
            onClick={() =>
              onChange({
                ...value,
                children: [...value.children, emptyGroup()],
              })
            }
          >
            + AND/OR group
          </button>
        )}
        {collection !== "publications" &&
          value.scope !== "related" &&
          depth < 2 && (
            <button
              onClick={() =>
                onChange({
                  ...value,
                  children: [
                    ...value.children,
                    { ...emptyGroup(), scope: "related" },
                  ],
                })
              }
            >
              + Linked publication conditions
            </button>
          )}
      </div>
    </div>
  );
}
function RuleEditor({
  rule,
  fields,
  onChange,
}: {
  rule: Rule;
  fields: ReturnType<typeof fieldsFor>;
  onChange: (r: Rule) => void;
}) {
  const f = fields.find((f) => f.key === rule.field) ?? fields[0]!;
  const operators =
    f.type === "number"
      ? ["is", "is not", "at least", "at most", "between", "known", "unknown"]
      : f.type === "choice"
        ? ["is", "is not", "known", "unknown"]
        : ["is", "is not", "contains", "known", "unknown"];
  return (
    <div className="rule">
      <select
        aria-label="Filter field"
        value={rule.field}
        onChange={(e) => onChange({ ...newRule(e.target.value), id: rule.id })}
      >
        {fields.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Filter operator"
        value={rule.operator}
        onChange={(e) =>
          onChange({ ...rule, operator: e.target.value as Rule["operator"] })
        }
      >
        {operators.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
      {!["known", "unknown"].includes(rule.operator) &&
        (f.options ? (
          <select
            className="value"
            aria-label="Filter value"
            value={rule.value}
            onChange={(e) => onChange({ ...rule, value: e.target.value })}
          >
            <option value="">Choose…</option>
            {f.options.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label="Filter value"
            type={f.type === "number" ? "number" : "text"}
            value={rule.value}
            onChange={(e) => onChange({ ...rule, value: e.target.value })}
            placeholder={f.label}
          />
        ))}
      {rule.operator === "between" && (
        <input
          aria-label="Upper bound"
          type="number"
          value={rule.upper}
          onChange={(e) => onChange({ ...rule, upper: e.target.value })}
        />
      )}
      {rule.field === "author" && (
        <select
          aria-label="Author credit role"
          value={rule.role}
          onChange={(e) => onChange({ ...rule, role: e.target.value })}
        >
          {roles.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      )}
      {rule.operator === "is not" && (
        <label className="check">
          <input
            type="checkbox"
            checked={rule.includeUnknown}
            onChange={(e) =>
              onChange({ ...rule, includeUnknown: e.target.checked })
            }
          />
          Include unknown
        </label>
      )}
    </div>
  );
}
function expressionLabel(
  expression: Expression,
  collection: Collection,
  model: ViewModel,
): string {
  if (expression.kind === "group")
    return `${expression.scope === "related" ? "Linked publication: " : ""}(${expression.children.map((c) => expressionLabel(c, expression.scope === "related" ? "publications" : collection, model)).join(expression.mode === "all" ? " AND " : " OR ")})`;
  const field = fieldsFor(collection, model).find(
    (f) => f.key === expression.field,
  );
  const val =
    field?.options?.find(([id]) => id === expression.value)?.[1] ??
    expression.value;
  return `${field?.label ?? expression.field} ${expression.operator}${["known", "unknown"].includes(expression.operator) ? "" : " " + (val || "…")}${expression.operator === "between" ? "–" + expression.upper : ""}${expression.role ? " (" + expression.role + ")" : ""}`;
}
function RecordDetails({
  collection,
  id,
}: {
  collection: Collection;
  id: string;
}) {
  const { model, perform } = useUI();
  const s = model.snapshot.state;
  const pub =
    collection === "publications" ? model.publications.get(id) : undefined;
  const author = collection === "authors" ? model.authors.get(id) : undefined;
  const venue = collection === "venues" ? model.venues.get(id) : undefined;
  const entry = collection === "scholar" ? model.scholar.get(id) : undefined;
  const row = model.rows[collection].find((r) => r.id === id);
  const record = pub ?? author ?? venue ?? entry;
  if (!record) return <Empty>This record is no longer available.</Empty>;
  return (
    <section className="detail" aria-label="Record details">
      {pub && (
        <>
          <div className="detail-heading">
            <h2>{pub.title}</h2>
            <button
              onClick={() =>
                perform(
                  () => window.mypub.copyCitation(s.library.id, pub.id),
                  "BibTeX copied",
                )
              }
            >
              Copy BibTeX
            </button>
          </div>
          <div className="detail-grid">
            <section>
              <h3>Bibliography</h3>
              <dl>
                <Datum name="Citation key" value={pub.citation_key} />
                <Datum name="Type" value={pub.type} />
                <Datum name="Printed venue" value={pub.venue?.name} />
                <Datum name="Event year" value={pub.venue?.event_year} />
                {(
                  [
                    "publication_date",
                    "issued_date",
                    "online_date",
                    "submission_date",
                    "acceptance_date",
                    "volume",
                    "issue",
                    "pages",
                    "article_number",
                  ] as const
                ).map((key) => (
                  <Datum
                    key={key}
                    name={key.replaceAll("_", " ")}
                    value={pub[key]}
                  />
                ))}
              </dl>
              <p className="muted">
                Browsing year: {yearOf(pub) ?? "Unknown"} · from{" "}
                {pub.publication_date
                  ? "publication date"
                  : pub.issued_date
                    ? "issued date"
                    : pub.online_date
                      ? "online date"
                      : pub.type === "preprint" && pub.submission_date
                        ? "original submission date"
                        : "no applicable date"}
              </p>
              {pub.venue?.venue_id && (
                <EntityLink
                  page="venues"
                  id={
                    resolved(model.venues, pub.venue.venue_id)?.id ??
                    pub.venue.venue_id
                  }
                >
                  Browse venue
                </EntityLink>
              )}
              <div className="actions">
                {pub.official_url && (
                  <LinkButton url={pub.official_url}>Official page</LinkButton>
                )}
                {pub.paper_url && (
                  <LinkButton url={pub.paper_url}>Paper</LinkButton>
                )}
                {pub.identifiers.doi &&
                  pub.official_url !==
                    `https://doi.org/${pub.identifiers.doi}` && (
                    <LinkButton url={`https://doi.org/${pub.identifiers.doi}`}>
                      DOI: {pub.identifiers.doi}
                    </LinkButton>
                  )}
                {pub.identifiers.arxiv && (
                  <LinkButton
                    url={`https://arxiv.org/abs/${pub.identifiers.arxiv}`}
                  >
                    arXiv: {pub.identifiers.arxiv}
                  </LinkButton>
                )}
                {pub.extra_urls
                  .filter(
                    (url) => url !== pub.official_url && url !== pub.paper_url,
                  )
                  .map((url) => (
                    <LinkButton key={url} url={url}>
                      {url}
                    </LinkButton>
                  ))}
              </div>
            </section>
            <section>
              <h3>Authors in credited order</h3>
              <ol className="credits">
                {pub.authors.map((a, index) => (
                  <li key={index}>
                    {a.author_id ? (
                      <EntityLink
                        page="authors"
                        id={
                          resolved(model.authors, a.author_id)?.id ??
                          a.author_id
                        }
                      >
                        {a.name}
                      </EntityLink>
                    ) : (
                      <>
                        {a.name}{" "}
                        <span className="muted">· unresolved identity</span>
                      </>
                    )}
                    {a.roles?.length ? (
                      <small>
                        {a.roles.map((r) => r.replaceAll("_", " ")).join(" · ")}
                      </small>
                    ) : null}
                    {a.note && <small>{a.note}</small>}
                  </li>
                ))}
              </ol>
              {pub.authorship_note && <p>{pub.authorship_note}</p>}
            </section>
          </div>
          {pub.abstract && (
            <section>
              <h3>Abstract</h3>
              <p className="preserve">{pub.abstract}</p>
            </section>
          )}
          {pub.notes && (
            <section>
              <h3>Notes</h3>
              <p className="preserve">{pub.notes}</p>
            </section>
          )}
          {pub.tags.length > 0 && (
            <div className="tags">
              {pub.tags.map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
          )}
          <h3>Attachments</h3>
          {pub.attachments.length ? (
            pub.attachments.map((a) => (
              <div className="attachment" key={a.id}>
                <div>
                  <strong>{a.label ?? a.original_filename}</strong>
                  <small>
                    {a.role} · {(a.size_bytes / 1024 / 1024).toFixed(1)} MB ·{" "}
                    {availabilityLabel(
                      model.snapshot.availability[a.id] ?? "error",
                    )}
                    {pub.primary_attachment_id === a.id ? " · Primary" : ""}
                  </small>
                </div>
                <button
                  disabled={model.snapshot.availability[a.id] !== "local"}
                  onClick={() =>
                    perform(() =>
                      window.mypub.openAttachment(s.library.id, pub.id, a.id),
                    )
                  }
                >
                  Open file
                </button>
              </div>
            ))
          ) : (
            <p className="muted">No attachments recorded.</p>
          )}
          {pub.attachments.some(
            (a) => model.snapshot.availability[a.id] === "not-downloaded",
          ) && (
            <p className="muted">
              Download unavailable files with{" "}
              <code>mypub attachment fetch {pub.citation_key}</code>.
            </p>
          )}
          <h3>Related publications</h3>
          {pub.relations.map((r, i) => (
            <p key={i}>
              {r.type.replaceAll("_", " ")} →{" "}
              <EntityLink page="publications" id={r.target_id}>
                {model.publications.get(r.target_id)?.title ?? r.target_id}
              </EntityLink>
              {r.note && ` · ${r.note}`}
            </p>
          ))}
          {s.publications.flatMap((p) =>
            p.relations
              .filter((r) => r.target_id === id)
              .map((r, i) => (
                <p key={`${p.id}-${i}`}>
                  ← {r.type.replaceAll("_", " ")}:{" "}
                  <EntityLink page="publications" id={p.id}>
                    {p.title}
                  </EntityLink>
                </p>
              )),
          )}
          <h3>Google Scholar</h3>
          {scholarEntryIds(pub).length ? (
            <>
              {scholarEntryIds(pub).length > 1 && (
                <p className="muted">
                  Combined citation totals may overlap across Scholar entries.
                </p>
              )}
              {scholarEntryIds(pub).map((entryId) => {
                const scholarEntry = model.scholar.get(entryId)!;
                return (
                  <React.Fragment key={entryId}>
                    <CitationSummary entry={scholarEntry} />
                    <p>
                      <EntityLink page="scholar" id={entryId}>
                        View Scholar source and linked publications
                      </EntityLink>
                    </p>
                    <Comparison publication={pub} entry={scholarEntry} />
                  </React.Fragment>
                );
              })}
            </>
          ) : (
            <p className="muted">No confirmed Scholar association.</p>
          )}
        </>
      )}
      {(author || venue) && (
        <>
          <h2>{author?.preferred_name ?? venue?.preferred_name}</h2>
          <p>{author?.disambiguation_note ?? venue?.disambiguation_note}</p>
          <dl>
            <Datum name="Key" value={author?.author_key ?? venue?.venue_key} />
            <Datum
              name="Aliases"
              value={(author?.aliases ?? venue?.aliases)?.join(" · ")}
            />
            <Datum name="Kind" value={venue?.kind} />
            <Datum name="Abbreviation" value={venue?.abbreviation} />
            <Datum
              name="Archived"
              value={author?.archived_at ?? venue?.archived_at}
            />
          </dl>
          {(author?.merged_into ?? venue?.merged_into) && (
            <p>
              Merged into{" "}
              <EntityLink
                page={collection}
                id={(author?.merged_into ?? venue?.merged_into)!}
              >
                surviving identity
              </EntityLink>
            </p>
          )}
          <div className="actions">
            {author?.identifiers.orcid && (
              <LinkButton url={`https://orcid.org/${author.identifiers.orcid}`}>
                ORCID {author.identifiers.orcid}
              </LinkButton>
            )}
            {author?.identifiers.google_scholar && (
              <LinkButton
                url={`https://scholar.google.com/citations?user=${encodeURIComponent(author.identifiers.google_scholar)}`}
              >
                Scholar profile
              </LinkButton>
            )}
            {venue?.urls.map((link) => (
              <LinkButton key={link.url} url={link.url}>
                {link.label ??
                  {
                    homepage: "Venue homepage",
                    proceedings: "Proceedings",
                    submission: "Submission",
                    other: "Venue resource",
                  }[link.role]}
              </LinkButton>
            ))}
          </div>
          <h3>
            Linked bibliography · {row?.publicationIds.length ?? 0} active
            publications
          </h3>
          <Bibliography
            ids={row?.publicationIds ?? []}
            authorId={author ? resolved(model.authors, id)?.id : undefined}
          />
          {author && <UnresolvedAuthor author={author} />}
        </>
      )}
      {entry && (
        <>
          <h2>{entry.title}</h2>
          <p>{entry.authors_text ?? entry.authors.join(", ")}</p>
          <p className="muted">
            Retained author array: {entry.authors_completeness} · source year:{" "}
            {entry.year ?? "Unknown"}
          </p>
          <dl>
            {(
              [
                "venue",
                "publication_date",
                "volume",
                "issue",
                "pages",
                "publisher",
                "patent_office",
                "application_number",
              ] as const
            ).map((key) => (
              <Datum
                key={key}
                name={key.replaceAll("_", " ")}
                value={entry[key]}
              />
            ))}
            <Datum name="Matching" value={entry.matching.policy} />
            <Datum name="Exclusion reason" value={entry.matching.reason} />
            <Datum name="Presence" value={entry.presence} />
            <Datum name="Last seen" value={formatTime(entry.last_seen_at)} />
            <Datum name="Missing since" value={entry.missing_since} />
            <Datum name="Source entry ID" value={entry.scholar_id} />
          </dl>
          {entry.description && <p className="preserve">{entry.description}</p>}
          <div className="actions">
            <LinkButton url={entry.scholar_url}>Scholar entry</LinkButton>
            <LinkButton url={entry.cited_by_url}>Citing articles</LinkButton>
          </div>
          <CitationSummary entry={entry} />
          <CitationHistory entry={entry} />
          <h3>Linked publications · {row?.publicationIds.length ?? 0}</h3>
          <Bibliography ids={row?.publicationIds ?? []} />
          {row?.publicationIds.map((pid) => (
            <Comparison
              key={pid}
              publication={model.publications.get(pid)!}
              entry={entry}
            />
          ))}
          <h3>Review evidence and decisions</h3>
          {s.reviews
            .filter(
              (r) =>
                r.id === entry.source_review_id ||
                r.proposals.some(
                  (p) =>
                    p.path === "/gscholar_entry_id" &&
                    (p.proposed === entry.id ||
                      p.candidate_ids?.includes(entry.id)),
                ),
            )
            .map((r) => (
              <details className="evidence" key={r.id}>
                <summary>
                  {r.summary} · {r.state}
                </summary>
                <p>
                  {r.evidence?.provider} · {formatTime(r.evidence?.captured_at)}{" "}
                  · {r.evidence?.completeness}
                </p>
                {r.evidence?.source_reference && (
                  <p>{r.evidence.source_reference}</p>
                )}
                {r.proposals
                  .filter((p) => p.proposed === entry.id)
                  .map((p) => (
                    <p key={p.id}>
                      {p.state}: {p.operation} · {p.target.entity_id}{" "}
                      {p.decision_note}
                    </p>
                  ))}
                <p className="muted">
                  Original evidence: {model.snapshot.paths[r.id]}
                </p>
              </details>
            ))}
        </>
      )}
      <footer className="record-footer">
        Updated {formatTime(record.updated_at)} · Created{" "}
        {formatTime(record.created_at)}
        <br />
        {model.snapshot.paths[id]}
      </footer>
    </section>
  );
}
const availabilityLabel = (value: string): string =>
  ({
    local: "Available locally",
    "not-downloaded": "Not downloaded",
    missing: "Missing file",
    error: "Check failed",
  })[value] ?? value;
function UnresolvedAuthor({
  author,
}: {
  author: NonNullable<ReturnType<ViewModel["authors"]["get"]>>;
}) {
  const { model } = useUI();
  const aliases = [author.preferred_name, ...author.aliases].map((s) =>
    s.toLowerCase(),
  );
  const candidates = [...model.publications.values()].filter(
    (p) =>
      !p.archived_at &&
      p.authors.some(
        (a) => !a.author_id && aliases.includes(a.name.toLowerCase()),
      ),
  );
  return candidates.length ? (
    <section>
      <h3>Unresolved same-name credits · {candidates.length}</h3>
      <p className="muted">
        Candidates only; excluded from the confirmed bibliography.
      </p>
      <Bibliography ids={candidates.map((p) => p.id)} />
    </section>
  ) : null;
}
function Pagination({
  page,
  pages,
  total,
  start,
  end,
  label,
  onChange,
}: {
  page: number;
  pages: number;
  total: number;
  start: number;
  end: number;
  label: string;
  onChange: (page: number) => void;
}) {
  if (!total) return null;
  return (
    <nav className="pagination" aria-label={label}>
      <span className="muted" role="status">
        {start + 1}–{end} of {total} papers
      </span>
      <div className="pagination-controls">
        <button disabled={page === 1} onClick={() => onChange(page - 1)}>
          Previous
        </button>
        <label>
          Page{" "}
          <select
            aria-label="Page number"
            value={page}
            onChange={(e) => onChange(Number(e.target.value))}
          >
            {Array.from({ length: pages }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>{" "}
          of {pages}
        </label>
        <button disabled={page === pages} onClick={() => onChange(page + 1)}>
          Next
        </button>
      </div>
    </nav>
  );
}
function Bibliography({
  ids,
  authorId,
}: {
  ids: string[];
  authorId?: string | undefined;
}) {
  const { model, pageSizes } = useUI();
  const [requestedPage, setPage] = useState(1);
  const selectedIds = new Set(ids);
  const ordered = sortRows(
    model.rows.publications.filter((p) => selectedIds.has(p.id)),
    "date:desc",
  );
  const page = paginate(
    ordered,
    requestedPage,
    pageSizes.max_pagesize_dropdown,
  );
  useEffect(() => {
    if (page.page !== requestedPage) setPage(page.page);
  }, [page.page, requestedPage]);
  const groups = new Map<string, Row[]>();
  for (const row of page.items) {
    const year = String(row.fields.year ?? "Unknown year");
    groups.set(year, [...(groups.get(year) ?? []), row]);
  }
  if (!ordered.length) return <p className="muted">No linked publications.</p>;
  return (
    <div className="bibliography">
      <Pagination
        {...page}
        label="Bibliography pagination"
        onChange={setPage}
      />
      {[...groups].map(([year, rows]) => (
        <section key={year} className="bibliography-year">
          <h4 className="bibliography-year-heading">{year}</h4>
          {rows.map((r) => {
            const p = model.publications.get(r.id)!;
            const credit = authorId
              ? p.authors.find(
                  (a) => resolved(model.authors, a.author_id)?.id === authorId,
                )
              : undefined;
            return (
              <div className="bibliography-row" key={p.id}>
                <EntityLink page="publications" id={p.id}>
                  {p.title}
                </EntityLink>
                <p className="byline">
                  {p.authors.length
                    ? p.authors.map((a) => a.name).join(", ")
                    : "Authors not recorded"}
                </p>
                <small>
                  {model.venueLabel(p)} · {yearOf(p) ?? "Unknown year"}
                </small>
                {credit && (
                  <small>
                    Credited as {credit.name}
                    {credit.roles?.length
                      ? " · " + credit.roles.join(", ")
                      : ""}
                  </small>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
function CitationSummary({ entry }: { entry: ScholarEntry }) {
  const { model } = useUI();
  const sample = entry.citation_history.at(-1),
    shared =
      model.rows.scholar.find((r) => r.id === entry.id)?.publicationIds
        .length ?? 0;
  return (
    <p>
      <strong>
        {sample?.count == null ? "Unknown" : sample.count.toLocaleString()}{" "}
        citations
      </strong>{" "}
      <span className="muted">
        · {formatTime(sample?.observed_at)}
        {shared > 1 ? ` · Shared entry (${shared} publications)` : ""}
        {sample?.estimated ? " · Estimated" : ""}
      </span>
    </p>
  );
}
function Comparison({
  publication,
  entry,
}: {
  publication: Publication;
  entry: ScholarEntry;
}) {
  const pairs = [
    ["Title", publication.title, entry.title],
    ["Year", yearOf(publication), entry.year],
    ["Venue", publication.venue?.name, entry.venue],
  ];
  const differences = pairs.filter(([, a, b]) => (a ?? null) !== (b ?? null));
  return differences.length ? (
    <div className="comparison">
      <h4>Curated / source differences</h4>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Curated</th>
              <th>Scholar source</th>
            </tr>
          </thead>
          <tbody>
            {differences.map(([field, a, b]) => (
              <tr key={String(field)}>
                <th>{field}</th>
                <td>{pretty(a)}</td>
                <td>{pretty(b)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  ) : null;
}
function CitationHistory({ entry }: { entry: ScholarEntry }) {
  const samples = entry.citation_history,
    known = samples.filter((s) => s.count !== null),
    max = Math.max(1, ...known.map((s) => s.count!));
  const minTime = Math.min(...samples.map((s) => Date.parse(s.observed_at))),
    span = Math.max(
      1,
      Math.max(...samples.map((s) => Date.parse(s.observed_at))) - minTime,
    );
  const x = (t: string) => 45 + ((Date.parse(t) - minTime) / span) * 530;
  const y = (n: number) => 140 - (n / max) * 115;
  const annual = entry.annual_citations?.at(-1);
  return (
    <section>
      <h3>Citation observations</h3>
      {samples.length ? (
        <>
          <svg
            className="citation-chart"
            viewBox="0 0 620 175"
            role="img"
            aria-label="Citation counts at observed dates; missing counts leave gaps"
          >
            <line
              x1="45"
              x2="575"
              y1="140"
              y2="140"
              stroke="currentColor"
              opacity=".25"
            />
            <text x="4" y="29">
              {max}
            </text>
            <text x="25" y="143">
              0
            </text>
            {samples.map((s, i) =>
              s.count === null ? null : (
                <g key={i}>
                  {i > 0 && samples[i - 1]!.count !== null && (
                    <line
                      x1={x(samples[i - 1]!.observed_at)}
                      y1={y(samples[i - 1]!.count!)}
                      x2={x(s.observed_at)}
                      y2={y(s.count)}
                      stroke="var(--accent)"
                      strokeWidth="2"
                    />
                  )}
                  <circle
                    cx={x(s.observed_at)}
                    cy={y(s.count)}
                    r="4"
                    fill="var(--accent)"
                  >
                    <title>
                      {s.observed_at}: {s.count} citations
                    </title>
                  </circle>
                </g>
              ),
            )}
            <text x="45" y="166">
              {samples[0]!.observed_at.slice(0, 10)}
            </text>
            <text x="575" y="166" textAnchor="end">
              {samples.at(-1)!.observed_at.slice(0, 10)}
            </text>
          </svg>
          <details>
            <summary>Observation values ({samples.length})</summary>
            <table>
              <thead>
                <tr>
                  <th>Observed</th>
                  <th>Citations</th>
                </tr>
              </thead>
              <tbody>
                {samples.map((s, i) => (
                  <tr key={i}>
                    <td>{formatTime(s.observed_at)}</td>
                    <td>{s.count ?? "Unknown"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      ) : (
        <p className="muted">No citation observations yet.</p>
      )}
      {annual && (
        <>
          <h3>Annual citations · captured {formatTime(annual.observed_at)}</h3>
          <div className="annual">
            {Object.entries(annual.counts)
              .sort()
              .map(([year, count]) => (
                <div key={year}>
                  <span>{year}</span>
                  <span className="annual-track">
                    <i
                      style={{
                        width: `${count === null ? 0 : (count / Math.max(1, ...Object.values(annual.counts).map((n) => n ?? 0))) * 100}%`,
                      }}
                    />
                  </span>
                  <b>{count ?? "Unknown"}</b>
                </div>
              ))}
          </div>
        </>
      )}
    </section>
  );
}
function Entry({ row, collection }: { row: Row; collection: Collection }) {
  const { model, toggle, expanded } = useUI();
  const open = expanded.includes(row.id),
    p = model.publications.get(row.id),
    entry =
      collection === "scholar"
        ? model.scholar.get(row.id)
        : p && scholarEntryIds(p).length
          ? model.scholar.get(scholarEntryIds(p)[0]!)
          : undefined;
  return (
    <article
      className={`entry ${open ? "expanded" : ""}`}
      data-record-id={row.id}
    >
      <button
        id={`entry-${row.id}`}
        className="entry-title"
        aria-expanded={open}
        aria-controls={open ? `detail-${row.id}` : undefined}
        onClick={() => toggle(row.id)}
      >
        <span className="chevron" aria-hidden="true">
          {open ? "→" : "›"}
        </span>
        {row.label}
      </button>
      <div className="entry-summary">
        <p className="byline">
          {p
            ? p.authors.map((a, i) => (
                <React.Fragment key={i}>
                  {i ? ", " : ""}
                  <span
                    className={
                      a.author_id &&
                      resolved(model.authors, a.author_id)?.id ===
                        model.snapshot.state.owner.self_author_id
                        ? "owner"
                        : ""
                    }
                  >
                    {a.name}
                  </span>
                </React.Fragment>
              ))
            : row.sub}
        </p>
        {collection === "publications" && p ? (
          <>
            <p className="metadata">
              {model.venueLabel(p)} · {yearOf(p) ?? "Unknown year"} · {p.type}
              {p.archived_at ? " · Archived" : ""}
            </p>
            <div className="row-foot">
              <span>
                {entry ? (
                  <>
                    {entry.citation_history.at(-1)?.count?.toLocaleString() ??
                      "Unknown"}{" "}
                    citations
                    {(model.rows.scholar.find((g) => g.id === entry.id)
                      ?.publicationIds.length ?? 0) > 1
                      ? " · Shared entry"
                      : ""}
                  </>
                ) : (
                  "No Scholar link"
                )}
              </span>
              {p.attachments.length > 0 && (
                <span>
                  {p.attachments.some(
                    (a) => model.snapshot.availability[a.id] === "local",
                  )
                    ? "File available locally"
                    : "Files unavailable locally"}
                </span>
              )}
              {p.tags.map((t) => (
                <span className="tag" key={t}>
                  {t}
                </span>
              ))}
            </div>
          </>
        ) : collection === "scholar" && entry ? (
          <>
            <p className="metadata">
              {entry.venue ?? "No source venue"} ·{" "}
              {entry.year ?? "Unknown year"}
            </p>
            <div className="row-foot">
              <span>
                {entry.citation_history.at(-1)?.count?.toLocaleString() ??
                  "Unknown"}{" "}
                citations
              </span>
              <span>{row.publicationIds.length} linked publications</span>
              <span className="tag">{entry.matching.policy}</span>
              <span className="tag">{entry.presence}</span>
            </div>
          </>
        ) : (
          <p className="metadata">
            {row.publicationIds.length} linked publications ·{" "}
            {row.fields.year ?? "No publication year"}
            {row.fields.kind ? " · " + row.fields.kind : ""}
            {row.fields.archive !== "active" ? " · " + row.fields.archive : ""}
          </p>
        )}
      </div>
    </article>
  );
}
function DetailPane({
  collection,
  id,
}: {
  collection: Collection;
  id: string;
}) {
  const { toggle } = useUI();
  const closeButton = useRef<HTMLButtonElement>(null);
  function close() {
    toggle(id);
    document.getElementById(`entry-${id}`)?.focus({ preventScroll: true });
  }
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [id]);
  return (
    <aside className="detail-pane" id={`detail-${id}`} aria-label="Detail pane">
      <header className="detail-pane-header">
        <span>{names[collection]} · Details</span>
        <button
          ref={closeButton}
          aria-label="Close detail pane"
          onClick={close}
        >
          ×
        </button>
      </header>
      <div className="detail-pane-content">
        <RecordDetails collection={collection} id={id} />
      </div>
    </aside>
  );
}
function PublicationTypePie({
  groups,
}: {
  groups: Map<string, Map<Publication["type"], number>>;
}) {
  const slices = publicationTypeSeries
    .map((series) => ({
      ...series,
      count: [...groups.values()].reduce(
        (sum, counts) => sum + (counts.get(series.type) ?? 0),
        0,
      ),
    }))
    .filter(({ count }) => count > 0);
  const total = slices.reduce((sum, slice) => sum + slice.count, 0);
  if (!total) return <Empty>No publications in this scope.</Empty>;
  let position = 0;
  const stops = slices.map(({ count, color }) => {
    const start = position;
    position += (count / total) * 100;
    return `${color} ${start}% ${position}%`;
  });
  return (
    <figure className="publication-type-pie">
      <div
        className="publication-type-pie-disc"
        role="img"
        aria-label={`Overall publication-type breakdown: ${slices.map(({ label, count }) => `${label}: ${count}`).join(", ")}. Total: ${total}.`}
        style={{ background: `conic-gradient(${stops.join(", ")})` }}
      />
      <figcaption>
        <p className="publication-type-pie-total">
          {total.toLocaleString()} publications
        </p>
        <ul className="publication-type-pie-legend">
          {slices.map(({ type, label, color, count }) => (
            <li key={type}>
              <span className="tooltip-swatch" style={{ background: color }} />
              <span>{label}</span>
              <b>{count.toLocaleString()}</b>
              <span className="muted">
                {((count / total) * 100).toFixed(1)}%
              </span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}
const publicationTypeSeries: {
  type: Publication["type"];
  label: string;
  color: string;
}[] = [
  { type: "journal", label: "Journal", color: "#3979ad" },
  { type: "conference", label: "Conference", color: "#42a399" },
  { type: "workshop", label: "Workshop", color: "#d39a38" },
  { type: "preprint", label: "Preprint", color: "#9270b5" },
  { type: "book-chapter", label: "Book chapter", color: "#cf7862" },
  { type: "thesis", label: "Thesis", color: "#9b9250" },
  { type: "other", label: "Other", color: "#85909e" },
];
function PublicationYearChart({
  groups,
  onSelect,
}: {
  groups: Map<string, Map<Publication["type"], number>>;
  onSelect: (year: string) => void;
}) {
  const [tooltip, setTooltip] = useState<{
    year: string;
    x: number;
    y: number;
  } | null>(null);
  function showTooltip(year: string, x: number, y: number) {
    setTooltip({
      year,
      x: Math.max(8, Math.min(x + 14, window.innerWidth - 228)),
      y: Math.max(8, Math.min(y + 14, window.innerHeight - 290)),
    });
  }
  const years = [...groups].sort(([a], [b]) =>
    a === "unknown" ? 1 : b === "unknown" ? -1 : Number(a) - Number(b),
  );
  const series = publicationTypeSeries.filter(({ type }) =>
    years.some(([, counts]) => counts.has(type)),
  );
  const maximum = Math.max(
    1,
    ...years.map(([, counts]) =>
      [...counts.values()].reduce((sum, count) => sum + count, 0),
    ),
  );
  const step = Math.max(1, Math.ceil(maximum / 4));
  const ceiling = step * 4;
  return (
    <div className="publication-year-chart">
      <ul className="chart-legend" aria-label="Publication types">
        {series.map(({ type, label, color }) => (
          <li key={type}>
            <span style={{ background: color }} />
            {label}
          </li>
        ))}
      </ul>
      <div className="year-chart-scroll" onScroll={() => setTooltip(null)}>
        <div
          className="year-chart"
          style={{ minWidth: Math.max(280, years.length * 48 + 44) }}
        >
          <div className="year-chart-scale" aria-hidden="true">
            {[4, 3, 2, 1, 0].map((tick) => (
              <span key={tick}>{tick * step}</span>
            ))}
          </div>
          <div className="year-chart-columns">
            {years.map(([year, counts]) => {
              const label = year === "unknown" ? "Unknown" : year;
              const total = [...counts.values()].reduce(
                (sum, count) => sum + count,
                0,
              );
              const description = `${label}: ${total} publications; ${series
                .filter(({ type }) => counts.has(type))
                .map(({ type, label }) => `${label}: ${counts.get(type)}`)
                .join(", ")}`;
              return (
                <button
                  key={year}
                  className="year-chart-column"
                  aria-label={description}
                  aria-describedby={
                    tooltip?.year === year
                      ? "publication-year-tooltip"
                      : undefined
                  }
                  onPointerMove={(event) =>
                    showTooltip(year, event.clientX, event.clientY)
                  }
                  onPointerLeave={() => setTooltip(null)}
                  onFocus={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    showTooltip(year, rect.left + rect.width / 2, rect.top);
                  }}
                  onBlur={() => setTooltip(null)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setTooltip(null);
                  }}
                  onClick={() => {
                    setTooltip(null);
                    onSelect(year);
                  }}
                >
                  <span className="year-chart-stack">
                    <span
                      className="year-chart-total"
                      style={{ bottom: `${(total / ceiling) * 100}%` }}
                    >
                      {total}
                    </span>
                    {series.map(
                      ({ type, color }) =>
                        counts.has(type) && (
                          <span
                            key={type}
                            className="year-chart-segment"
                            style={{
                              height: `${(counts.get(type)! / ceiling) * 100}%`,
                              background: color,
                            }}
                          />
                        ),
                    )}
                  </span>
                  <span className="year-chart-label">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {tooltip &&
        groups.has(tooltip.year) &&
        createPortal(
          <div
            id="publication-year-tooltip"
            role="tooltip"
            className="year-chart-tooltip"
            style={{ left: tooltip.x, top: tooltip.y }}
          >
            <strong>
              {tooltip.year === "unknown" ? "Unknown year" : tooltip.year}
            </strong>
            <ul>
              {series.map(({ type, label, color }) => (
                <li key={type}>
                  <span
                    className="tooltip-swatch"
                    style={{ background: color }}
                  />
                  <span>{label}</span>
                  <b>{groups.get(tooltip.year)!.get(type) ?? 0}</b>
                </li>
              ))}
            </ul>
            <div className="tooltip-total">
              <span>Total</span>
              <b>
                {[...groups.get(tooltip.year)!.values()].reduce(
                  (sum, count) => sum + count,
                  0,
                )}
              </b>
            </div>
          </div>,
          document.body,
        )}
      <p className="year-chart-caption">
        Publication year · Select a bar to browse publications
      </p>
    </div>
  );
}
function Overview({
  view,
  update,
}: {
  view: View;
  update: (patch: Partial<View>) => void;
}) {
  const { model, visit } = useUI();
  const all = model.rows.publications.filter(
    (r) => r.fields.archive === "active",
  );
  const rows = all.filter(
    (r) =>
      (!view.minYear ||
        (typeof r.fields.year === "number" &&
          r.fields.year >= Number(view.minYear))) &&
      (!view.maxYear ||
        (typeof r.fields.year === "number" &&
          r.fields.year <= Number(view.maxYear))),
  );
  const authors = new Set(rows.flatMap((r) => r.fields.author as string[])),
    venues = new Set(rows.map((r) => r.fields.venue).filter(Boolean)),
    scholarEntries = model.rows.scholar,
    linkedScholarEntries = scholarEntries.filter(
      (r) => r.fields.link === "linked",
    ).length;
  const publicationTypeGroups = new Map<
      string,
      Map<Publication["type"], number>
    >(),
    venueGroups = new Map<string, number>(),
    coauthorGroups = new Map<string, number>();
  const selfAuthorId = resolved(
    model.authors,
    model.snapshot.state.owner.self_author_id,
  )?.id;
  for (const row of rows) {
    const p = model.publications.get(row.id)!;
    const year = model.groupKey(p, "year"),
      venue = model.groupKey(p, "venue");
    const linkedVenue = resolved(model.venues, p.venue?.venue_id);
    const typeCounts =
      publicationTypeGroups.get(year) ?? new Map<Publication["type"], number>();
    typeCounts.set(p.type, (typeCounts.get(p.type) ?? 0) + 1);
    publicationTypeGroups.set(year, typeCounts);
    const isArxivVenue = (
      linkedVenue
        ? [
            linkedVenue.venue_key,
            linkedVenue.preferred_name,
            linkedVenue.abbreviation,
            ...linkedVenue.aliases,
          ]
        : [p.venue?.name]
    ).some(
      (name) =>
        name != null &&
        /^arxiv(?:$|[\s.:/-])/i.test(name.normalize("NFKC").trim()),
    );
    if (venue !== "unknown" && !isArxivVenue)
      venueGroups.set(venue, (venueGroups.get(venue) ?? 0) + 1);
    for (const id of new Set(row.fields.author as string[])) {
      if (id !== selfAuthorId)
        coauthorGroups.set(id, (coauthorGroups.get(id) ?? 0) + 1);
    }
  }
  function browse(field?: string, val?: string) {
    const expr = emptyGroup();
    if (view.minYear)
      expr.children.push({
        ...newRule("year", view.minYear),
        operator: "at least",
      });
    if (view.maxYear)
      expr.children.push({
        ...newRule("year", view.maxYear),
        operator: "at most",
      });
    if (field && val)
      expr.children.push(
        val === "unknown"
          ? { ...newRule(field), operator: "unknown" }
          : field === "venue" && val.startsWith("literal:")
            ? newRule("venue_text", val.slice(8))
            : newRule(field, val),
      );
    visit("publications", { expression: expr });
  }
  const mostCited = sortRows(
    rows.filter((r) => typeof r.fields.citations === "number"),
    "citations:desc",
  ).slice(0, 5);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Your research, at a glance</h1>
          <p className="muted">
            {view.minYear || view.maxYear
              ? "Selected publication years"
              : "All active publications"}{" "}
            · {model.snapshot.state.library.name}
          </p>
        </div>
        <div className="year-range">
          <label>
            From year
            <input
              type="number"
              aria-label="Overview from year"
              placeholder="Any"
              value={view.minYear}
              onChange={(e) => update({ minYear: e.target.value })}
            />
          </label>
          <label>
            To year
            <input
              type="number"
              aria-label="Overview to year"
              placeholder="Any"
              value={view.maxYear}
              onChange={(e) => update({ maxYear: e.target.value })}
            />
          </label>
        </div>
      </div>
      <div className="metrics">
        <button onClick={() => browse()}>
          <span>Publications</span>
          <strong>{rows.length.toLocaleString()}</strong>
          <small>Publication records</small>
        </button>
        <button onClick={() => visit("authors")}>
          <span>Linked authors</span>
          <strong>{authors.size.toLocaleString()}</strong>
          <small>Distinct identities in scope</small>
        </button>
        <button onClick={() => visit("venues")}>
          <span>Venues</span>
          <strong>{venues.size.toLocaleString()}</strong>
          <small>Linked series in scope</small>
        </button>
        <button
          onClick={() => visit("scholar")}
          title="All Scholar entries in the catalog; each entry is counted once"
        >
          <span>Google Scholar entries</span>
          <strong>{scholarEntries.length.toLocaleString()}</strong>
          <small>
            {scholarEntries.length
              ? Math.round((linkedScholarEntries / scholarEntries.length) * 100)
              : 0}
            % linked to publication records
          </small>
        </button>
      </div>
      <div className="charts">
        <div className="publication-chart-pair">
          <section>
            <h2>Publications by type</h2>
            <PublicationTypePie groups={publicationTypeGroups} />
          </section>
          <section>
            <h2>Publications by year</h2>
            {rows.length ? (
              <PublicationYearChart
                groups={publicationTypeGroups}
                onSelect={(id) => browse("year", id)}
              />
            ) : (
              <Empty>No publications in this scope.</Empty>
            )}
          </section>
        </div>
        <div className="overview-rankings">
          <section>
            <h2>Top 10 venues</h2>
            <p className="muted">
              Ranked by publication count · excluding arXiv
            </p>
            {venueGroups.size ? (
              <Bars
                rows={[...venueGroups]
                  .map(([id, count]) => ({
                    id,
                    label: model.groupLabel(id, "venue"),
                    count,
                  }))
                  .sort(
                    (a, b) =>
                      b.count - a.count || a.label.localeCompare(b.label),
                  )
                  .slice(0, 10)}
                onSelect={(id) => browse("venue", id)}
              />
            ) : (
              <Empty>No venues in this scope.</Empty>
            )}
          </section>
          <section>
            <h2>Top 10 co-authors</h2>
            <p className="muted">
              Linked authors by publication count
              {selfAuthorId ? " · excluding you" : ""}
            </p>
            {coauthorGroups.size ? (
              <Bars
                rows={[...coauthorGroups]
                  .map(([id, count]) => ({
                    id,
                    label: model.authors.get(id)!.preferred_name,
                    count,
                  }))
                  .sort(
                    (a, b) =>
                      b.count - a.count || a.label.localeCompare(b.label),
                  )
                  .slice(0, 10)}
                onSelect={(id) => browse("author", id)}
              />
            ) : (
              <Empty>No linked co-authors in this scope.</Empty>
            )}
          </section>
        </div>
      </div>
      <section>
        <h2>Most cited papers</h2>
        <p className="muted">
          Latest observed Google Scholar counts · dates shown in details
        </p>
        {mostCited.length ? (
          mostCited.map((r) => (
            <Entry key={r.id} row={r} collection="publications" />
          ))
        ) : (
          <Empty>No citation observations available.</Empty>
        )}
      </section>
    </>
  );
}
function ScholarSnapshot() {
  const { model } = useUI();
  const profile = model.snapshot.state.gscholar_profile,
    capture = profile?.captures.at(-1);
  return (
    <section className="snapshot-card">
      <h2>Google Scholar · local snapshot</h2>
      {profile ? (
        <>
          <p>
            Profile {profile.profile_id} · {model.rows.scholar.length} entries ·{" "}
            {model.rows.scholar.filter((g) => g.publicationIds.length).length}{" "}
            linked entries
          </p>
          <p className="muted">
            {capture
              ? `Captured ${formatTime(capture.captured_at)} · ${capture.coverage} coverage`
              : "No captures recorded"}{" "}
            · whole-profile scope
          </p>
          <div className="profile-totals">
            {(
              [
                ["citations", "Citations"],
                ["h_index", "h-index"],
                ["i10_index", "i10-index"],
              ] as const
            ).map(([key, label]) => (
              <span key={key}>
                {label}:{" "}
                <strong>
                  {capture?.totals && Object.hasOwn(capture.totals, key)
                    ? (capture.totals[key]?.toLocaleString() ?? "Unavailable")
                    : "Not captured"}
                </strong>
              </span>
            ))}
          </div>
        </>
      ) : (
        <p>No Scholar profile has been mirrored in this catalog.</p>
      )}
    </section>
  );
}
function CollectionView({
  view,
  update,
}: {
  view: View;
  update: (patch: Partial<View>) => void;
}) {
  const { model, expanded, pageSizes } = useUI(),
    collection = view.page as Collection;
  const error = filterError(view.expression);
  const rows = useMemo(
    () =>
      error
        ? []
        : sortRows(
            model.query(
              collection,
              view.query,
              view.expression,
              view.archive,
              view.notes,
            ),
            view.sort,
          ),
    [
      model,
      collection,
      view.query,
      view.expression,
      view.archive,
      view.notes,
      view.sort,
      error,
    ],
  );
  const groups = new Map<string, Row[]>();
  if (collection === "publications" && view.group !== "none")
    for (const row of rows) {
      const key = model.groupKey(model.publications.get(row.id)!, view.group);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
  const keys = [...groups.keys()].sort((a, b) =>
    view.group === "year"
      ? (Number(b) || 0) - (Number(a) || 0)
      : model
          .groupLabel(a, "venue")
          .localeCompare(model.groupLabel(b, "venue")),
  );
  const selected = groups.has(view.selectedGroup) ? view.selectedGroup : "";
  useEffect(() => {
    if (
      !error &&
      rows.length > 0 &&
      view.selectedGroup &&
      !groups.has(view.selectedGroup)
    )
      update({ selectedGroup: "" });
  }, [model, rows, view.selectedGroup]);
  // Paginate the actual display order, after ordering the groups, not each group separately.
  const shown = selected
    ? groups.get(selected)!
    : groups.size
      ? keys.flatMap((key) => groups.get(key)!)
      : rows;
  const paginated = collection === "publications" || collection === "scholar";
  const focusedIndex = shown.findIndex((r) => r.id === view.focusId);
  const requestedPage =
    focusedIndex >= 0
      ? Math.floor(focusedIndex / pageSizes.max_pagesize_main) + 1
      : view.resultPage;
  const resultPage = paginate(
    shown,
    requestedPage,
    pageSizes.max_pagesize_main,
  );
  const limit = Math.max(view.limit, focusedIndex + 1);
  const display = new Set(
    (paginated ? resultPage.items : shown.slice(0, limit)).map((r) => r.id),
  );
  useLayoutEffect(() => {
    if (paginated && !error && resultPage.page !== view.resultPage)
      update({ resultPage: resultPage.page });
  }, [paginated, error, resultPage.page, view.resultPage]);
  const absent = expanded.filter((id) => !rows.some((r) => r.id === id));
  const renderRows = (list: Row[]) =>
    list
      .filter((r) => display.has(r.id))
      .map((row) => <Entry key={row.id} row={row} collection={collection} />);
  return (
    <>
      <h1>{names[collection]}</h1>
      {collection === "scholar" ? (
        <ScholarSnapshot />
      ) : (
        <p className="muted">
          {collection === "publications"
            ? "Browse your bibliography, one connection at a time."
            : collection === "authors"
              ? "People, credited names and linked publications."
              : "Journals and conference series, across every year."}
        </p>
      )}
      <div className="toolbar">
        <input
          className="search"
          aria-label={`Search ${names[collection]}`}
          placeholder={`Search ${names[collection].toLowerCase()}…`}
          value={view.query}
          onChange={(e) => update({ query: e.target.value, limit: 100 })}
        />
        <button
          aria-pressed={view.showFilters}
          onClick={() => update({ showFilters: !view.showFilters })}
        >
          Filter
          {view.expression.children.length
            ? ` · ${view.expression.children.length}`
            : ""}
        </button>
        {collection === "publications" && (
          <label>
            Group{" "}
            <select
              aria-label="Group publications"
              value={view.group}
              onChange={(e) =>
                update({ group: e.target.value, selectedGroup: "", limit: 100 })
              }
            >
              <option value="year">Year</option>
              <option value="venue">Venue</option>
              <option value="none">None</option>
            </select>
          </label>
        )}
        <label>
          Sort{" "}
          <select
            aria-label="Sort results"
            value={view.sort}
            onChange={(e) => update({ sort: e.target.value })}
          >
            <option value="title:asc">Title / name A–Z</option>
            <option value="title:desc">Title / name Z–A</option>
            <option value="year:desc">Year, newest</option>
            <option value="year:asc">Year, oldest</option>
            {collection === "publications" && (
              <option value="date:desc">Date, newest</option>
            )}
            {["publications", "scholar"].includes(collection) ? (
              <>
                <option value="citations:desc">Citations, highest</option>
                <option value="citations:asc">Citations, lowest</option>
              </>
            ) : (
              <option value="publications:desc">Publication count</option>
            )}
            <option value="updated:desc">Recently updated</option>
          </select>
        </label>
        {collection !== "scholar" && (
          <label>
            Show{" "}
            <select
              aria-label="Archive state"
              value={view.archive}
              onChange={(e) => update({ archive: e.target.value })}
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              {collection !== "publications" && (
                <option value="merged">Merged</option>
              )}
              <option value="all">All</option>
            </select>
          </label>
        )}
      </div>
      <details className="search-help">
        <summary>Search help</summary>
        <p>
          All words must match; use "quoted phrases" to keep words together.
          Names, aliases, identifiers, venues and tags are included. Identity
          filters use confirmed links.
        </p>
        {collection === "publications" && (
          <label className="check">
            <input
              type="checkbox"
              checked={view.notes}
              onChange={(e) => update({ notes: e.target.checked })}
            />
            Also search private notes
          </label>
        )}
      </details>
      {view.showFilters && (
        <FilterEditor
          collection={collection}
          value={view.expression}
          onChange={(expression) => update({ expression, limit: 100 })}
        />
      )}
      <div className="chips">
        {view.expression.children.map((child) => (
          <button
            key={child.id}
            onClick={() =>
              update({
                expression: {
                  ...view.expression,
                  children: view.expression.children.filter(
                    (c) => c.id !== child.id,
                  ),
                },
              })
            }
          >
            {expressionLabel(child, collection, model)} ×
          </button>
        ))}
        {(view.expression.children.length > 0 || view.query) && (
          <button
            className="quiet"
            onClick={() =>
              update({ expression: emptyGroup(), query: "", selectedGroup: "" })
            }
          >
            Clear all
          </button>
        )}
      </div>
      {collection === "scholar" && (
        <div className="shortcuts">
          {[
            ["link", "unlinked"],
            ["policy", "excluded"],
            ["presence", "missing"],
          ].map(([field, value]) => (
            <button
              key={field}
              onClick={() =>
                update({
                  expression: {
                    ...view.expression,
                    children: [
                      ...view.expression.children.filter(
                        (c) => c.kind !== "rule" || c.field !== field,
                      ),
                      newRule(field, value),
                    ],
                  },
                })
              }
            >
              {value}
            </button>
          ))}
          <button
            onClick={() =>
              update({
                expression: {
                  ...view.expression,
                  children: [
                    ...view.expression.children,
                    { ...newRule("citations"), operator: "unknown" },
                  ],
                },
              })
            }
          >
            Unknown citations
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error} Complete the filter to see results.
        </p>
      )}
      <p className="result-count" role="status">
        {shown.length.toLocaleString()}
        {selected ? ` of ${rows.length.toLocaleString()}` : ""}{" "}
        {names[collection].toLowerCase()}
        {selected ? " · " + model.groupLabel(selected, view.group) : ""}
      </p>
      {paginated && (
        <Pagination
          {...resultPage}
          label="Main pagination"
          onChange={(resultPage) => update({ resultPage, focusId: "" })}
        />
      )}
      {absent.length > 0 && (
        <div className="notice">
          {absent.length} selected{" "}
          {absent.length === 1 ? "record is" : "records are"} no longer in these
          results.{" "}
          <button
            onClick={() =>
              update({
                expanded: expanded.filter((id) => !absent.includes(id)),
              })
            }
          >
            Dismiss
          </button>
        </div>
      )}
      <div className={`browse ${groups.size ? "has-groups" : ""}`}>
        {groups.size > 0 && (
          <nav className="group-nav" aria-label={`Browse by ${view.group}`}>
            <h2>{view.group === "year" ? "Years" : "Venues"}</h2>
            <button
              aria-pressed={!selected}
              onClick={() => update({ selectedGroup: "", limit: 100 })}
            >
              <span>All {view.group === "year" ? "years" : "venues"}</span>
              <b>{rows.length}</b>
            </button>
            {keys.map((key) => (
              <button
                key={key}
                aria-pressed={selected === key}
                onClick={() => update({ selectedGroup: key, limit: 100 })}
              >
                <span>{model.groupLabel(key, view.group)}</span>
                <b>{groups.get(key)!.length}</b>
              </button>
            ))}
          </nav>
        )}
        <div className="results">
          {!error && !rows.length && (
            <Empty>
              No matching records. Try removing a condition or changing your
              search.
            </Empty>
          )}
          {groups.size
            ? (selected ? [selected] : keys)
                .filter((key) =>
                  groups.get(key)!.some((r) => display.has(r.id)),
                )
                .map((key) => (
                  <section key={key}>
                    <h2 className="group-heading">
                      {model.groupLabel(key, view.group)}{" "}
                      <span>{groups.get(key)!.length}</span>
                    </h2>
                    {renderRows(groups.get(key)!)}
                  </section>
                ))
            : renderRows(rows)}
          {!paginated && shown.length > limit && (
            <button
              className="load-more"
              onClick={() => update({ limit: limit + 100 })}
            >
              Show next {Math.min(100, shown.length - limit)} ·{" "}
              {shown.length - limit} more
            </button>
          )}
        </div>
      </div>
    </>
  );
}
function App() {
  const [desktop, setDesktop] = useState<DesktopState>({
    status: "loading",
    snapshot: null,
    root: null,
    error: null,
  });
  const [view, setView] = useState<View>(() => freshView("overview")),
    [message, setMessage] = useState("");
  const history = useRef<Array<{ view: View; scroll: number }>>([]),
    future = useRef<Array<{ view: View; scroll: number }>>([]);
  const main = useRef<HTMLElement>(null),
    scrollRestore = useRef<number | null>(null),
    library = useRef("");
  useEffect(() => {
    let live = true,
      received = false;
    const cancel = window.mypub.onState((s) => {
      received = true;
      if (live) setDesktop(s);
    });
    void window.mypub.state().then((s) => {
      if (live && !received) setDesktop(s);
    });
    return () => {
      live = false;
      cancel();
    };
  }, []);
  useEffect(() => {
    if (desktop.root !== library.current) {
      library.current = desktop.root ?? "";
      setView(freshView("overview"));
      history.current = [];
      future.current = [];
    }
  }, [desktop.root]);
  const model = useMemo(
    () => (desktop.snapshot ? new ViewModel(desktop.snapshot) : null),
    [desktop.snapshot],
  );
  function update(patch: Partial<View>) {
    setView((v) => ({
      ...v,
      ...([
        "query",
        "expression",
        "archive",
        "group",
        "selectedGroup",
        "sort",
        "notes",
      ].some((key) => Object.hasOwn(patch, key))
        ? { resultPage: 1 }
        : {}),
      ...patch,
    }));
  }
  function visit(page: Page, patch: Partial<View> = {}) {
    history.current.push({ view, scroll: main.current?.scrollTop ?? 0 });
    future.current = [];
    scrollRestore.current = 0;
    setView({ ...freshView(page), ...patch });
  }
  function travel(back: boolean) {
    const source = back ? history : future,
      destination = back ? future : history;
    const target = source.current.pop();
    if (!target) return;
    destination.current.push({ view, scroll: main.current?.scrollTop ?? 0 });
    scrollRestore.current = target.scroll;
    setView(target.view);
  }
  useLayoutEffect(() => {
    if (scrollRestore.current !== null && main.current) {
      main.current.scrollTop = scrollRestore.current;
      scrollRestore.current = null;
    }
    if (view.focusId) {
      const node = document.getElementById(`entry-${view.focusId}`);
      if (node) {
        node.scrollIntoView({ block: "nearest" });
        node.focus({ preventScroll: true });
        update({ focusId: "" });
      }
    }
  }, [view.page, view.focusId, view.query]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        document.getElementById("global-search")?.focus();
      }
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        travel(true);
      }
      if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        travel(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  async function perform(action: () => Promise<unknown>, success = "") {
    try {
      await action();
      setMessage(success);
    } catch (e) {
      setMessage(String(e));
    }
  }
  const context: Context | null = model
    ? {
        model,
        pageSizes: desktop.pageSizes ?? DEFAULT_PAGE_SIZES,
        visit,
        perform,
        expanded: view.expanded,
        toggle: (id) =>
          setView((v) => ({
            ...v,
            expanded: v.expanded.includes(id)
              ? v.expanded.filter((x) => x !== id)
              : [id],
          })),
      }
    : null;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          mypub<span>.</span>
        </div>
        <p className="library-name">
          {desktop.snapshot?.state.library.name ?? "Publication library"}
        </p>
        <button
          className="open-library"
          onClick={() => void perform(() => window.mypub.chooseLibrary())}
        >
          Change library…
        </button>
        <nav aria-label="Main navigation">
          {Object.entries(names).map(([page, label]) => (
            <button
              key={page}
              aria-current={
                view.page === page && !view.global ? "page" : undefined
              }
              onClick={() => visit(page as Page)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="library-status">
          <strong className={desktop.status === "stale" ? "bad" : ""}>
            ●{" "}
            {desktop.status === "current"
              ? "Current"
              : desktop.status === "waiting"
                ? "Waiting for catalog"
                : desktop.status === "stale"
                  ? "Refresh failed"
                  : desktop.status === "empty"
                    ? "No library open"
                    : "Loading…"}
          </strong>
          <p>Local library</p>
          {desktop.snapshot && (
            <small>Loaded {formatTime(desktop.snapshot.loadedAt)}</small>
          )}
          <button
            className="link"
            onClick={() => void perform(() => window.mypub.retry())}
          >
            Refresh
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="history-buttons">
            <button
              aria-label="Back"
              disabled={!history.current.length}
              onClick={() => travel(true)}
            >
              ←
            </button>
            <button
              aria-label="Forward"
              disabled={!future.current.length}
              onClick={() => travel(false)}
            >
              →
            </button>
          </div>
          <input
            id="global-search"
            aria-label="Search all collections"
            placeholder="Search across your library…    ⌘K"
            value={view.global}
            onChange={(e) => update({ global: e.target.value })}
          />
          <span className="local-label">LOCAL LIBRARY</span>
        </header>
        {desktop.error && (
          <div className="error-banner" role="alert">
            <strong>
              {desktop.snapshot
                ? `Showing last valid data, loaded ${formatTime(desktop.snapshot.loadedAt)}.`
                : "The library could not be loaded."}
            </strong>
            <details>
              <summary>
                {desktop.status === "waiting"
                  ? "Waiting for another catalog operation"
                  : "Show error details"}
              </summary>
              <pre>{desktop.error}</pre>
            </details>
            <button onClick={() => void perform(() => window.mypub.retry())}>
              Retry
            </button>
          </div>
        )}
        {message && (
          <div className="notice" role="status">
            {message}
            <button aria-label="Dismiss message" onClick={() => setMessage("")}>
              ×
            </button>
          </div>
        )}
        <div
          className={`content-workspace ${context && view.expanded.length ? "has-detail-pane" : ""}`}
        >
          <main className="main" ref={main}>
            {context ? (
              <UI.Provider value={context}>
                {view.global ? (
                  <>
                    <h1>Search your library</h1>
                    <p className="muted">
                      Matches across all active collections for “{view.global}”
                    </p>
                    {collectionPages.map((page) => {
                      const rows = model!.query(
                        page,
                        view.global,
                        emptyGroup(),
                      );
                      return (
                        <section key={page} className="global-section">
                          <h2>
                            {names[page]} · {rows.length}
                          </h2>
                          {rows.slice(0, 5).map((row) => (
                            <div className="bibliography-row" key={row.id}>
                              <EntityLink page={page} id={row.id}>
                                {row.label}
                              </EntityLink>
                              <small>{row.sub}</small>
                            </div>
                          ))}
                          {rows.length > 5 && (
                            <button
                              className="link"
                              onClick={() =>
                                visit(page, { query: view.global })
                              }
                            >
                              See all {rows.length} →
                            </button>
                          )}
                        </section>
                      );
                    })}
                  </>
                ) : view.page === "overview" ? (
                  <Overview view={view} update={update} />
                ) : (
                  <CollectionView view={view} update={update} />
                )}
              </UI.Provider>
            ) : (
              <div className="welcome">
                <div className="brand">
                  mypub<span>.</span>
                </div>
                <h1>Your publications, connected.</h1>
                <p>
                  Open an existing MyPub catalog to browse papers, authors,
                  venues and your Google Scholar mirror.
                </p>
                {desktop.root && <p className="muted">{desktop.root}</p>}
                <button
                  className="primary"
                  onClick={() =>
                    void perform(() => window.mypub.chooseLibrary())
                  }
                >
                  Choose library folder…
                </button>
                {desktop.status === "loading" && (
                  <p className="muted">Loading the local catalog…</p>
                )}
              </div>
            )}
          </main>
          {context && view.expanded[0] && (
            <UI.Provider value={context}>
              <DetailPane
                key={view.expanded[0]}
                collection={
                  view.page === "overview" ? "publications" : view.page
                }
                id={view.expanded[0]}
              />
            </UI.Provider>
          )}
        </div>
        <footer className="app-footer">
          {desktop.root ?? "Choose an existing catalog folder"}
          <span>MyPub · Viewer</span>
        </footer>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
