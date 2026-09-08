# Legacy database compatibility review

Rechecked 7 September 2026 against the revised DESIGN.md and authoritative SCHEMAS.md version-2 design, incorporating the user's seven decisions, publication-date clarification, and Git-committer attribution policy. This updates the 6 September assessment. The version-2 core and CLI have since been implemented. This compatibility assessment did not convert source data or create a destination catalog.

**Verdict: no further schema gap has been identified for the current snapshot. The seven decisions and publication-date clarification provide destinations for the legacy bibliographic data and effective matching state without invented lifecycle facts.** Owner identity and catalog/attachment locations are execution inputs. Duplicate identifiers and uncertain name/identifier attribution are audit work, not reasons to reject otherwise valid imported records.

DESIGN.md and SCHEMAS.md now document the decisions. The read-only inventory helper and one-time migration documentation stay under this directory. No application or converter implementation is included.

## Evidence and scope

The recheck used the same frozen `pubman.sqlite` snapshot in the user-selected temporary workspace, completed at **2026-09-06T05:28:52.028886Z**. Its SHA-256 still matches the extraction manifest:

```text
c81102c9fc18dc6eb18a0ace3d689c2c6cbd1519486d25290db99651b2690be7
```

SQLite `integrity_check` returned `ok`. No live Supabase or Scholar requests were made. The complete database archive includes operational tables; the catalog assessment focuses on publication data and relevant audit history, without importing authentication records or credentials.

| Source collection | Rows | Assessment |
| --- | ---: | --- |
| Publications | 466 | Generic publication dates/years map directly; no status required; arXiv duplicates are admitted with audit errors |
| Authors | 1,303 | Shared identities and per-publication credits fit |
| Venues | 55 | Separate venue catalog fits |
| Publication–author associations | 4,156 | All can become ordered linked credits |
| Scholar entries | 582 | One profile; revised details, matching, completeness, and nullable citation observations accommodate the source |
| Editing history | 520 | Preserve selected audit fields as migration evidence, without replaying actions |

The [inventory helper](scripts/audit_compatibility.py) prints aggregate counts and source integer IDs for identifier conflicts. It uses SQLite read-only mode and does not print names, source payloads, accounts, or credentials:

```sh
python3 migrate_pubman/scripts/audit_compatibility.py ~/Temp/pubman_tmp/pubman.sqlite
```

It inventories populated columns and specific compatibility concerns; it is not a full schema validator, identity adjudicator, or converter. Targeted read-only inspection additionally checked source date strings, marker positions, identifier spelling, and the legacy parser/write paths described below.

## What already fits

- **Identity and relationships:** all four entity collections have canonical UUIDs, with no duplicates within or across collections. Preserve those UUIDs. All author, venue, and Scholar foreign keys resolve. There are no repeated authors within a publication, empty publication bylines, or gaps in author order.
- **Scalar Scholar links:** 410 confirmed matches can be inverted into scalar `publication.gscholar_entry_id` values; no legacy publication has several linked entries. These remain a backward-compatible subset of the scalar-or-array field. The other 56 publications remain unlinked. All 582 entries belong to one profile, and their external citation IDs have a consistent profile prefix. The mirror can retain all 172 unlinked entries, including 35 excluded entries.
- **Unreferenced identities:** retain five authors and one venue with no current publication links. The new catalogs permit this; deleting them is unnecessary.
- **Same-name people and variants:** five groups containing ten author rows have identical reconstructed names after trailing-star cleanup. Separate UUIDs and publication-specific names support these without automatic merging. These groups are review candidates, not proof of duplicate people.
- **Roles:** the credit-level `co_first` role represents the confirmed star convention. The active associations contain two marked leading credits, positions 1 and 2 of one publication. Five author rows contain stars in their surnames; three are currently unreferenced. None has a standalone `*` surname. No retained publication audit byline contains `*`. These are recoverable annotations, not a need for another role field.
- **Venues and publication kinds:** 33 conference, 16 journal, five workshop, and one preprint venue map to the venue catalog. The preprint venue is arXiv, with 127 publications; no non-arXiv preprint venue appears in this snapshot. These publications use the generic `preprint` publication type. The other publication counts are 296 conference, 38 journal, and five workshop.
- **Filing:** all 466 publications have years, spanning 2005–2026. Scholar has 46 entries without years, which fit `unknown_year/`. Four matched publication/Scholar pairs disagree on year; separate year directories and stable links already support this. Unreviewed surname structure can use `unknown_surname/`.
- **Annual citations:** SCHEMAS.md section 7.2 already supports the 509 nonempty annual snapshots, containing 2,308 year/count bars with no duplicate years within a snapshot. Convert them to `annual_citations[].counts` at the retained detail-fetch time, separately from total-citation samples. The earlier README proposal for `as_of`/`values` is superseded by the official schema.
- **Evidence:** migration reviews can retain bibliographic source rows, original names, parsed Scholar payloads, source integer-ID/UUID maps, and relevant historical decisions. MyPub creation times correctly mean catalog entry creation, so missing legacy publication/author/venue creation timestamps do not require fabrication.

