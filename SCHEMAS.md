# MyPub JSON schemas

This document is the official specification of JSON files written or consumed by MyPub. It defines catalog schema version 2, including field forms, meanings, invariants, and cross-record constraints. [DESIGN.md](DESIGN.md) defines product behavior and workflows; where it shows abbreviated examples, this document controls the file format. Runtime validators and TypeScript types must implement this document without weakening it.

The core and CLI implement schema version 2 directly. No production version-1 catalogs exist, so v1 compatibility and migration are out of scope (section 15). Unsupported catalog versions are rejected before mutation. DESIGN.md identifies remaining workflow refinements.

Revised 7 September 2026: entry matching policies and exclusions, optional Scholar details, literal author text and completeness, Scholar-only nullable citation observations, record-level update times without per-field timestamps, removal of publication status, and admission of duplicate arXiv identifiers with audit errors. These decisions are reflected in the version-2 types, validators, core operations, and CLI.

The same day's date clarification makes `publication_date` the main optional bibliographic date, with optional `submission_date`, `acceptance_date`, `online_date`, and `issued_date`. These are top-level publication fields and preserve the supplied precision; the former nested `dates` object is unsupported.

User and change-audit attribution uses the catalog repository's Git committer identity. There are no application-user records or independently stored actor fields; section 2.5 defines this boundary.

## 1. Scope and notation

The specification covers:

- shared, Git-synchronized catalog files under `catalog/`;
- machine-local JSON state under `local/`;
- the backup `manifest.json`; and
- the lossless native JSON interchange envelope.

SQLite indexes, Git/LFS pointer files, locks, input BibTeX/CSV, and generated non-JSON exports are not JSON schemas. A transaction may contain staged copies of any catalog record; those copies retain their original schemas.

The integrated SQLite read model at `local/index.sqlite` is derived, machine-local data and must never be tracked by Git or Git LFS, including its sidecar and rebuild files. Its internal database schema version is independent of the canonical JSON schema version; rebuilding it does not change catalog formats. DESIGN.md section 2.3 defines the implemented refresh and query behavior.

The tables use these terms:

