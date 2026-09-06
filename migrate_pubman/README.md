# PubMan2 → MyPub migration proposal

Updated 6 September 2026. **The read-only Supabase-to-SQLite snapshot is complete. Conversion to MyPub, attachment acquisition, and cutover have not been performed.** This plan targets the proposed MyPub schema version 2 in [DESIGN.md](../DESIGN.md), not the currently implemented version-1 CLI.

Migrate from a consistent PostgreSQL snapshot, preserve existing entity UUIDs and accepted associations, and build a separate private catalog for reconciliation. The chosen identity policy is to inherit the legacy UUIDs; the user delegated this decision, and no renumbering is needed for the four UUID-bearing entity tables. This is a one-time migration for the sole user of PubMan2. Keep PubMan2 available for recovery until the new catalog passes validation; there is no multiuser rollout or continuing integration to build. Use the legacy Excel export only for a human comparison: it is not a lossless migration source.

## Scope and code organization

All plans, helper scripts, mapping/correction files, migration-specific tests, and dependency declarations used only for this transfer belong under `migrate_pubman/`. This document is its entry point. The migration-only files now have this layout:

```text
migrate_pubman/
├── README.md                # This plan and eventual run instructions
├── scripts/
│   └── snapshot_supabase.py # Read-only inventory and SQLite snapshot
├── tests/
│   └── test_snapshot_supabase.py
├── requirements.txt         # Pinned snapshot dependencies
└── .gitignore               # Python caches and a local virtual environment
```

The snapshot helper and its offline encoding tests are implemented; the MyPub converter remains planned. Do not add a permanent PubMan2 adapter, migration CLI command, dependency, or compatibility layer to `src/`, the normal `mypub` package, or its public API. Scripts may call the ordinary MyPub version-2 API for validation and supported writes; the runtime must never import migration code. General author/venue/Scholar functionality required by the product remains normal MyPub work and is not moved into this folder.

Use `/Users/dhlin/Temp/pubman_tmp` as the user-designated private migration workspace. Source snapshots, credentials, real-data correction files/reports, and the destination private catalog remain outside the tracked application codebase. Keep any private run files inside this folder ignored if used locally; commit only migration plans/code and fictional fixtures. After the transfer, retain this folder as a record of the one-time process, with no ongoing runtime dependency on it.

## Completed snapshot and workspace

The export completed at **2026-09-06 05:28:52 UTC**, from one PostgreSQL `REPEATABLE READ READ ONLY` transaction. `row_security=off` makes a restricted read fail rather than silently return a filtered subset. No source writes or Scholar requests were made.

```text
~/Temp/pubman_tmp/
├── pubman.sqlite            # Original verified SQLite snapshot; keep unchanged
└── pubman.manifest.json     # Table/column mappings, row hashes, schema definitions, file hash
```

The snapshot contains **44 stored tables and 7,308 rows**, covering all non-system-schema tables and PostgreSQL large-object tables. It is 3,805,184 bytes. PubMan data counts are:

| Table | Rows |
| --- | ---: |
| `mypubs.publications` | 466 |
| `mypubs.authors` | 1,303 |
| `mypubs.venues` | 55 |
| `mypubs.publication_authors` | 4,156 |
| `mypubs.gs_entries` | 582 |
| `mypubs.editing_history` | 520 |
| `mypubs.app_users` | 2 |

The account-row count is a storage count, not a claim that other people use PubMan2. Every stored table was copied, including account/hash fields, because the requested SQLite snapshot is a complete private database-data copy. This overrides the earlier selective snapshot proposal below; eventual portable catalog conversion will still omit login credentials and unnecessary operational data. The workspace is mode `0700`, and the SQLite file and manifest are `0600`. No database row values or credentials were printed or committed to the application repository.