## Compatibility of the revised design

### 1. Matching exclusions and candidate decisions — resolved

All **35 excluded Scholar entries** can be retained with `matching: {policy: "excluded", reason, decision_review_id}`. The referenced accepted migration review retains the original confirmation time and source actor ID inside imported evidence. The actual Git committer of the migration commit supplies MyPub attribution; source actors do not become application users or rewritten Git identities. They have no publication links in the snapshot, so they satisfy the exclusion/link constraint without removing anything. The other entries begin eligible.

Exclusion persists through source refresh, suppresses matching against all publications, and leaves presence/citation collection independent. Pair-specific rejected link proposals, explicit reopening, unlinking, and restoring eligibility now have defined behavior. Do not reinterpret historical unmatch actions as pair rejections: the source did not record that broader decision.

### 2. Optional Scholar details — resolved

SCHEMAS.md now enumerates optional entry fields for all populated detail columns:

| Legacy Scholar field | Non-null rows |
| --- | ---: |
| `publication_date` | 537 |
| `volume` | 116 |
| `issue` | 43 |
| `pages` | 321 |
| `publisher` | 101 |
| `patent_office` | 19 |
| `application_number` | 19 |
| `description` | 566 |
| `scholar_url` | 582 |
| `cited_by_url` | 509 |

These are source fields directly on the entry. Literal `publication_date` supports the source's partial date strings and malformed `"1"` value without pretending that it is a valid curated date. Patents can remain unmatched Scholar entries; no patent publication type is needed for this snapshot. All populated source/cited-by URLs are absolute web URLs, and all 582 detail links agree with the stored profile and entry IDs. URLs remain references, not managed attachments.

### 3. Literal author text and completeness — resolved

All 582 entries have an overview author string; **152 contain ellipses**. **19 have empty detail author arrays**, all with patent-office metadata. Map the overview string to `authors_text` and the parsed detail array to `authors`, with `authors_completeness` determined from evidence. The 19 empty parser results use `unknown`; a nonempty parsed list does not automatically prove completeness. Ellipses never become authors. Complete source arrays can coexist with abbreviated overview text.

### 4. Nullable, updateable Scholar citations — resolved

**73 stored totals are zero**, all without a cited-by URL. Because the legacy parser converted missing/unparseable text to zero, retain unsupported zeros as `count: null` with the original value in evidence. Positive totals can remain numbers. The now-optional `estimated` flag is omitted because the legacy source did not record it; no invented true/false value is required.

Retain current-total samples at the original last-seen time and supported older detail-total samples at their own detail-fetch times. Future accepted checks append a number or null; the latest observation determines the current count even when null. Metadata-only imports and failed requests add no sample. Google Scholar remains the only citation source. Annual snapshots fit the existing separate year-bar representation.

### 5. Per-record metadata timestamps — resolved

For all **582 entries**, count observations are newer than detail fetches: details date to 23 July 2026 and latest overview/count observations to 25 July. **124 totals differ from their older payload values.** The revised design needs no per-field timestamp attribution, including for the 20 nonblank venue fields inherited from overview fallback.