| Term | Meaning |
| --- | --- |
| required | The property must be present, even when its value is an empty array or object. |
| optional | Omit the property when its value is unknown or inapplicable. Do not write it with `null` unless this specification explicitly permits `null`. |
| non-empty string | A JSON string containing at least one Unicode code point after trimming. Stored significant whitespace is preserved unless a field says it is normalized. |
| UUID | A lowercase RFC 4122 UUID string in canonical `8-4-4-4-12` form. Random version-4 UUIDs are used when MyPub allocates identities. |
| timestamp | An RFC 3339 UTC instant with seconds and a trailing `Z`, for example `2026-09-06T08:00:00Z`. Fractional seconds may be read but writers omit them. |
| local date | `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`, using a proleptic Gregorian calendar. Reduced precision means the source supplied only that precision; it must not be expanded with invented month/day values. |
| URI | An absolute URI string. Web links normally use `https`. |
| repository path | A `/`-separated path relative to the catalog repository root. It must not begin with `/`, contain an empty, `.` or `..` segment, use `\`, or escape the root after resolution. |
| JSON Pointer | An RFC 6901 pointer. The empty string addresses the whole target record. |

Unless stated otherwise, a record is a JSON object, property names are case-sensitive, and unknown properties are invalid. Schema evolution uses `schema_version`, not ad hoc fields. Readers may preserve unknown fields only while recovering an unsupported newer catalog; they must not edit or normalize that catalog.

## 2. Common representation rules

### 2.1 Serialization

Canonical files are UTF-8 without a byte-order mark, formatted with two-space indentation and one trailing newline. Writers use the field order shown in the complete examples when practical; object property order is not semantic. Array order is semantic unless a field explicitly says otherwise.

Strings are stored as entered after field-specific normalization. Preserve Unicode, punctuation, capitalization, and bibliographic braces where meaningful. Do not HTML-escape ordinary Unicode. JSON numbers must be finite; counts, years, and byte sizes are integers.

Optional values are omitted. Empty required collections are written as `[]` or `{}`. `null` is allowed only where explicitly named: a Scholar citation count/profile metric/annual citation value, a conflict side representing deletion, the native envelope's absent Scholar profile, or an unavailable backup Git bundle. In numeric observation fields, `null` means “observed but unavailable/unknown,” never zero.

### 2.2 Versions, identity, and time

Every shared catalog record except `catalog/config/author.json` and `catalog/gscholar/profile.json` has an immutable `id`. Every catalog and repository-local state JSON file defined here has `schema_version: 2`. The per-user application configuration in section 10.1 has no catalog schema version. The backup manifest and native interchange envelope have independent versions as noted in sections 13 and 14.

Entity `created_at` is when the record first entered this MyPub library, not when the publication, person, venue, or source object came into existence. `updated_at` is the last accepted change to that record. An evidence capture does not update a curated entity unless it produces an accepted change. Writers must not change `created_at`; accepted changes set `updated_at` to a timestamp no earlier than its previous value.

Metadata uses record-level update times only. There are no per-field observation/update timestamps. Citation samples and annual citation snapshots retain their specific observation times; profile captures, evidence, decisions, and record presence/lifecycle events retain their own event times. `updated_at` does not assert that every retained metadata value was freshly observed at that instant.

References always use complete UUIDs. Filenames, UUID prefixes, citation keys, author keys, and venue keys are never foreign keys. A referenced record may be archived or a merge tombstone but must exist and resolve without a redirect cycle.

### 2.3 Keys and uniqueness

`citation_key`, `author_key`, and `venue_key` are non-empty, user-facing, stable handles. Their grammar is `[A-Za-z0-9][A-Za-z0-9._:+-]*`; comparisons are case-sensitive, but a catalog should warn about keys differing only by Unicode-normalized case. Each key is unique within its own collection, including archived and merged records. A key changes only through an explicit rename operation.

Arrays described as sets must contain no duplicate values. Unless a normalization rule is stated, duplicate comparison uses exact JSON string equality. URLs, aliases, tags, roles, and identifier aliases are sets; author credits, citation samples, capture history, proposals, and review targets are ordered sequences.

### 2.4 Filenames and discovery

Entity and review filenames use `<slug>_<uuid-prefix>.json` and the directories in [DESIGN.md section 2.1](DESIGN.md#21-private-catalog-repository--proposed-folder-plan). Slugs are derived presentation paths, not schema fields. Implementations discover records by recursively reading JSON and indexing full `id` values. Fixed files retain their fixed names.

The complete path rules, including Unicode normalization, year/surname buckets, collision suffix extension, and transactional renames, are normative in DESIGN.md. A path mismatch is a validation issue, not a change of identity.

### 2.5 Git identity and audit attribution

Git commit objects are authoritative for who committed catalog changes. Audit/history output derives the full commit object ID, committer name, committer email, and commit time from each relevant commit. Use its recorded **committer**, not its author or the current Git configuration. Git author metadata may be displayed separately. MyPub-generated commits use Git's effective identity in the catalog repository without an application override or synthetic fallback identity.

No JSON schema here defines a user account, user-ID mapping, or a canonical `created_by`, `updated_by`, `decided_by`, `committer`, or commit-attribution field. Do not copy Git attribution into entity, proposal, review, or owner-configuration records. A containing commit ID is not embedded in the record it commits. A rebuildable history index or query response may expose Git metadata without becoming another authoritative store.

`self_author_id` remains a bibliographic identity/Scholar-owner setting, independent of the Git committer. Review decisions retain their reasons and `decided_at`; record update and citation observation times remain independent of commit time. Identify a decision's committer from the commit introducing that decision transition, using full record UUIDs across renames, rather than the latest commit touching any part of the record. Uncommitted changes have no committed attribution yet. Imported source actor IDs/names may be retained inside opaque evidence with their source context; they are not MyPub user accounts or substitutes for Git committer metadata.

Git clones/backups with retained history preserve attribution. Native JSON preserves catalog records and evidence but carries no Git-history guarantee; source committers cannot be recovered from absent history. New importing or reconciliation commits use their actual Git committer and do not relabel retained historical commits. DESIGN.md section 2.2 defines the corresponding workflows.

## 3. Library record

Path: `catalog/library.json`.

```json
{
  "schema_version": 2,
  "id": "ec772398-a875-4df3-979d-68b42558c33a",
  "name": "My Publications",
  "created_at": "2026-09-06T08:00:00Z",
  "updated_at": "2026-09-06T08:00:00Z"
}
```

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `schema_version` | required integer, exactly `2` | Selects all shared catalog schemas. Every active catalog file must use the library's version. |
| `id` | required UUID | Immutable identity of this library. Native imports retain their source library ID as provenance but do not replace it. |
| `name` | required non-empty string | User-facing library name; it need not be globally unique. |
| `created_at` | required timestamp | Catalog creation time. |
| `updated_at` | required timestamp | Last accepted edit to this file. |

## 4. Publication records

Path: `catalog/publications/<year-or-unknown_year>/<title-slug>_<uuid-prefix>.json`.

### 4.1 Publication object

```json
{
  "schema_version": 2,
  "id": "b6f75c51-98f3-4e9c-af55-16dafb11a7cb",
  "citation_key": "Doe2026Example",
  "gscholar_entry_id": "593de6b0-af11-42e2-9062-c742bf154ad5",
  "type": "journal",
  "title": "An Example Paper",
  "authors": [
    {
      "name": "Jane Q. Doe",
      "author_id": "9b4fce15-a27c-4dca-9c73-84ca1c74b5e2",
      "roles": ["co_first", "corresponding"]
    }
  ],
  "authorship_note": "Jane Q. Doe and Alex Chen share first authorship.",
  "venue": {
    "name": "Journal of Example Research",
    "venue_id": "cbf1272a-2268-452a-961c-78c6a783820f"
  },
  "publication_date": "2026-08-15",
  "identifiers": {"doi": "10.1000/example"},
  "volume": "42",
  "issue": "3",
  "pages": "101-118",
  "urls": ["https://doi.org/10.1000/example"],
  "tags": ["computer-vision"],
  "relations": [],
  "attachments": [],
  "created_at": "2026-09-06T08:00:00Z",
  "updated_at": "2026-09-06T08:00:00Z"
}
```

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `schema_version` | required integer `2` | Publication schema version. |
| `id` | required UUID | Immutable local publication identity. |
| `citation_key` | required key string | Stable citation/export handle. It does not change automatically with metadata. |
| `gscholar_entry_id` | optional UUID | Confirmed association with exactly one Scholar entry. Several publications may point to the same entry. Candidates never appear here. |
| `type` | required enum | One of `arxiv`, `conference`, `workshop`, `journal`, `book-chapter`, `thesis`, `other`. It describes this record, not a related version. |
| `title` | required non-empty string | Curated bibliographic title with meaningful Unicode/capitalization preserved. |
| `authors` | required array of author credits | Ordered printed byline. It may be empty only for a genuinely anonymous/unknown work and produces a warning. |
| `authorship_note` | optional non-empty string | Readable publication-level statement about credited contribution/correspondence. It does not create roles by itself. |
| `venue` | optional publication venue | Exact publication-specific venue wording and optional identity link. Absence means no venue is recorded. |
| `publication_date` | optional local date | Main bibliographic date, with the supplied year/month/day precision. It need not be classified as online, issue, or submission date. |
| `submission_date`, `acceptance_date`, `online_date`, `issued_date` | optional local dates | Independently supported lifecycle dates; see section 4.4. They are not required to record a publication date. |
| `identifiers` | required identifier object | Identifiers belonging to this publication. `{}` is valid. Related-version identifiers do not belong here. |
| `arxiv_versions` | optional non-empty array of arXiv revisions | Observed revisions for an arXiv record; see section 4.5. Omit for no revision evidence. |
| `volume` | optional non-empty string | Bibliographic volume, preserved as text (for example `42` or `S1`). |
| `issue` | optional non-empty string | Bibliographic issue/number, preserved as text. |
| `pages` | optional non-empty string | Page or electronic-location range as printed. Do not parse it into numbers. |
| `article_number` | optional non-empty string | Article/eLocator when distinct from pages. |
| `urls` | required array of unique absolute URIs | Curated landing pages or resources. Order is preferred display order. A URL is not a managed attachment. |
| `tags` | required array of unique non-empty strings | User-curated labels. Exact spelling is stored; matching may be normalized by search. |
| `notes` | optional non-empty string | Free-form private catalog notes. It is not external evidence. |
| `relations` | required array of relations | Outgoing publication relations stored only on this source publication. |
| `attachments` | required array of attachments | Managed file manifests. Attachment IDs are unique across the library. |
| `primary_attachment_id` | optional UUID | ID of one attachment in this record, normally the default paper to open. It must not name another publication's attachment. |
| `archived_at` | optional timestamp | Presence means the publication is archived (soft-deleted). Removed on restoration; absence means active in the catalog, without implying a publication lifecycle status. |
| `created_at`, `updated_at` | required timestamps | Local record lifecycle; see section 2.2. |

There is no publication `status` field in version 2. Do not substitute a required status-like field or infer publication stage from absence of `archived_at`.

`pages` and `article_number` may coexist only when the source genuinely supplies both distinct values. Primary DOI identifiers must be unique among retained publication records after normalization. Duplicate normalized arXiv IDs are admitted and retained on distinct publication UUIDs; section 16 reports them as audit errors without blocking storage or synchronization. ISBN need not be unique because several chapters may share a book ISBN.

### 4.2 Author credit

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `name` | required non-empty string | Name exactly accepted for this publication. It remains authoritative even when `author_id` is present. |
| `author_id` | optional UUID | Confirmed link to an author identity. Absence means unresolved, not “no identity exists.” |
| `name_parts` | optional name-parts object | Reviewed structure of this credited form, not the identity's preferred form. |
| `roles` | optional array of unique role enums | Any of `co_first`, `corresponding`, `co_last`, `equal_contributor`. Omission and `[]` both mean no special role recorded, not verified absence. Writers omit an empty array. |
| `equal_contribution_group` | optional non-empty string | Publication-local opaque label grouping equal-contribution credits. It conveys no first/last role. At least two credits should share a used label. |
| `note` | optional non-empty string | Source-specific authorship wording that cannot be represented by controlled roles. |

`name` is serialized first. Credit array position is the only stored author order; there is no position field or `first`/`last` role. A resolved author may appear at most once in one publication. `co_first` and `co_last` should each occur on at least two credits; a singleton is valid only with a validation warning. Roles require supplied or manual evidence and must never be inferred from position.

### 4.3 Name parts

Used by author identities and credits.

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `family` | optional non-empty string | Full reviewed family name, including particles/compound portions. |
| `given` | optional non-empty string | Given and middle names in natural order. |
| `suffix` | optional non-empty string | Generational or bibliographic suffix, excluding authorship markers. |

At least one property must be present. Do not guess name parts from token position. A mononym may be explicitly recorded as `family`; otherwise retain only the literal name.

### 4.4 Venue, dates, and identifiers

A publication venue object has:

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `name` | required non-empty string | Bibliographic venue/proceedings wording for this publication. It is not a cache of the venue identity name. |
| `venue_id` | optional UUID | Confirmed link to a venue record. Absence means unresolved venue identity. |
| `event_year` | optional integer, `1000`–`9999` | Year of a conference/workshop edition. It is independent of publication dates and does not select the publication directory. |

Publication dates are optional top-level fields:

| Field | Meaning |
| --- | --- |
| `publication_date` | Main bibliographic publication date; `"2024"` is sufficient when only the year is known. A generic source publication date does not need a more specific lifecycle classification. |
| `submission_date` | Original submission date; subsequent arXiv revision submissions belong in `arxiv_versions`. |
| `acceptance_date` | Acceptance date when known. |
| `online_date` | First online publication date when separately known. |
| `issued_date` | Formal issue/publication date when separately known. |

Every present value is a local date (`YYYY`, `YYYY-MM`, or `YYYY-MM-DD`), not a timestamp. Most records need only `publication_date`. Omit unknown dates; do not invent a month/day, copy the generic date into lifecycle fields, or infer dates from type or archive state. There is no version-2 nested `dates` object or separate duplicate `year` field on publications.

Filing and default year filters use `publication_date` first, then `issued_date`, then `online_date`; an arXiv record without those dates may use its original `submission_date`. Otherwise use `unknown_year/`. Acceptance, import, event, and later revision years do not select the directory. Keep independently known dates even when their years differ; show which field supplies the filing year. Suspicious lifecycle ordering produces a warning, not an automatic rewrite of the bibliographic date.

This curated `publication_date` must be a valid precision-preserving local date. Scholar's same-named source field is deliberately literal text (section 7.2); malformed source text remains in the mirror/evidence until reviewed rather than being copied into the curated field.

The identifier object permits:

| Field | Form and normalization |
| --- | --- |
| `doi` | DOI string without `doi:` or resolver URL, trimmed and ASCII-lowercased; for example `10.1000/example`. |
| `arxiv` | Base arXiv identifier without `arXiv:`, URL, `.pdf`, or version suffix; ASCII-lowercased. Legacy category IDs remain valid. |
| `isbn` | ISBN-10 or ISBN-13 string with hyphens/spaces removed; `X` is uppercase. Syntax/checksum is validated. |

Every present identifier is a non-empty string. `{}` is valid.

### 4.5 arXiv revision

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `version` | required positive integer | Numeric suffix (`v1` becomes `1`). Unique and ascending in the array. |
| `submission_date` | required local date | Submission date of this revision. |
| `source_review_id` | optional UUID | Review evidence supporting this observation. |

When revisions exist, the publication's `submission_date` equals the earliest known/original submission rather than the latest revision date. Later revisions do not change its main `publication_date` automatically.

### 4.6 Relation

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `type` | required enum | `published_version_of`, `extends`, or `related_to`. |
| `target_id` | required UUID | Existing target publication; it must differ from the containing publication ID. |
| `note` | optional non-empty string | Explanation specific to this directed relation. |

The pair `(type, target_id)` is unique within a source record. `published_version_of` and `extends` are directed and must be acyclic across the catalog. `related_to` is displayed bidirectionally but stored once; adding a reverse duplicate is invalid.

### 4.7 Attachment

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `id` | required UUID | Immutable attachment identity, unique across the library. |
| `role` | required enum | `paper`, `supplement`, `slides`, `video`, or `other`. |
| `label` | optional non-empty string | Editable human description; changing it does not rename the file. |
| `original_filename` | required non-empty string | Basename supplied on ingestion, with no path separators, `.` or `..`. |
| `media_type` | required lowercase MIME type | Detected/declared media type such as `application/pdf`. |
| `size_bytes` | required non-negative integer | Exact byte length of stored content. |
| `storage` | required literal `git-lfs` | Storage backend for this schema version. |
| `path` | required repository path | Exactly `attachments/<publication-id>/<attachment-id>/<safe-filename>`, where IDs match the containing records. |
| `sha256` | required string | Lowercase 64-hex SHA-256 digest of the bytes. |
| `source_url` | optional absolute URI | Location from which bytes were obtained; it does not prove continued availability. |

Attachment manifests and LFS pointers change in one catalog transaction. A pointer file is not proof that bytes are locally available.

## 5. Author identity records

Path: `catalog/authors/<surname-bucket>/<surname-first-slug>_<uuid-prefix>.json`.

```json
{
  "schema_version": 2,
  "id": "9b4fce15-a27c-4dca-9c73-84ca1c74b5e2",
  "author_key": "jane-q-doe",
  "preferred_name": "Jane Quinn Doe",
  "name_parts": {"family": "Doe", "given": "Jane Quinn"},
  "aliases": ["Jane Q. Doe", "Jane Doe"],
  "identifiers": {
    "google_scholar": "exampleProfileId",
    "orcid": "0000-0002-1825-0097"
  },
  "identifier_aliases": [
    {"provider": "google_scholar", "value": "previousProfileId", "note": "Previous profile"}
  ],
  "disambiguation_note": "Computer vision researcher",
  "created_at": "2026-09-06T08:00:00Z",
  "updated_at": "2026-09-06T08:00:00Z"
}
```

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `schema_version` | required integer `2` | Author schema version. |
| `id` | required UUID | Immutable person identity. Equal names never imply equal IDs. |
| `author_key` | required key string | Unique stable CLI handle. |
| `preferred_name` | required non-empty string | Natural-order display name for the identity. It does not rewrite publication credits. |
| `name_parts` | optional name-parts object | Reviewed structure of `preferred_name`, used for filing and identity-level formatting. |
| `aliases` | required unique string array | Curated searchable variants not already equal to `preferred_name`. They do not create publication links. |
| `identifiers` | required identifier map | Zero or one current confirmed value for each initially supported provider. `{}` is valid. |
| `identifier_aliases` | optional unique identifier-alias array | Previous or additional confirmed IDs belonging to this person. Mistaken assignments are removed, not retained here. |
| `disambiguation_note` | optional non-empty string | Human aid for distinguishing identities; private and not required to be unique. |
| `archived_at` | optional timestamp | Presence means archived. Existing links still resolve; new links require restoration. |
| `merged_into` | optional UUID | Surviving author for a merge tombstone. It implies `archived_at`, differs from `id`, and must resolve. |
| `created_at`, `updated_at` | required timestamps | Local record lifecycle. |

The identifier map permits `google_scholar` and `orcid`. A Scholar value is the opaque, case-preserved `user` query parameter, not a URL or article ID. ORCID is canonical uppercase-check-character form `0000-0000-0000-000X` after URL/prefix removal and checksum validation.

An identifier alias contains required `provider` (`google_scholar` or `orcid`) and required normalized `value`, plus optional non-empty `note`. The pair `(provider, value)` must be unique across current identifiers and aliases of all non-merged identities. Redirects formed by `merged_into` must be acyclic. Author records never store publication IDs.

## 6. Venue identity records

Path: `catalog/venues/<preferred-name-slug>_<uuid-prefix>.json`.

```json
{
  "schema_version": 2,
  "id": "cbf1272a-2268-452a-961c-78c6a783820f",
  "venue_key": "journal-example-research",
  "kind": "journal",
  "preferred_name": "Journal of Example Research",
  "abbreviation": "J. Example Res.",
  "aliases": ["JER", "J. Example Research"],
  "urls": ["https://example.org/journal"],
  "created_at": "2026-09-06T08:00:00Z",
  "updated_at": "2026-09-06T08:00:00Z"
}
```

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `schema_version` | required integer `2` | Venue schema version. |
| `id` | required UUID | Immutable venue-series identity. |
| `venue_key` | required key string | Unique stable CLI handle. |
| `kind` | required enum | `journal`, `conference`, `workshop`, `repository`, or `other`. |
| `preferred_name` | required non-empty string | Default identity display name. It need not be unique. |
| `abbreviation` | optional non-empty string | Default abbreviated display; it need not be unique. |
| `aliases` | required unique string array | Curated historical/alternative names; omit the preferred name itself. |
| `urls` | required array of unique absolute URIs | Identity-level venue homepages. |
| `disambiguation_note` | optional non-empty string | Human aid for distinguishing similarly named venues. |
| `archived_at` | optional timestamp | Presence means archived. Existing links remain resolvable. |
| `merged_into` | optional UUID | Surviving venue for a merge tombstone; implies `archived_at` and forms no cycle. |
| `created_at`, `updated_at` | required timestamps | Local record lifecycle. |

A venue identifies a journal or recurring conference/workshop series, not an annual event, volume, issue, publisher, or proceedings book. Venue records never store publication IDs.

## 7. Google Scholar mirror

The mirror contains exactly one selected profile. Scholar strings are literal observed metadata, not curated author/venue links. Google Scholar is the only citation source; imported captures of Scholar data retain that origin even when supplied through a file or migrated database.

### 7.1 Profile record

Path: `catalog/gscholar/profile.json`.

```json
{
  "schema_version": 2,
  "profile_id": "exampleProfileId",
  "captures": [
    {
      "captured_at": "2026-09-06T08:00:00Z",
      "coverage": "complete",
      "source_review_id": "74c6a5ce-d1b6-4367-a577-997c66d9d86b",
      "observed_entry_ids": ["593de6b0-af11-42e2-9062-c742bf154ad5"],
      "totals": {"citations": 1234, "h_index": 18, "i10_index": 25}
    }
  ],
  "created_at": "2026-09-06T08:00:00Z",
  "updated_at": "2026-09-06T08:00:00Z"
}
```

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `schema_version` | required integer `2` | Profile schema version. |
| `profile_id` | required non-empty string | Selected opaque, case-preserved Scholar profile ID. It must equal a confirmed identifier of `self_author_id`. |
| `captures` | required capture array | Chronological accepted capture history. It may initially be empty. |
| `created_at`, `updated_at` | required timestamps | Mirror configuration lifecycle. |

A capture contains required `captured_at`, `coverage`, `source_review_id`, and `observed_entry_ids`. `coverage` is `complete`, `partial`, or `unknown`. Entry UUIDs are unique in a capture and resolve to entries for this profile. Optional `totals` has any of `citations`, `h_index`, and `i10_index`; each present value is a non-negative integer or `null`. `null` means the metric was part of the capture but unavailable. Omission means it was not captured. Captures are ordered by `captured_at`; equal times are allowed only when their source reviews differ and evidence is non-conflicting.

Only a newer successful `complete` capture can establish that a prior entry is missing. A profile switch is a migration, not an edit of `profile_id` in place.

### 7.2 Entry record

Path: `catalog/gscholar/entries/<year-or-unknown_year>/<title-slug>_<uuid-prefix>.json`.

```json
{
  "schema_version": 2,
  "id": "593de6b0-af11-42e2-9062-c742bf154ad5",
  "profile_id": "exampleProfileId",
  "scholar_id": "exampleEntryId",
  "title": "An Example Paper",
  "authors": ["Jane Q. Doe", "Alex Chen"],
  "authors_text": "JQ Doe, A Chen",
  "authors_completeness": "complete",
  "venue": "Journal of Example Research",
  "year": 2026,
  "publication_date": "2026/8/15",
  "volume": "42",
  "issue": "3",
  "pages": "101-118",
  "publisher": "Example Press",
  "scholar_url": "https://scholar.google.com/citations?view_op=view_citation&user=exampleProfileId&citation_for_view=exampleProfileId:exampleEntryId",
  "matching": {"policy": "eligible"},
  "first_seen_at": "2026-09-06T08:00:00Z",
  "last_seen_at": "2026-09-06T08:00:00Z",
  "presence": "present",
  "source_review_id": "74c6a5ce-d1b6-4367-a577-997c66d9d86b",
  "citation_history": [
    {
      "observed_at": "2026-09-06T08:00:00Z",
      "count": 12,
      "source_review_id": "74c6a5ce-d1b6-4367-a577-997c66d9d86b"
    }
  ],
  "created_at": "2026-09-06T08:00:00Z",
  "updated_at": "2026-09-06T08:00:00Z"
}
```

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `schema_version` | required integer `2` | Entry schema version. |
| `id` | required UUID | Immutable local mirror-entry identity. |
| `profile_id` | required string | Must equal the selected profile ID. |
| `scholar_id` | required non-empty string | Opaque external entry ID, unique within `profile_id`; it is not a profile ID or DOI. |
| `title` | required non-empty string | Last observed source title. |
| `authors` | required array of non-empty strings | Retained ordered source names, interpreted with `authors_completeness`. `[]` is valid when unavailable. Duplicate strings are allowed because distinct people may share names. |
| `authors_text` | optional non-empty string | Literal source byline/overview text, preserving abbreviations and ellipses. It can coexist with a fuller detail-page array and is not generated by joining `authors`. |
| `authors_completeness` | required enum | `complete`, `partial`, or `unknown`, describing the retained `authors` array, not profile coverage or whether every author identity is resolved. |
| `venue` | optional non-empty string | Last observed source venue text. |
| `year` | optional integer `1000`–`9999` | Last observed source publication year. It determines the entry directory. |
| `publication_date` | optional non-empty string | Literal source publication date, including partial or malformed source text. It is not constrained to a curated local date and does not override `year` automatically. |
| `volume`, `issue`, `pages` | optional non-empty strings | Literal source bibliographic values, independently of curated publication fields. |
| `publisher` | optional non-empty string | Literal publisher text supplied by Scholar. |
| `patent_office`, `application_number` | optional non-empty strings | Source patent details; these do not create a patent publication or require a linked local publication. |
| `description` | optional non-empty string | Source description/abstract as supplied. |
| `scholar_url` | optional absolute URI | Source entry detail link. Its entry/profile parameters, when present, must agree with this entry's IDs. |
| `cited_by_url` | optional absolute URI | Source cited-by link; its absence does not by itself prove zero citations. |
| `matching` | required matching-policy object | Persistent eligibility/exclusion policy; see section 7.3. Matched/unmatched state is derived from publication links. |
| `first_seen_at` | required timestamp | Earliest accepted capture in which this external entry was observed. |
| `last_seen_at` | required timestamp | Most recent accepted capture in which it was observed. It does not advance when absent. |
| `presence` | required enum | `present` means last observed at `last_seen_at` without subsequent confirmed absence; `missing` requires applicable complete-capture evidence. Neither is a claim about the live website now. |
| `missing_since` | conditionally required timestamp | Required only for `missing`; the complete capture time that first established absence. |
| `source_review_id` | required UUID | Review supporting the latest accepted bibliographic change or initial creation. |
| `citation_history` | required citation-sample array | Dated observed total citations. Samples are never collapsed merely because counts are equal. |
| `annual_citations` | optional annual-snapshot array | Dated observations of Scholar's per-year citation bars. |
| `created_at`, `updated_at` | required timestamps | Local mirror-record lifecycle. |

No `field_observed_at` or other per-field time map is stored. `updated_at` records the latest accepted record change, including policy or citation changes. Retained metadata can come from different captures; original payloads remain in reviews without requiring separate timestamps on those fields. `first_seen_at`, `last_seen_at`, and `missing_since` describe record presence, not individual field freshness.

`authors_completeness: "complete"` requires evidence that the retained ordered list is complete. `partial` means known truncation/omissions; `unknown` means completeness was not established. An empty parser result is normally `[]` with `unknown`, not a claim of an authorless work. Ellipses are preserved in `authors_text`/evidence, never inserted as author names. Update `authors` and its completeness together. A sparse capture may update `authors_text` while retaining a fuller accepted array and its completeness; raw overview text need not be identical to that array. Missing detail fields do not erase retained values or fill them from the curated publication.

A citation sample has required `observed_at`, required `count` (non-negative integer or `null`), and required `source_review_id`. Optional boolean `estimated` means known approximation when true, source-represented exactness when false, and unknown estimate status when omitted. The reference must support a Google Scholar observation; no other provider can supply a count. At most one non-conflicting sample exists per `(observed_at, source_review_id)`. Samples are ordered by observation time; different source reviews at the same time must agree on count, and any supplied estimate flags must not conflict.

Each later accepted citation check appends a sample, including an unchanged count, a decrease, or `null` when a successful check could not find the count. Zero is a known zero. A metadata-only import that does not check citations, or a failed request, adds no citation sample. A complete profile capture newly establishing absence of an entry also records a null sample at that capture time; partial coverage cannot establish absence. Correcting an erroneous sample requires an explicit reviewed correction, preserving its prior evidence and Git history; it is not an ordinary refresh.

The current citation count is derived from the latest sample's `count`, including `null`; never fall back to an older non-null count or use `updated_at` to order samples. No samples means no citation observation yet and a derived count of `null`. A publication without a confirmed Scholar association also has a derived count of `null`, without inventing an entry or sample. Bibliographic JSON does not duplicate a current citation scalar on publications or entries. Displays/exports may show the latest known historical number separately with its observation date, but must not present it as the current count when the latest result is null.

An annual snapshot has required `observed_at`, `counts`, and `source_review_id`. `counts` is an object whose keys are four-digit years and whose values are non-negative integers or `null`. It records bars independently; values are not summed into a total or backdated into citation history.

An entry is retained when missing, merged, split, replaced, or unlinked. Publication associations exist only on publications.

### 7.3 Matching policy and decisions

A matching object has:

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `policy` | required enum | `eligible` or `excluded`. Eligibility permits candidates; it never creates a confirmed association. |
| `reason` | conditionally required non-empty string | Required for `excluded`; optional rationale for an explicitly restored eligible policy. |
| `decision_review_id` | conditionally required UUID | Required for `excluded` and for explicit policy reversals; identifies an accepted policy proposal or accepted evidence-only migration decision. Optional for initial eligibility. |

For example:

```json
{
  "matching": {
    "policy": "excluded",
    "reason": "This profile entry is outside the publications I want to catalog.",
    "decision_review_id": "74c6a5ce-d1b6-4367-a577-997c66d9d86b"
  }
}
```

Exclusion is entry-wide and persists across imports, changes to source metadata, and synchronization. It suppresses automatic candidate generation against every publication without removing the entry, altering presence, or stopping citation refreshes. Excluded entries must have no confirmed incoming publication links. Excluding a linked entry requires a reviewed transaction that unlinks all affected publications as well as setting its policy; an exclusion-only write with remaining links is invalid. Restoring eligibility does not restore former links. Reasons and decision times remain in review history, with committer attribution supplied by Git. Any historical source actors stay inside imported evidence rather than adding account/actor fields to the entry or review.

Confirmed matches live only in `publication.gscholar_entry_id`. A candidate is a review proposal targeting that publication, using `operation: "link"`, `path: "/gscholar_entry_id"`, and `proposed` equal to the candidate entry UUID. Replacing an existing link uses an explicit `replace` proposal with the previous UUID in `current`. Several candidates do not create several accepted links; accepting one must reconcile competing proposals, and optimistic validation prevents stale proposals from overwriting it.

Rejecting a link/replace proposal rejects that publication–entry pair, not the entire entry. A retained rejected proposal suppresses automatic suggestions for the same pair until explicitly reopened; `candidate_ids` alone does not reject every listed candidate. Reopening changes its state to pending, removes its terminal `decided_at`, recalculates review state, and requires fresh current-value/revision checks. Git and immutable evidence preserve the earlier decision. Creating another proposal must not bypass an unreopened rejection. Unlinking clears a confirmed association and leaves the entry eligible unless a separate exclusion or pair rejection is explicitly accepted.

Matching evaluates entry eligibility and retained pair rejections before proposing links. A duplicated arXiv identifier never selects one publication arbitrarily: matching returns the competing candidates for review. Confirmed links survive duplicate-identifier audit findings unless explicitly corrected. Reconciliation distinguishes matched entries, eligible unmatched entries, excluded entries, rejected pairs, and pending candidates; presence is a separate dimension. Policy edits conflict as one object during synchronization, and the combined catalog must satisfy the exclusion/link constraint.

## 8. Owner configuration

Path: `catalog/config/author.json`.

```json
{
  "schema_version": 2,
  "self_author_id": "9b4fce15-a27c-4dca-9c73-84ca1c74b5e2"
}
```

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `schema_version` | required integer `2` | Configuration schema version. |
| `self_author_id` | optional UUID | Confirmed author identity representing the library owner. Omission means it is not configured. |

The ID must resolve to a non-merged author. If a Scholar profile exists, the author must have its `profile_id` as a current or alias `google_scholar` identifier. This file contains no duplicate names or profile details. Version 2 has no active `catalog/config/venues.json`.

## 9. Review and immutable evidence records

Path: `catalog/reviews/<summary-slug>_<uuid-prefix>.json`.

Reviews are the durable decision/evidence unit, with committer attribution supplied by Git history as defined in section 2.5. One record can describe an import batch, proposed edits, an identity decision, a merge, migration, or synchronization reconciliation. Evidence is immutable after creation; decisions and proposal states may change. There is no separate decision-maker user field.

```json
{
  "schema_version": 2,
  "id": "74c6a5ce-d1b6-4367-a577-997c66d9d86b",
  "summary": "Import Google Scholar 2026-09-06",
  "kind": "import",
  "state": "pending",
  "targets": [
    {"entity_type": "publication", "entity_id": "b6f75c51-98f3-4e9c-af55-16dafb11a7cb"}
  ],
  "evidence": {
    "provider": "google_scholar",
    "captured_at": "2026-09-06T08:00:00Z",
    "source_reference": "supplied profile export",
    "payload": {"rows": []},
    "completeness": "complete",
    "parser_version": "mypub/2",
    "input_fingerprint": "b4b2f76d0fb65b93c63b5f6dd42fd0c8e096e659f8458f84bc3ad8a0f6e5b73f"
  },
  "proposals": [
    {
      "id": "39280970-d0c4-4c67-8ff0-3f933a15c822",
      "target": {"entity_type": "publication", "entity_id": "b6f75c51-98f3-4e9c-af55-16dafb11a7cb"},
      "operation": "replace",
      "path": "/title",
      "current": "Example paper",
      "proposed": "An Example Paper",
      "state": "pending"
    }
  ],
  "created_at": "2026-09-06T08:00:00Z",
  "updated_at": "2026-09-06T08:00:00Z"
}
```

### 9.1 Review fields

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `schema_version` | required integer `2` | Review schema version. |
| `id` | required UUID | Immutable review identity. |
| `summary` | required non-empty string | Stable readable description and filename source. State changes do not rename it automatically. |
| `kind` | required enum | `import`, `change`, `identity`, `merge`, `migration`, or `sync`. |
| `state` | required enum | `pending`, `partially_accepted`, `accepted`, `rejected`, or `deferred`. It summarizes proposal states; a no-proposal evidence record may be directly accepted/rejected. |
| `targets` | required target array | Entities principally concerned. It may be empty for unmatched/batch evidence. Duplicate targets are invalid. |
| `source_review_id` | optional UUID | Existing review supplying evidence for this review. It must differ from `id`; chains are acyclic. |
| `evidence` | optional evidence object | Required for direct external import/migration capture; omitted when `source_review_id` fully identifies existing evidence. |
| `proposals` | required proposal array | Proposed atomic changes. It may be empty when evidence requires no catalog change. |
| `decision_note` | optional non-empty string | Overall human rationale. Per-proposal notes remain on proposals. |
| `decided_at` | optional timestamp | Time the overall review reached accepted/rejected state. Required for those terminal states; omitted while pending/deferred/partial. |
| `created_at`, `updated_at` | required timestamps | Review lifecycle. Evidence timestamps retain their separate source meanings. |

A target contains required `entity_type` and optional `entity_id`. Entity type is `library`, `publication`, `author`, `venue`, `gscholar_profile`, or `gscholar_entry`. `entity_id` is required except for `library` and `gscholar_profile`, whose fixed record is identified by type. A target may name a proposed not-yet-created UUID.

### 9.2 Evidence

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `provider` | required non-empty string | Controlled adapter/source name such as `doi`, `arxiv`, `google_scholar`, `bibtex`, `csv`, `json`, or `pubman2`. Unknown providers remain valid strings. |
| `captured_at` | required timestamp | When this payload was obtained or, for migration, frozen. It is not an entity update time. |
| `source_reference` | optional non-empty string | Portable description or URI. Never rely only on a temporary or machine-absolute file path. |
| `payload` | required any JSON value | Original parsed payload without semantic rewriting. Exact JSON `null` is allowed inside opaque evidence. Secrets and credentials are forbidden. |
| `completeness` | required enum | `complete`, `partial`, or `unknown`, scoped to `source_reference` and provider. |
| `parser_version` | required non-empty string | Parser name/version that produced the retained payload. |
| `input_fingerprint` | required lowercase 64-hex string | SHA-256 of a documented canonical input representation, used for idempotent reimport. It is not an entity ID. |

The entire `evidence` value is immutable. If a correction is needed, create another review that references the original.

### 9.3 Proposal

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `id` | required UUID | Stable proposal identity within the review. |
| `target` | required target | Entity to create/change/link/archive/merge. |
| `operation` | required enum | `create`, `replace`, `remove`, `link`, `unlink`, `archive`, `restore`, or `merge`. |
| `path` | conditionally required JSON Pointer | Required for `replace`, `remove`, `link`, and `unlink`; omitted for whole-record operations. |
| `expected_revision` | conditionally required lowercase 64-hex SHA-256 | Required for operations on an existing record; omitted for `create`. Hash the full record using recursively sorted object keys (UTF-16 code-unit order), original array order, JSON string/number encoding, and no whitespace. |
| `current` | optional any JSON value | Value at proposal creation. Required when replacing/removing a present value; omitted when setting an absent field. Explicit `null` is allowed when the current value itself is JSON null. |
| `proposed` | optional any JSON value | Required for `create`, `replace`, `link`, and `merge`. For `create`, it is the complete proposed record. |
| `candidate_ids` | optional unique UUID array | Ordered plausible identities/matches; suggestions only. |
| `state` | required enum | `pending`, `accepted`, `rejected`, or `deferred`. |
| `decided_at` | conditionally required timestamp | Required exactly for `accepted` or `rejected`. |
| `decision_note` | optional non-empty string | Per-proposal rationale. |

Acceptance is optimistic: `current` and the target revision must still match before applying. A review never embeds transient confidence as accepted truth. Overall state is `accepted`/`rejected` only when every proposal has that state, `partially_accepted` when terminal decisions differ or some remain, `deferred` when all undecided proposals are deferred, and otherwise `pending`.

## 10. Machine-local settings

Path: `local/settings.json`. This file is not synchronized.

```json
{
  "schema_version": 2,
  "attachment_mode": "complete",
  "pinned_publication_ids": [],
  "pinned_attachment_ids": [],
  "updated_at": "2026-09-06T08:00:00Z"
}
```

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `schema_version` | required integer `2` | Local settings schema version. |
| `attachment_mode` | required enum | `complete` requests all current files; `selective` materializes pinned files/publications on demand. |
| `pinned_publication_ids` | required unique UUID array | Publications whose current attachments should remain offline on this device. Dangling IDs warn but are retained for recovery. |
| `pinned_attachment_ids` | required unique UUID array | Individual attachments to keep offline. Publication pins subsume but do not rewrite this list. |
| `updated_at` | required timestamp | Last settings edit. |

Local availability, remote availability, and pending-upload state are computed from the worktree/LFS and are not persisted as authoritative fields here.

### 10.1 Per-user application configuration

Path: `~/.config/mypub/config.json`, outside all catalogs. This is a manually editable JSON object shared by MyPub commands for the current operating-system user. It is not synchronized, exported, or included in catalog backups. It has no timestamps or catalog schema version.

```json
{
  "repo_path": "~/Data/MyPubRepo"
}
```

`repo_path` is optional: a non-empty absolute directory path or a path beginning with `~/` (bare `~` is also supported). MyPub expands the current user's home directory; it does not expand environment variables or other users' tildes. Relative config paths are rejected so changing the working directory cannot select a different catalog accidentally. Unknown properties, malformed JSON, null values, and unreadable files report a `CONFIG` error. A missing file or `{}` supplies no default.

Repository selection is explicit CLI `--root PATH`, then `repo_path`, then the current working directory. Relative `--root` paths resolve from the working directory; `~/` is expanded there too. An explicit `--root` bypasses configuration loading, allowing use while a malformed config is repaired. Help also works without loading config. `mypub config show` validates and prints the config file path, stored options, and effective repository path without opening the catalog. Reads do not create the config file or directory, initialize a catalog, or fall back from a configured but nonexistent repository. `init` and `restore` use the same selection rules; use `--root` to select a different destination explicitly.

`max_pagesize_main` and `max_pagesize_dropdown` are optional positive safe integers. They limit desktop paper lists to 30 and linked dropdown bibliographies to 15 by default, respectively. The desktop reads them at startup, including with an explicit `--root`; if configuration is invalid with an explicit root, it uses the default sizes. The CLI accepts these preferences but does not use them to limit command output. Additional application-wide preferences can be defined here when implemented. Git identity remains managed by Git; catalog-specific attachment preferences and pins remain in `local/settings.json`.

## 11. Synchronization state and conflicts

### 11.1 Sync state

Path: `local/sync.json`.

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `schema_version` | required integer `2` | Local sync-state schema version. |
| `last_successful_sync` | optional timestamp | Last operation that reconciled with and successfully pushed/found current the configured upstream. A local commit alone is not success. |
| `remote` | optional non-empty string | Git remote name used for that success. |
| `branch` | optional non-empty string | Full local branch name used for that success. |
| `commit` | optional lowercase 40- or 64-hex string | Commit verified at that successful synchronization. |

The four optional success fields are written together only after synchronization with the configured remote upstream succeeds. `mypub commit`, a failed synchronization, and a conflict-resolution choice do not update them. A failed push may leave integrated commits locally without advancing these success fields. An unconfigured catalog may contain only `schema_version`; `mypub sync` reports missing upstream configuration as an error.

### 11.2 Conflict record

Path: `local/conflicts/<conflict-uuid>.json`.

```json
{
  "schema_version": 2,
  "id": "14699418-d966-4367-bfa4-78381a26a339",
  "kind": "record",
  "record_type": "publication",
  "record_id": "b6f75c51-98f3-4e9c-af55-16dafb11a7cb",
  "path": "catalog/publications/2026/an_example_paper_b6f75c51.json",
  "base": {},
  "ours": {},
  "theirs": {},
  "created_at": "2026-09-06T08:00:00Z"
}
```

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `schema_version` | required integer `2` | Conflict schema version. |
| `id` | required UUID | Conflict identity. |
| `kind` | required enum | `record`, `path`, `identifier`, `key`, `reference`, or `attachment`. |
| `record_type` | optional record kind | `publication`, `author`, `venue`, `gscholar_entry`, `gscholar_profile`, `library`, `owner`, or `review`; required when one logical record is known. |
| `record_id` | optional UUID | Full identity used to align renamed records. |
| `path` | optional repository path | Original/relevant path; not identity. |
| `base`, `ours`, `theirs` | required JSON value or `null` | Three-way alternatives. `null` means that side deleted/did not contain the record. Catalog alternatives are parsed records; non-catalog Git conflicts may retain text/blob references in `details`. |
| `details` | optional JSON object | Structured kind-specific facts; never a replacement for preserving alternatives. |
| `created_at` | required timestamp | Detection time. |

A selected record alternative is held in `details.resolution` with base/local/upstream commit IDs and applied by the next sync only while those revisions still match. Resolved conflicts are removed only after their chosen/custom result is durably written and validated. Conflict files contain no credentials.

## 12. Recoverable transaction manifest

Path: `local/transactions/<transaction-uuid>/manifest.json`. Staged records/files reside beside it and retain their normal formats.

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `schema_version` | required integer `2` | Transaction-manifest version. |
| `id` | required UUID | Matches the directory name. |
| `state` | required enum | `staging`, `ready`, `applying`, `committed`, or `rolled_back`. |
| `created_at`, `updated_at` | required timestamps | Transaction lifecycle. |
| `operations` | required ordered operation array | Exact intended filesystem changes. |

An operation has required `type` (`write` or `delete`) and required repository-relative `path`. Logical moves are represented by a staged write at the new path plus deletion of the old path, never by moving the only recoverable copy; `write` requires `staged_path` (a safe path relative to the transaction directory) and `sha256` (lowercase 64-hex digest). `delete` stages no content. Paths may address catalog JSON or managed attachments but never `.git`, `local`, or outside the repository. Recovery is idempotent: `committed` means every operation reached its intended final state; `rolled_back` means none remains applied.

## 13. Backup manifest

Path: `<backup-root>/manifest.json`. Backup bundles use their own format version because they can contain a catalog of another version.

```json
{
  "schema_version": 2,
  "created_at": "2026-09-06T08:00:00Z",
  "library_id": "ec772398-a875-4df3-979d-68b42558c33a",
  "catalog_schema_version": 2,
  "git_bundle": "repository.bundle",
  "includes_current_attachments": true,
  "includes_historical_lfs_objects": true
}
```

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `schema_version` | required positive integer; currently `2` | Backup-manifest format, independent of catalog schema. Version 2 adds `catalog_schema_version`. |
| `created_at` | required timestamp | Backup completion time. |
| `library_id` | required UUID | Backed-up library identity. |
| `catalog_schema_version` | required positive integer | `catalog/library.json` version contained in the backup. |
| `git_bundle` | required repository path or `null` | Bundle path, or `null` only for an explicitly metadata/files-only backup. |
| `includes_current_attachments` | required boolean | Every attachment referenced by the backed-up active catalog was copied and hash-verified. |
| `includes_historical_lfs_objects` | required boolean | All LFS objects reachable from retained Git refs were copied. |

A successful “complete backup” requires both booleans true and a non-null bundle. Restore verifies the manifest, library ID, record schemas, attachment hashes, and included bundle/object availability before activation.

## 14. Native JSON interchange

Native export is a single lossless dependency-closed envelope for catalog records and evidence. It does not include Git commit history or guarantee preservation of source Git attribution; use a Git clone or backup bundle for that. It is generated under `local/exports/` or another requested destination and is never an authoritative second catalog.

```json
{
  "format": "mypub-native",
  "format_version": 1,
  "exported_at": "2026-09-06T08:00:00Z",
  "source_library": {
    "id": "ec772398-a875-4df3-979d-68b42558c33a",
    "name": "My Publications",
    "schema_version": 2
  },
  "selection": {"publication_ids": ["b6f75c51-98f3-4e9c-af55-16dafb11a7cb"]},
  "publications": [],
  "authors": [],
  "venues": [],
  "gscholar_profile": null,
  "gscholar_entries": [],
  "reviews": []
}
```

| Field | Presence and form | Semantics |
| --- | --- | --- |
| `format` | required literal `mypub-native` | Distinguishes interchange from a bare record or generic JSON import. |
| `format_version` | required integer `1` | Envelope version, independent of embedded catalog schemas. |
| `exported_at` | required timestamp | Export generation time. |
| `source_library` | required object | Required source `id`, `name`, and `schema_version`; descriptive provenance only. |
| `selection.publication_ids` | required unique UUID array | Publications explicitly selected, in requested order. |
| `publications` | required publication array | Selected records plus any publications needed as relation targets when dependency closure is requested. |
| `authors`, `venues` | required entity arrays | Every directly or transitively referenced identity/tombstone required to resolve exported records. |
| `gscholar_profile` | required profile object or `null` | Profile context when any entries are included; otherwise `null`. |
| `gscholar_entries` | required entry array | Referenced Scholar entries. |
| `reviews` | required review array | Evidence referenced by included records, plus referenced review chains. |

Managed attachment bytes are not embedded. Their manifests remain in publications; an export option may place verified bytes in a sibling `attachments/` tree using the same paths. Import always previews library-ID, UUID, key, normalized identifier, path, and attachment collisions. It never overwrites or silently merges destination records.

A bare publication object or array may be accepted as a lossy convenience import, but it is not a native export and cannot claim to preserve referenced identities or evidence.

## 15. Supported-version boundary

The user confirmed on 7 September 2026 that the codebase has never been used in production and no version-1 catalogs exist. The application reads and writes version 2 only; it does not migrate v1 catalogs, accept old publication status/nested dates, or keep old observation formats active. Unsupported versions fail before a write. Future schema evolution will define its own explicit compatibility policy when needed.

This boundary is unrelated to the external PubMan2 database. Its one-time migration plans and scripts remain solely under `migrate_pubman/`; that conversion has not been performed.

## 16. Whole-catalog validation

Structural validation checks each file against its record schema. Blocking semantic validation scans the complete proposed catalog and enforces at least:

- one `library.json`, optional one owner configuration, and optional one Scholar profile;
- exactly one active file per full record UUID and conforming derived paths;
- unique publication citation keys, author keys, venue keys, normalized primary DOI IDs, author identifiers, attachment IDs, and `(profile_id, scholar_id)` pairs;
- all publication, author, venue, Scholar, review, primary-attachment, redirect, and source-evidence references resolve;
- no self relation, duplicate relation, forbidden symmetric duplicate, directed relation cycle, or redirect cycle;
- no repeated resolved author in a publication and no duplicate controlled role on a credit;
- venue/event-year, archive timestamp, merge tombstone, Scholar presence/capture, authors-completeness, matching-policy, and citation-observation conditional rules hold;
- excluded Scholar entries have no confirmed incoming publication links, policy decision references resolve, and pending/rejected matches do not masquerade as confirmed associations;
- attachment paths remain in their containing publication/attachment directories and size/hash match materialized bytes when verification is requested;
- review state agrees with proposal decisions and evidence remains immutable; and
- no secret, credential, machine-absolute path, NaN/infinity, or unsupported unknown property occurs in shared catalog data.

Warnings identify usable but review-worthy states: unresolved author or venue links, an empty byline, singleton co-first/co-last roles, a singleton equal-contribution group, suspicious date ordering, archived link targets, case-confusable keys, stale Scholar observations, unavailable local attachment bytes, and filenames needing repair. Warnings do not redefine stored semantics.

Auditing is distinct from these admission checks. Each normalized arXiv ID assigned to several retained publications produces a `duplicate_arxiv_id` finding with severity `error`, `blocks_write: false`, the normalized identifier, and all affected publication UUIDs. Include archived publications. These records remain valid to save, import, export, migrate, and synchronize. An audit error must be visible and require reviewed resolution, but must not be promoted into a uniqueness rejection by an importer, index, sync routine, or database constraint. Index arXiv IDs as a non-unique lookup returning all candidates. UUID collisions, dangling links, malformed identifiers, and duplicate DOI IDs remain blocking errors.

The `mypub audit` command reports these findings and returns a nonzero result while audit errors remain; `mypub validate` checks the blocking format/reference constraints. Import/sync/migration admission must not be gated on a clean audit exit code. Audit reports are derived from current JSON and can be rebuilt; accepted corrections and their evidence live in reviews and Git. Resolve a duplicate by supported identifier correction/removal, reviewed relation/ownership correction, or an explicit duplicate-record resolution, never by automatically merging equal IDs or suppressing one record.