SQLite tables are named with their source schema, for example `"mypubs.publications"` and `"auth.users"`. Convenience views `publications`, `authors`, `venues`, `publication_authors`, `gs_entries`, `editing_history`, and `app_users` support easy querying. `__pubman_snapshot_metadata` embeds the manifest (the sidecar additionally contains the SQLite file hash).

Integer/boolean columns use SQLite integers; binary columns use BLOBs. Other values use PostgreSQL's text representation, preserving decimal precision, UUIDs, timestamps, JSON, arrays, empty strings, and SQL nulls. JSON null remains text `null`, distinct from SQL NULL. Constraints, indexes, view/routine/trigger/policy definitions, sequences, and partition metadata are recorded for reference rather than executed as SQLite behavior. Derived views, including the vault decryption view, were not evaluated. This is a migration data snapshot, not a replacement Supabase server or a native PostgreSQL disaster-recovery backup.

`storage.buckets`, `storage.objects`, and the large-object tables are empty. Supabase Storage bytes are not part of a SQL snapshot, but there are no stored object records here to acquire; publication PDF URLs still require later inventory.

Validation passed: source counts versus streamed rows; per-table content hashes versus SQLite readback, including a reopen after commit; the final file hash; SQLite integrity; and the main author/venue/Scholar foreign-key checks. There are no dangling links in those checks and no publication with multiple Scholar-entry matches. This does not yet validate author identities, byline markers, or bibliographic correctness.

Command used from the MyPub code repository (the helper refuses to overwrite an existing snapshot):

```sh
python3 migrate_pubman/scripts/snapshot_supabase.py \
  --env-file /Users/dhlin/Work/PubMan2/.env \
  --output /Users/dhlin/Temp/pubman_tmp/pubman.sqlite
```