Use the fixed migration time for MyPub record creation/update; preserve original payload and source lifecycle timestamps in evidence. Keep supported source observation times on citation samples and annual snapshots. Entry presence/capture times remain record events. `updated_at` does not claim that every bibliographic field was freshly observed.

There is no stored complete-profile capture manifest. All 582 rows are active, so preserve last-known present state and unknown coverage, without a fabricated complete capture or missing-since time. This is already representable.

### 6. Publication status and generic dates — resolved

Removing publication status resolves the absence of status on all 466 source records. Do not classify them into draft/submitted/accepted/published. Optional `archived_at` is separate catalog archive state; PubMan2's current retained publications need no fabricated archive timestamp.

All **466 publications have a generic bibliographic year**, and **one journal publication has a full `pub_date`**, without year disagreement. The user has confirmed that `publication_date` is the main bibliographic date, with optional specific lifecycle dates. Store the one full date directly and the other **465 year-only values** as `"YYYY"` in the top-level `publication_date`. No more specific lifecycle assertion or invented month/day is needed. Keep original source columns in evidence.

`submission_date`, `acceptance_date`, `online_date`, and `issued_date` are optional and stay absent without supporting facts. Publication filing/filter year comes from `publication_date` first, then the documented fallbacks. The frozen snapshot therefore retains all 466 known publication years and the full date using supported fields. Scholar's literal source `publication_date` is distinct from this validated curated date and may retain malformed source text.

## Source-data auditing and execution inputs

### Duplicate arXiv IDs

After normalization, **three arXiv IDs are each assigned to two publications**. The revised schema admits all six UUIDs and reports these groups as `duplicate_arxiv_id` audit errors:

| Source publication integer IDs | Observation |
| --- | --- |
| 173, 468 | Same arXiv ID and same title; candidate duplicate records |
| 347, 348 | Same arXiv ID with different titles; identifier attribution needs review |
| 363, 364 | Same arXiv ID with different titles; identifier attribution needs review |

Preserve all six source UUIDs and their IDs in the catalog; do not drop a row or strip an arXiv ID to pass admission checks. Resolve each group during auditing through supported correction or explicit duplicate-record/relationship decisions. These findings do not block import, sync, or native export. DOI uniqueness remains blocking; there are no duplicate normalized DOI values among the three stored DOIs.

All 143 non-null eprints fit arXiv identifier syntax after removing one `arXiv:` prefix; there are no stored revision suffixes. However, **17 belong to non-preprint publication records**. Syntax alone does not show that an arXiv ID is the primary identity of the conference/journal publication. Review whether it identifies a separate preprint, and then use a publication relation or retained relation proposal. One of the 127 arXiv-venue publications has no eprint; missing identifiers are already supported.

### Names and markers

Clean the two supported leading credits and set `co_first`, preserving the marked strings in evidence. Clean the three unreferenced marked author identities without creating publication roles for them. Preserve all inherited UUIDs, including the five cleaned same-name groups.

The source junction table stores no independent credited spelling. Reconstruction from a shared author row can reproduce current source display, but cannot recover historical middle-name omissions or discarded suffixes. Structured source names may themselves have been produced by the legacy last-token parser. They need review before being represented as reviewed `name_parts`; unresolved structures fit `unknown_surname/`. No schema can recover information already discarded by PubMan2 without additional evidence.

### Owner configuration

One Scholar profile is present, but the author table has no dedicated Scholar identifier column and no populated websites. Schema section 8 requires a confirmed owner identity carrying the selected profile ID. An explicit owner-to-author mapping is still a conversion input; profile presence or same-name matching alone must not create it. This is a bibliographic identity decision, not a missing entity feature or an application-user setup step. The Git committer remains independent of `self_author_id`.

## Complete source-field accounting

