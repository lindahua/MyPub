import test from "node:test";
import assert from "node:assert/strict";
import {
  ViewModel,
  emptyGroup,
  filterError,
  newRule,
  sortRows,
} from "./model.js";
import type { Snapshot } from "./types.js";
import type { Publication } from "../core/types.js";
const base = {
  schema_version: 2 as const,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
const paper = (id: string, patch: Partial<Publication> = {}): Publication => ({
  ...base,
  id,
  citation_key: id,
  title: id,
  type: "journal",
  authors: [],
  identifiers: {},
  tags: [],
  extra_urls: [],
  relations: [],
  attachments: [],
  ...patch,
});
function fixture(): ViewModel {
  const snapshot: Snapshot = {
    root: "/fixture",
    generation: "1",
    paths: {},
    availability: {},
    loadedAt: base.created_at,
    state: {
      library: { ...base, id: "library", name: "Test" },
      owner: { schema_version: 2 },
      authors: [
        {
          ...base,
          id: "alice",
          author_key: "alice",
          preferred_name: "Same Name",
          aliases: ["A. Example"],
          identifiers: {},
        },
        {
          ...base,
          id: "bob",
          author_key: "bob",
          preferred_name: "Same Name",
          aliases: [],
          identifiers: {},
        },
        {
          ...base,
          id: "old",
          author_key: "old",
          preferred_name: "Old name",
          aliases: [],
          identifiers: {},
          merged_into: "alice",
          archived_at: base.created_at,
        },
      ],
      venues: [
        {
          ...base,
          id: "v",
          venue_key: "v",
          preferred_name: "Example Journal",
          aliases: ["EJ"],
          kind: "journal",
          urls: [],
        },
      ],
      publications: [
        paper("one", {
          title: "École visual learning",
          publication_date: "2025",
          venue: { name: "Printed journal", venue_id: "v" },
          authors: [
            { name: "First", author_id: "bob" },
            { name: "A. Example", author_id: "old", roles: ["corresponding"] },
          ],
          tags: ["vision"],
          gscholar_entry_id: "s",
        }),
        paper("two", {
          title: "Older preprint",
          type: "preprint",
          submission_date: "2023",
          authors: [{ name: "Same Name", author_id: "alice" }],
          gscholar_entry_id: "s",
        }),
        paper("three", {
          authors: [{ name: "Same Name" }],
          gscholar_entry_id: "z",
        }),
        paper("four", {
          acceptance_date: "2026",
          venue: { name: "Printed journal" },
        }),
      ],
      gscholar_entries: [
        {
          ...base,
          id: "s",
          profile_id: "profile",
          scholar_id: "source",
          title: "Source",
          authors: [],
          authors_completeness: "unknown",
          matching: { policy: "eligible" },
          first_seen_at: base.created_at,
          last_seen_at: base.updated_at,
          presence: "present",
          source_review_id: "review",
          citation_history: [
            {
              count: 50,
              observed_at: "2025-01-01T00:00:00Z",
              source_review_id: "review",
            },
            {
              count: null,
              observed_at: base.created_at,
              source_review_id: "review",
            },
          ],
        },
        {
          ...base,
          id: "z",
          profile_id: "profile",
          scholar_id: "zero",
          title: "Zero",
          authors: [],
          authors_completeness: "unknown",
          matching: { policy: "eligible" },
          first_seen_at: base.created_at,
          last_seen_at: base.updated_at,
          presence: "present",
          source_review_id: "review",
          citation_history: [
            {
              count: 0,
              observed_at: base.created_at,
              source_review_id: "review",
            },
          ],
        },
      ],
      reviews: [],
    },
  };
  return new ViewModel(snapshot);
}
test("author identity and role bind to the same credit, including merge redirects", () => {
  const model = fixture();
  const expression = emptyGroup();
  expression.children = [
    { ...newRule("author", "alice"), role: "corresponding" },
  ];
  assert.deepEqual(
    model.query("publications", "", expression).map((r) => r.id),
    ["one"],
  );
  expression.children = [
    { ...newRule("author", "bob"), role: "corresponding" },
  ];
  assert.equal(model.query("publications", "", expression).length, 0);
  expression.children = [
    { ...newRule("author", "alice"), role: "first_listed" },
  ];
  assert.deepEqual(
    model.query("publications", "", expression).map((r) => r.id),
    ["two"],
  );
  assert.equal(
    model.rows.authors.find((a) => a.id === "alice")?.publicationIds.length,
    2,
  );
});
test("nested AND/OR and related-publication conditions do not match separate papers", () => {
  const model = fixture();
  const expression = emptyGroup();
  const nested = emptyGroup();
  nested.mode = "any";
  nested.children = [newRule("year", "2025"), newRule("year", "2023")];
  expression.children = [nested, newRule("author", "alice")];
  assert.deepEqual(
    model.query("publications", "", expression).map((r) => r.id),
    ["one", "two"],
  );
  expression.children = [
    {
      ...emptyGroup(),
      scope: "related",
      children: [newRule("year", "2023"), newRule("venue", "v")],
    },
  ];
  assert.equal(model.query("authors", "", expression).length, 0);
  expression.children = [
    {
      ...emptyGroup(),
      scope: "related",
      children: [newRule("year", "2025"), newRule("venue", "v")],
    },
  ];
  assert.equal(model.query("authors", "", expression).length, 2);
});
test("latest null stays unknown, zero is known, shared entries are counted once in the mirror", () => {
  const model = fixture();
  assert.equal(model.rows.publications[0]?.fields.citations, null);
  assert.equal(model.rows.scholar.length, 2);
  assert.equal(model.rows.scholar[0]?.publicationIds.length, 2);
  for (const direction of ["asc", "desc"])
    assert.equal(
      sortRows(model.rows.publications, `citations:${direction}`)[0]?.id,
      "three",
    );
  const expression = emptyGroup();
  expression.children = [{ ...newRule("citations"), operator: "known" }];
  assert.deepEqual(
    model.query("publications", "", expression).map((r) => r.id),
    ["three"],
  );
});
test("year fallback, literal venues, phrase search, missingness and invalid rules", () => {
  const model = fixture();
  assert.equal(model.rows.publications[1]?.fields.year, 2023);
  assert.equal(model.rows.publications[3]?.fields.year, null);
  assert.deepEqual(
    model
      .query("publications", 'ÉCOLE "visual learning" EJ', emptyGroup())
      .map((r) => r.id),
    ["one"],
  );
  const expression = emptyGroup();
  expression.children = [{ ...newRule("venue", "v"), operator: "is not" }];
  assert.equal(model.query("publications", "", expression).length, 0);
  expression.children = [
    { ...newRule("venue", "v"), operator: "is not", includeUnknown: true },
  ];
  assert.equal(model.query("publications", "", expression).length, 3);
  assert.ok(filterError(newRule()));
  assert.ok(
    filterError({
      ...newRule("year", "2025"),
      operator: "between",
      upper: "2024",
    }),
  );
});