Offline helper tests:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s migrate_pubman/tests -v
```

All four tests passed. Future migration analysis should open the baseline SQLite file read-only. Put derived reports or a separate working copy in the same temporary workspace; do not modify the verified snapshot or rerun against live Supabase unless a refreshed snapshot is explicitly needed. No source-edit freeze was claimed or enforced by this export: if PubMan2 changes after this timestamp, decide whether to take a new snapshot before conversion/cutover.

## 1. Inspection findings and evidence

The legacy repository is `/Users/dhlin/Work/PubMan2`, inspected at commit `c685d9b04637d5fa691df439161e3638411137c8`; its working tree was clean. The active schema is `mypubs` in PostgreSQL hosted by Supabase. The checked-in schema and application code establish the mappings below; the deployed schema and row counts have now been captured in the SQLite snapshot and manifest. Detailed source-data quality, owner/profile selection, and availability of PDF files still require local inventory. The snapshot script read the connection configuration without exposing its values.

| Finding | Consequence | Inspected source |
| --- | --- | --- |
| Four entity tables have integer `id` and stable UUID `uid`: `publications`, `authors`, `venues`, `gs_entries` | Reuse `uid` as MyPub `id`; translate integer foreign keys through lookup maps | [Active schema](../../PubMan2/mypubs_pg.sql) |
| `publication_authors` stores `publication_id`, `author_id`, and one-based `author_order` | Preserve each association and its order directly | [Active schema](../../PubMan2/mypubs_pg.sql) |
| `gs_entries.publication_id` is nullable and unique | Existing confirmed matches fit MyPub's at-most-one-entry-per-publication rule; invert the foreign key into the publication JSON | [Scholar migration](../../PubMan2/migrations/003_google_scholar_entries.sql) |
| Scholar records include inactive entries, explicit matching exclusions, detailed metadata, raw parsed payloads, and annual citation breakdowns | Import all relevant states and preserve their different meanings | [Schema](../../PubMan2/mypubs_pg.sql), [presence migration](../../PubMan2/migrations/004_google_scholar_active_entries.sql) |
| The CLI Excel export emits only venue and publication sheets, flattening authors and omitting entity UUIDs, Scholar records, `pub_date`, `gs_page`, `pdf_url`, and audit history | Use a direct relational snapshot, not an Excel round trip | [CLI export](../../PubMan2/pubmanlib/cli/export_cmd.py), [web export](../../PubMan2/pubmanlib/web/export.py) |
| The CLI author lookup ignores middle names; the web lookup includes them | Some source identities may already conflate different spellings or people; preserve associations, then review suspicious cases | [CLI importer](../../PubMan2/pubmanlib/cli/import_cmd.py), [web writes](../../PubMan2/pubmanlib/web/queries.py) |
| The name parser takes the final remaining token as surname and discards recognized generational suffixes | Preserve stored components, flag questionable parsing, and recover original wording only where evidence exists | [Name helpers](../../PubMan2/pubmanlib/names.py) |
| Publication-author rows have no dedicated credited-name or role columns; the user confirms trailing `*` on leading authors encodes joint first authorship | Recover `co_first` from those markers and remove them from names; other roles and exact original bylines still need evidence | [Schema](../../PubMan2/mypubs_pg.sql), [formatting](../../PubMan2/pubmanlib/names.py) |
| Overview sync overwrites total counts and timestamps; detail pages supply `citations_by_year` | The database is not a complete time series of observed totals | [Scholar synchronization](../../PubMan2/pubmanlib/cli/scholar_cmd.py), [parser](../../PubMan2/pubmanlib/scholar.py) |
| The parser maps absent/unparseable citation text to zero and does not retain an estimate flag | A stored zero may mean unknown, and precision cannot be assumed | [Parser](../../PubMan2/pubmanlib/scholar.py) |
| Publications store a PDF URL; no attachment manifest or managed binary store is defined in the inspected schema/application | URL preservation and actual file migration are separate steps; inspect any external storage before claiming files are backed up | [Schema](../../PubMan2/mypubs_pg.sql) |
| `editing_history` records web actions, while CLI import/sync writes do not use that audit helper | Preserve available audit evidence; it is not a complete change log or a safe delta-export mechanism | [Audit helper](../../PubMan2/pubmanlib/auth.py), [CLI importer](../../PubMan2/pubmanlib/cli/import_cmd.py), [Scholar sync](../../PubMan2/pubmanlib/cli/scholar_cmd.py) |

The obsolete MySQL schema under `obsoleted/` is historical reference only. The completed snapshot counts and validation are recorded above; conversion to MyPub remains unperformed.

Google Scholar is the sole citation source, as confirmed by the user. Supabase contains previously captured Scholar data; migrating those stored values does not introduce another citation authority. DOI/arXiv adapters may supply bibliographic metadata only. Missing or uncertain counts remain unknown until supported by Scholar evidence or an explicit correction to that evidence; the migration will not fill them from another service.

## 2. Destination prerequisites and design gaps

Implement the approved MyPub version-2 catalog first: author/venue identities, embedded ordered credits, Scholar entries and scalar links, recursive year/surname filing, readable filenames, ID-based lookup, durable review evidence, and transaction/sync validation. The current [MyPub types](../src/core/types.ts) still declare `SCHEMA_VERSION = 1`, embed name-only authors, and use a string venue. A migration must not feed version-2 data through those current write operations.

The legacy inspection exposes these additional details to settle in the version-2 schema before writing a converter. They are proposals, not silently implemented requirements:

| Gap | Proposed handling |
| --- | --- |
| Author `website` has no explicit field in the author proposal | Add optional author `urls`; keep the original URL. A Scholar-shaped URL can suggest an identifier, but assignment requires review |
| No publication status exists in PubMan2 | Add `status: "unknown"` for migration, or obtain a reviewed batch classification before cutover. Do not silently default every row to published |
| Non-arXiv preprints do not fit the current `arxiv` publication type | Add a general `preprint` type; preserve `arxiv` for positively identified arXiv records. If this extension is declined, explicitly review these records as `other` |
| Scholar entries can be explicitly excluded from matching | Persist an entry-scoped exclusion decision in reviews, including reason, actor reference, and original time; matching/reconciliation must honor it until explicitly reversed. Exclusion must not remove the entry or mark it absent |
| Source-author text can be truncated or only partially parsed | Allow an optional literal `authors_text` and completeness marker alongside an optional full `authors` array; retain source evidence and never invent a complete array |
| Annual citation counts are not cumulative-total observations | Add optional `annual_citations` with `as_of`, `values: [{year, count}]`, and an evidence reference, separate from `citation_history` |
| A migrated zero may not be an observed zero | Store `count: null` when support is absent, preserving `legacy_reported_count: 0` and the reason in review evidence; leave estimate status unspecified |
| Full legacy Scholar details exceed the illustrative entry fields | Define optional source-detail fields for `publication_date`, `volume`, `issue`, `pages`, `publisher`, `patent_office`, `application_number`, and `description`, plus `scholar_url` and `cited_by_url`. Preserve all originals in evidence regardless |
| There is no persisted full-profile capture manifest | Import legacy presence state with evidence and unknown profile coverage. Do not fabricate a complete capture at extraction time |

Publication `pub_date` is an unlabeled publication date: the UI validates its syntax, not whether it means online, issue, or preprint-submission date. Initially use the legacy `year` as a year-precision `dates.issued` bibliographic value with documented provenance. Map an exact `pub_date` to a specific date field only after its semantics and any year disagreement are reviewed; retain the exact original in migration evidence meanwhile. If `year` is absent, the date may propose a year, but an unresolved case stays in `unknown_year/`. Never invent January 1 to represent a year.

## 3. Extract a consistent, complete source snapshot

The snapshot helper now uses the existing PostgreSQL connection configuration without printing credentials. The complete raw SQLite snapshot described above is the authoritative input for the one-time conversion; the following extraction checklist records the planning context and field-preservation goals. All database inspection/extraction runs in a transaction explicitly set to **read-only, repeatable read**, with bounded queries and no calls to legacy import or Scholar-sync routines. No Google Scholar fetch is needed to migrate already stored entries.

1. Inspect deployed columns, constraints, indexes, and migrations against `mypubs_pg.sql`. Record differences before choosing a conversion version. Identify a non-secret source-instance label and the selected Scholar profile; a configured profile is a candidate, and stored profile IDs are the inventory of actual data.
2. Export complete `venues`, `authors`, `publications`, `publication_authors`, and `gs_entries` tables from the same transaction, ordered/paginated by their primary keys. Include unreferenced authors/venues and active, inactive, matched, unmatched, and excluded Scholar rows. Preserve null versus empty, exact identifiers, text, JSON values, and timestamp offsets. Serialize bigint source IDs losslessly, preferably as decimal strings in the transfer format.
3. Export `editing_history`; retain its original actor IDs and, if useful, resolve the owner label using only `id` and `username`. There is one user, so no account provisioning, role migration, or multiuser identity mapping is needed. Do not put `password_hash`, `.env`, session secrets, or login credentials in the transfer catalog. Retain original operational audit fields in the protected source archive; the portable catalog needs action, time, actor label, entity reference, and relevant details, not IP addresses or browser fingerprints.
4. Build a manifest containing extraction time, source code revision, deployed-schema fingerprint, table counts, file hashes, profile counts, and extraction completeness. Mark database-export completeness separately from Scholar-profile coverage: a full SQL export can still contain an incomplete online-profile mirror.
5. Place the snapshot and an independently restorable source backup outside both the MyPub code repository and the live destination. A separately secured administrative backup may preserve legacy accounts for PubMan2 recovery; it is not imported into the publication catalog. Verify snapshot hashes before conversion.

Use one frozen snapshot for the offline conversion. Stop your own PubMan2 edits and Scholar/Excel jobs before taking it, then leave the source unchanged until verification is complete. There are no other users to coordinate. Retry conversion into disposable staging from the same snapshot as needed; if you do change the source, take a new complete snapshot and restart staging. The publication/author/venue tables lack row-level update timestamps, and this one-time task does not need an incremental-sync mechanism.

## 4. Record mapping

Preserve `venues.uid`, `authors.uid`, `publications.uid`, and `gs_entries.uid` exactly. Construct `(source instance, table, integer id) → UUID` maps from the snapshot; keep them in migration review evidence and the transfer manifest. Do not match existing foreign keys by names or titles. Missing UUIDs or conflicts with different destination records are blocking exceptions, never reasons to silently re-identify records.

Generate missing citation, author, and venue keys deterministically once, with collision checks, and retain the chosen keys in the migration manifest. For example, a citation key can use surname/year/title token plus a UUID prefix. Use stable, persisted migration/review IDs and one fixed run timestamp so retries of the same snapshot do not generate new records, new timestamps, or duplicate evidence.

| Source | Target and conversion |
| --- | --- |
| `venues.uid`, `name`, `abbr`, `website` | Venue `id`, `preferred_name`, `abbreviation`, `urls`; generate `venue_key`. Preserve nulls in evidence; omit absent optional target values |
| `venues.type` | `journal`, `conference`, `workshop` keep their meanings. Map `preprint` to venue kind `repository` only where the venue is actually a repository; ambiguous labels require review |
| `authors.uid` | Author `id`; preserve every row even when names are identical |
| `authors.first_name`, `mid_name`, `last_name` | Extract the confirmed co-first marker before building `preferred_name` or name parts. For normally parsed rows, combine first/middle as `name_parts.given` and copy the cleaned last name as `name_parts.family`. Preserve original components. A standalone marker stored as `last_name` requires surname-recovery review; do not blindly copy or reparse it |
| `authors.website` | Proposed author `urls`; preserve it even if it is not a Scholar profile. There are no dedicated legacy ORCID or Scholar-author-ID columns |
| `publications.uid`, `title` | Publication `id`, `title`; generate a stable `citation_key` |
| `publications.venue_id` | Resolve to venue UUID and embed `venue: {name, venue_id}`. Use the stored venue name as initial bibliographic wording and preserve its abbreviation in evidence; the schema has no per-publication original venue spelling |
| Venue type → publication type | Journal/conference/workshop map directly; classify preprints using actual source evidence, without turning every preprint into arXiv |
| `publications.year`, `pub_date` | Apply the date policy in section 2. Preserve both originals and flag disagreements; do not silently change a curated year to match Scholar |
| `volume`, `issue`, `pages` | Copy corresponding strings. Do not reinterpret page-like values as article numbers without review |
| `doi`, `eprint` | Normalize only after validation, preserving raw strings in evidence. Map `eprint` to `identifiers.arxiv` only when it is a valid arXiv identifier; preserve revision suffixes in evidence until a supported revision field is available. Non-arXiv eprints remain explicit unresolved metadata |
| `publications.gs_page` | Preserve as a URL. It is evidence for a possible link, not authoritative over `gs_entries.publication_id` and not a reason to fabricate another entry |
| `publications.pdf_url` | Preserve as a URL and an attachment acquisition candidate; do not create an attachment manifest until bytes have been obtained and verified |
| `publication_authors` | Sort by `author_order`; emit one credit per row with the resolved author UUID and a marker-free credited name. Preserve original order values in evidence, report gaps, reject duplicates/dangling links. Leading authors carrying the confirmed trailing `*` receive `co_first`; other roles remain unrecorded unless supported |
| `gs_entries.publication_id` | Invert each confirmed match to `publication.gscholar_entry_id = gs_entries.uid`. Preserve unmatched rows. Legacy one-to-one links are a valid subset of MyPub's many-publications-to-one-entry model; do not add extra matches automatically |
| `gs_entries.uid`, `citation_id`, `profile_user_id` | Scholar `id`, `scholar_id`, `profile_id`; preserve the full `citation_for_view` identifier, including its profile prefix, and check consistency with `profile_user_id` |
| `title`, `venue`, `year`, `author_names`, `authors` | Source entry fields. Prefer a validated full `author_names` array for `authors`, retaining the literal overview string as proposed `authors_text`. Conflicting or truncated lists remain labeled and do not overwrite publication credits |
| Scholar detail columns and URLs | Map to the proposed optional detail fields; retain every original column in review evidence. Patents and otherwise unsupported items may remain external entries without creating local publications |
| `cited_by_count`, `last_seen_at` | Seed at most one supported current-total observation at the original last-seen time, with provenance. Apply the zero/unknown rule below; never use extraction time as the observation time |
| `citations_by_year`, `detail_fetched_at` | Proposed `annual_citations` as of the detail-fetch time; missing/unreliable times remain unknown in evidence. Never convert yearly bars into cumulative totals or backdated snapshots |
| `first_seen_at`, `last_seen_at`, `detail_fetched_at`, `created_at`, `updated_at` | Preserve source timestamps with their distinct meanings. `updated_at` may reflect matching or deactivation, not a new citation observation |
| `is_active` | Preserve last-known presence as `present`/`missing` with migration provenance; do not claim current online presence or a known full-profile capture date |
| Exclusion flag, reason, confirmer ID/time | Entry-scoped retained exclusion review with translated actor reference and original timestamp, honored by future matching |
| `source_payload` | Retain verbatim JSON in import review evidence; it is a parsed source representation, not necessarily the original HTML or the latest overview |
| `editing_history` | Read-only legacy audit evidence in reviews, translating resolvable entity IDs through the maps and retaining unmapped/deleted references explicitly. Do not replay historical actions as current writes |
| `app_users` | No live account migration; portable actor references only. Authentication/roles remain part of the legacy system |

PubMan2 has no publication/author/venue creation timestamps, tags, dedicated author-role fields, publication relations, or citation keys in this schema. Use the fixed migration timestamp for new MyPub record creation, explicitly identifying it as catalog-entry creation, and empty/absent values for unsupported fields. The user-confirmed `*` convention is supported evidence for recovering `co_first`, despite the lack of a dedicated role column. Audit records may provide additional historical context but are not complete enough to invent lifecycle timestamps or undelete missing publications.

### Recover co-first authorship from trailing `*`

The user confirms that a trailing `*` on the first several authors denotes **co-first authorship** and is not part of any author's name. Treat this as an established legacy import convention, not an uncertain role heuristic.

For each publication, inspect the ordered credited strings before name normalization, identity comparison, or filename generation. Recognize a single trailing `*` with optional surrounding whitespace, so both `Jane Q. Doe*` and `Jane Q. Doe *` are supported. Remove the marker from the structured credit name and add `roles: ["co_first"]` to each marked author in the leading group, including the first-listed author. Preserve array order and any other independently supported roles. Unmarked credits do not acquire this role merely because they are near the front. Keep the exact marked source string, original source components, publication/order reference, and transformation decision in migration review evidence.

For example, `Jane Q. Doe*, Alex Chen*, Wei Wang` becomes this authors-array excerpt (identity links omitted here):

```json
[
  {"name": "Jane Q. Doe", "roles": ["co_first"]},
  {"name": "Alex Chen", "roles": ["co_first"]},
  {"name": "Wei Wang"}
]
```

The user confirms that PubMan2 mishandled these annotations. Treat marker contamination as a known legacy defect requiring migration repair; the affected row count remains to be established by the source inventory. The inspected parser does not handle this marker: an attached star can remain in `last_name` (for example, `Doe*`), while a whitespace-separated star can itself become `last_name`, with the real surname moved into `mid_name`. Strip the annotation before deriving canonical names, aliases, name parts, surname buckets, and filename stems. In the standalone-star case, recover the clean literal full name, but resolve the surname split from reliable original/structured evidence or a reviewed correction; until then use `unknown_surname/`. Never put `*` into `name_parts.suffix`, and never discard a whole author row just because its stored surname is the marker.

Roles belong to the **publication credit**, not to the shared author identity. Prefer a publication-specific stored input/audit byline when available and aligned to the current ordered list. If the marker is recoverable only from a shared legacy author row, a marked leading group can supply the proposed migration credits under this confirmed convention, but record that evidence limitation and flag conflicting publication-specific strings or ambiguous reuse. Do not propagate `co_first` to all publications linked to a marked identity. Singleton, non-leading/noncontiguous, repeated, or marker-only cases go into the anomaly report without inventing additional co-first authors or treating the marker as corresponding authorship. Preserve any cleanly supported annotation while resolving the anomaly.

The inventory must report marker-bearing author components, affected publication slots, malformed surname splits, and groups of source UUIDs whose names become equal after cleanup, with separate counts for repaired and unresolved cases. Removing a star may make two source authors' cleaned names identical. Preserve their inherited UUIDs and publication links and propose identity review; do not merge them just because marker removal makes the strings equal. This convention applies to the confirmed byline format, not to arbitrary asterisks in titles, citation counts, or other sources. Raw Scholar/source text remains available as evidence.

### Important source limitations

**Names and identity.** Preserve the source associations as imported curated state, with an explicit migration decision. The original input spelling is not stored on the junction table; reconstructing a credit from the current author row does not recover omitted middle names, suffixes, or older name variants. Some web audit records retain submitted author strings and can propose recoveries when their publication, revision, and ordering align. Scholar bylines are external evidence, not an automatic replacement. A first/last-name collision report helps prioritize manual identity splits and merges after migration; it cannot prove which people were conflated.

**Citations and freshness.** Overview sync updates `cited_by_count` and `last_seen_at` on existing rows without refreshing stored overview text/payload; detail fetches update a different set of fields. Therefore `source_payload.overview` may be old, and title/authors/venue/year must not inherit the latest count timestamp. Preserve source timestamp evidence and uncertainty per field/group. The parser uses `... or 0`, so a zero is conservatively unknown unless retained Google Scholar evidence confirms a real zero. Positive stored counts can be retained as legacy observations, with estimate status unknown. Do not reconstruct past totals from current annual bars, sum those bars as a replacement total, or synthesize profile-level metrics.

**Profile scope.** Inventory all `profile_user_id` values first. Migrate the selected profile to the single-profile mirror. Preserve rows from other profiles in the source archive and migration evidence; report any affected publication matches as unresolved instead of silently dropping or importing them into the wrong profile. Identify the owner's author record from explicit evidence/selection; do not choose it solely by a same-name match or fabricate a profile assignment.

## 5. Files, layout, and recoverable conversion

Write into a fresh staging catalog outside the codebase, using the agreed paths:

```text
catalog/publications/2026/an_example_paper_b6f75c51.json
catalog/authors/d/doe_jane_quinn_9b4fce15.json
catalog/venues/journal_of_example_research_cbf1272a.json
catalog/gscholar/entries/2026/an_example_paper_593de6b0.json
catalog/reviews/import_pubman2_2026_09_06_<uuid8>.json
```

Use `unknown_year/` and `unknown_surname/` where needed. Follow the Unicode/length/collision rules in DESIGN.md; a source `uid` supplies the filename suffix, not its integer database ID. Inventory across every subfolder and compare full UUIDs, not filenames. All source rows must be accounted for by a destination record, relationship, retained evidence, or explicit exception.

Keep ordered raw rows and mapping manifests in migration review evidence, split into bounded batches if necessary. The full database archive stays separate, including any operational/security records omitted from the catalog. Do not copy live credentials or real publication data into this application source repository as fixtures.

For PDFs and other files, first inventory stored URLs and any separately maintained local directories or Supabase Storage buckets. The checked-in system demonstrates URL references, not stored bytes. In a later authorized acquisition step, copy available originals, record byte size/MIME type/hash, allocate stable attachment IDs, and create LFS manifests using the existing full-UUID attachment paths. Authentication failures, expired URLs, missing files, and differing bytes at one URL remain reported exceptions. Preserve each original URL even if acquisition fails. No metadata-only record should be represented as an offline-available attachment.

Retries against the frozen snapshot must produce the same records, paths, links, and review IDs. They rebuild disposable staging; this repeatability is for finishing the one-time transfer, not for ongoing synchronization. After you start editing in MyPub, do not rerun conversion over that live catalog. Fix any remaining issues through normal MyPub edits or narrowly scoped corrections kept here. Commit metadata and verified LFS pointers together only after whole-catalog validation.

## 6. Reconciliation and cutover gates

Produce a durable reconciliation report with source/destination counts and explicit exception rows. The following are requirements for the future migration tooling, not checks claimed to have run today:

- Count and UUID equality for publications, authors, venues, and selected-profile Scholar entries, including unreferenced entities and inactive/excluded entries; every out-of-profile or rejected row remains accounted for.
- Exact publication-author membership and order preservation, plus marker-to-role reconciliation for every marked credit; validate all author, venue, and Scholar references. Compare cleaned names with recorded transformations, not raw-name equality alone.
- Exact confirmed Scholar-match preservation for the selected profile, zero/one entry per publication, and retained exclusion reasons/times. A plain `gs_page` disagreement creates an exception rather than overriding a confirmed match.
- Full field accounting against the snapshot, including exact null/raw values in evidence, dates, websites, PDF URLs, Scholar details, count uncertainty, annual bars, and source timestamps.
- No duplicate normalized primary identifiers, unsupported required fields, unexplained source-key collisions, dangling references, or filename overwrites. Preserve problematic rows in staging/evidence while resolving issues; do not discard records to make validation pass.
- Search/filter results agree with source UUID membership for representative years, surnames, venues, and match states. Derived filing years and surname corrections are explicit in the report.
- Repeated conversion, interrupted writes, prefix collisions, Unicode surnames, same-name authors, attached/spaced co-first markers, marker-contaminated surname fields, conflicting byline evidence, missing years, inactive/excluded entries, incomplete Scholar details, and year disagreements have fixture-based coverage when implementation begins.
- Validate the repository with the version-2 core/CLI, rebuild the index, exercise native JSON round trips, and compare readable bibliographies with the legacy export. Export comparison supplements the relational checks.
- Verify acquired attachment hashes and LFS availability, plus restore the catalog and available files on a fresh installation. If any files are unresolved, state exactly which and obtain an explicit metadata-only cutover decision before claiming travel readiness.

Recommended sequence:

1. Finalize the destination schema gaps in section 2. Implement general version-2 support in MyPub and keep the one-time extraction/conversion/verification helpers in `migrate_pubman/`.
2. Stop your own legacy edits/jobs, take one read-only consistent snapshot and recovery backup, and leave PubMan2 unchanged.
3. Convert into disposable staging, review exceptions and representative records, and retry from that same snapshot until validation passes. Pay particular attention to byline markers, identity cleanup, citations, and matching exclusions.
4. Verify the complete catalog and available attachments, then start using MyPub and synchronize its private Git/LFS repository. Retain the snapshot and PubMan2 backup.
5. If verification fails before new MyPub edits, discard staging and resume PubMan2. After new MyPub edits, preserve those edits before any recovery action; do not build automated reverse synchronization for this one-time move.

No Supabase deletion, schema change, account removal, or backend decommissioning is part of this migration plan. Those are separate later actions after successful use and restore verification.

## 7. Information to establish during the inventory

The source code is sufficient to draft this plan. The deployed schema/count snapshot is now available. Conversion still needs a review of that inventory, selected Scholar profile and owner identity, the location of any actual attachment files/storage, the target private catalog path/remote, and review of the proposed status/preprint/detail-field additions. These are execution inputs; they have not been inferred from credentials or claimed as verified here.