| Source field group | Destination/accounting policy |
| --- | --- |
| Four entity `uid` columns | Preserve as entity `id`; integer IDs remain in migration maps/evidence |
| Publication title, volume, issue, pages | Existing typed publication fields; omit SQL nulls in curated JSON and retain original nulls in evidence |
| Publication venue FK | Existing `venue.name` plus resolved UUID link; source venue name is reconstructed wording, not proof of original printed wording |
| Publication year, `pub_date` | Top-level `publication_date`: full `pub_date` for one row, year-only string for 465; original values retained |
| Publication DOI/eprint | Normalize IDs and retain originals; admit arXiv duplicates with audit errors and review ownership/related-preprint attribution |
| Publication `gs_page`, `pdf_url` | Existing publication URLs would preserve links; both columns are entirely null in this snapshot |
| Author first/middle/last name | Reconstructed clean preferred/credit name; reviewed structure and aliases where supported; originals retained |
| Author website | Entirely null here; optional author `urls` remains a useful future extension, but is not an actual-data blocker |
| Venue name, abbreviation, type, website | Existing venue fields; map arXiv venue type to `repository`; all venue websites are null |
| Junction publication/author IDs and numeric order | Resolve full UUIDs, sort credits, retain original order values and marker transformation evidence |
| Scholar local/external/profile IDs | Existing fields; preserve opaque full external citation ID consistently, including profile prefix |
| Scholar publication FK | Existing scalar publication link, inverted from source |
| Scholar title, venue, year | Existing fields, omitting blank venue; preserve conflicts and independent source year |
| Scholar overview text and detailed author names | `authors`, `authors_text`, `authors_completeness`, plus original source evidence |
| Scholar date, volume, issue, pages, publisher, patent fields, description, URLs | Optional typed source-detail fields plus original source evidence |
| Scholar total and cited-by URL | Citation history with nullable counts, optional estimate flag, and typed source URL |
| Scholar annual bars | Existing `annual_citations`, with retained detail observation time |
| Scholar first/last-seen and detail timestamps | Presence times remain record events; detail timestamp retained in evidence and used for supported citation/annual observations, without per-field timestamp fields |
| Scholar created/updated timestamps | Legacy lifecycle facts in evidence, distinct from MyPub record creation/update time |
| Scholar active flag | Last-known present state, unknown profile coverage; do not invent a complete capture |
| Scholar exclusion fields | Entry matching policy with reason and referenced accepted decision evidence |
| Scholar `source_payload` | Immutable migration review evidence, preserving parsed original JSON |
| Editing history | Source action, original time, source actor ID, source entity reference, relevant details in migration evidence (not Git attribution); deleted entity references remain historical evidence, not dangling live catalog links |
| App accounts, password hashes, IP addresses, browser fingerprints, platform schemas | Protected source archive; no live MyPub authentication/account or operational-table migration |

The eight publication-deletion history records do not contain complete deleted records. Preserve that history without pretending to restore eight additional publications. The raw snapshot remains the complete database archive; a portable publication catalog intentionally is not a clone of Supabase's operational schema.

## Git committer attribution — settled

MyPub uses the catalog repository's actual Git committer name/email for each commit and derives attribution from retained Git history. Publication authors and `self_author_id` remain bibliographic identities. There is no application-user catalog, parallel actor field, or migration of PubMan2 accounts.

Legacy action times and source actor IDs may be preserved as imported evidence. They must not become backdated Git commits or substitute committers; the migration commit records the person who actually commits the import. Locally saved changes remain uncommitted until Git records them. A native JSON export preserves records/evidence, while a Git clone or backup with history is required to preserve original Git attribution. This resolves the audit identity policy without another schema entity or source-data decision.

## Execution outcome — 7 September 2026

The catalog was migrated to `/Users/dhlin/Data/MyPubRepo` after the user confirmed the owner/Profile association and that no separate files exist. One explicit surname/given-name correction was applied and retained in evidence. All source entity UUIDs and associations were reconciled; source-field and retained-evidence equality, native interchange, Git integrity, and backup/restore checks passed. See [README.md](README.md) for counts, artifacts, and execution instructions.

Three duplicate-arXiv groups remain valid stored records with audit errors. The five same-name groups, 17 non-preprint arXiv attributions, and four source-year disagreements are retained as review items. These are data-quality follow-ups, not failed migration gates. Missing historical byline variants were not invented. The sole citation source remains Google Scholar, with unsupported current zeros represented as null and original values retained in evidence.
