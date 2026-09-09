# MyPub repository auditing

Implemented specification, 9 September 2026. `mypub audit` performs offline,
read-only repository inspection using the rules below.

The audit covers four aspects:

1. Integrity, completeness, and consistency of publication records.
2. Integrity, completeness, and consistency of Google Scholar entries.
3. Consistency between linked publications and Scholar entries.
4. At most one publication associated with each Scholar entry.

[DESIGN.md](DESIGN.md) describes application workflows. [SCHEMAS.md](SCHEMAS.md)
defines canonical JSON formats. This document defines audit rules and severity.
The cardinality rule is audit-only: write-time validation still permits several
publications to reference one Scholar entry, but auditing reports it as an error.

## 1. Command behavior

```sh
mypub audit
mypub audit --details
mypub audit --json
```

- Audit the current working catalog, including uncommitted changes.
- Read canonical JSON files directly, so auditing works even when malformed data
  prevents the normal catalog reader from loading.
- Run offline, without fetching Scholar, DOI, arXiv, or publisher pages.
- Do not modify records, accept reviews, rebuild the database, commit, or sync.
- Continue inspecting other files when an individual record is invalid.
- Report incomplete coverage explicitly when files cannot be read or checks
  cannot run.
- Include archived publications in structural and uniqueness checks; suppress
  descriptive-completeness warnings for archived publications.
- Include excluded and absent Scholar entries in structural checks; suppress
  descriptive-completeness warnings for excluded entries.

Present, eligible, linked, and archived remain separate concepts. An absent
Scholar entry can retain a valid link; an excluded entry cannot.

## 2. Severity and relationship to validation

Missing descriptive information produces warnings. Malformed records, broken
references, and definite contradictions produce errors. Differences that could
reflect title revisions, abbreviated names, or publication timing remain warnings.

| Condition | Severity |
| --- | --- |
| Missing optional but expected bibliographic information | Warning |
| Potential inconsistency requiring interpretation | Warning |
| Missing schema-required field, invalid value, or malformed file | Error |
| Broken reference, prohibited relationship, or conflicting unique identity | Error |
| Definite disagreement between linked records | Error |

There are two kinds of requirement:

- **Structurally required:** fields needed to represent and interpret a valid
  record. Missing these is an error.
- **Expected for completeness:** fields such as publication date, journal volume,
  or Scholar classification. Missing these is a warning unless the schema
  explicitly requires them.

`mypub validate` continues to enforce schema and reference constraints during
normal operations. `audit` includes those findings and adds bibliographic quality
checks.

New audit-only errors initially affect the audit result without automatically
blocking imports, edits, or sync. In particular, the one-publication-per-Scholar
rule is an audit error. Making it a write-time constraint requires a separate
explicit decision. Existing structural constraints remain enforced. Duplicate
arXiv identifiers retain their existing nonblocking audit-error behavior.

## 3. Shared record integrity

These rules apply to both publication and Scholar records.

| Condition | Severity |
| --- | --- |
| Unreadable file, unparseable JSON, or root that is not an object | Error |
| Duplicate JSON property names within an object | Error |
| Missing or unsupported `schema_version` | Error |
| Missing, malformed, or duplicate full UUID | Error |
| Missing required property or wrong property type | Error |
| Unknown property or unsupported enum value | Error |
| Blank text where a nonempty string is required | Error |
| Invalid date, timestamp, URL, identifier, or repository path under the applicable schema | Error |
| `updated_at` precedes `created_at` | Error |
| Invalid nested author, relation, attachment, citation, or other defined object | Error |
| Duplicate values in a schema-defined set | Error |
| Filename or year directory disagrees with canonical naming rules | Warning |

Apply schema rules recursively. Preserve duplicate-ID records as separate file
observations rather than silently overwriting them in an ID map.

Avoid cascading findings. An invalid `authors` value produces an error for that
field; dependent author-comparison checks are skipped and accounted for in the
coverage result.

## 4. Publication completeness

Schema-required fields:

```text
schema_version, id, citation_key, type, title, authors,
identifiers, extra_urls, tags, relations, attachments,
created_at, updated_at
```

Empty `identifiers`, `extra_urls`, `tags`, `relations`, and `attachments` are
structurally valid.

For active publications, apply these additional completeness checks:

| Condition | Severity |
| --- | --- |
| Empty author list | Warning |
| Author credit has no `author_id` | Warning |
| Missing `publication_date` | Warning |
| Missing venue for journal, conference, workshop, or book chapter | Warning |
| Venue is present but has no `venue_id` | Warning |
| Missing journal volume | Warning |
| Journal has neither pages nor article number | Warning |
| Missing DOI on a journal publication | Warning |
| Book chapter has neither DOI nor ISBN | Warning |
| No DOI, arXiv ID, ISBN, official URL, or paper URL | Warning |

Journal issue numbers are optional because some journals do not use them. Missing
abstract, tags, notes, attachments, author roles, Scholar links, and optional
lifecycle dates do not produce warnings by themselves.

For arXiv-backed preprints, existing stronger requirements remain errors: a base
arXiv ID, complete retrieved version history, and original publication/submission
dates are required.

## 5. Publication consistency

| Condition | Severity |
| --- | --- |
| Duplicate citation key | Error |
| Duplicate normalized DOI | Error |
| Duplicate normalized arXiv ID | Error; remains nonblocking |
| Author, venue, relation target, or referenced evidence record does not resolve | Error |
| Resolved author identity appears in multiple credit positions | Error |
| Author or venue reference has an invalid merge redirect | Error |
| Linked author or venue identity is archived | Warning |
| Exactly one author is marked `co_first` or `co_last`, or an equal-contribution group has one member | Warning |
| Publication type conflicts with linked venue kind, such as a journal linked to a conference venue | Error |
| Relation is self-referential, repeated, cyclic where prohibited, or stored twice for a symmetric relation | Error |
| `published_version_of` does not connect a journal/conference/workshop publication to a preprint | Error |
| Journal `publication_date` and `issued_date` disagree at their shared precision | Error |
| Acceptance definitely precedes submission, or publication definitely precedes acceptance | Warning |
| Attachment manifest or primary-attachment reference violates the schema | Error |
| Same-type active publications have identical normalized titles, compatible author lists, and overlapping publication dates, without a shared identifier establishing duplication | Warning: possible duplicate |

Date comparisons respect precision. A year-only date represents the whole year.
Report an ordering contradiction only when the possible date intervals do not
overlap.

For arXiv histories:

- Versions run consecutively from v1 and have nondecreasing dates.
- Each version contains its required date, title, authors, and abstract.
- `publication_date` and `submission_date` equal the v1 date.
- Current title, author-name sequence, and any supplied current abstract agree
  with the latest stored version after conservative formatting normalization.
- `arxiv_versions` on a non-preprint is an error.

Violations of these arXiv rules are errors. Complete history means through the
latest retrieved version, without asserting online freshness.

Attachment auditing covers manifests and references. Downloading attachments,
checking remote availability, and hashing large local binaries are outside the
initial command scope.

## 6. Scholar completeness

Schema-required fields:

```text
schema_version, id, profile_id, scholar_id, title, authors,
authors_completeness, matching, first_seen_at, last_seen_at,
presence, source_review_id, citation_history,
created_at, updated_at
```

For non-excluded entries:

| Condition | Severity |
| --- | --- |
| Missing `pub_type` | Warning |
| Empty `authors` | Warning |
| `authors_completeness` is `partial` or `unknown` | Warning |
| Missing `year` | Warning |
| Missing venue for journal, conference, workshop, or preprint | Warning |
| Missing `scholar_url` | Warning |
| Empty citation history | Warning |

A latest citation count of `null` explicitly represents an unavailable count and
does not produce a warning. Zero is valid.

Missing detailed date, volume, issue, pages, publisher, description, and patent
details is allowed. Scholar captures can legitimately be sparse.

## 7. Scholar consistency

| Condition | Severity |
| --- | --- |
| Duplicate normalized `(profile_id, scholar_id)` identity | Error |
| Entry belongs to a different profile from the configured mirror | Error |
| Profile prefix embedded in `scholar_id` contradicts `profile_id` | Error |
| Scholar URL explicitly identifies a different profile or citation | Error |
| `last_seen_at` precedes `first_seen_at` | Error |
| `presence` and `absent_since` contradict each other | Error |
| Absent state lacks supporting newer complete-profile capture evidence | Error |
| Excluded entry lacks its required reason and accepted decision | Error |
| `pub_type: incomplete` is not excluded from matching | Error |
| Source or decision review does not resolve | Error |
| Citation count is negative, fractional, or neither an integer nor `null` | Error |
| Citation samples violate ordering, uniqueness, or same-time consistency rules | Error |
| Citation evidence does not originate from Scholar | Error |
| Annual citation observations violate their schema or source rules | Error |
| An unambiguously parseable source publication date disagrees with `year` | Warning |
| `authors_completeness: complete` accompanies an empty or visibly truncated author list | Warning |

Preserve literal Scholar dates. Unparseable source date text is allowed and is not
automatically an error.

Citation decreases are valid. Annual citation totals need not equal the current
total. Neither condition produces a finding.

## 8. Link integrity and cardinality

| Condition | Severity |
| --- | --- |
| `gscholar_entry_id` has an invalid scalar/array representation | Error |
| Link target does not exist | Error |
| Link target resolves ambiguously because its UUID is duplicated | Error |
| Same Scholar UUID appears twice in one publication's links | Error |
| Archived publication retains any Scholar link | Error |
| Linked Scholar entry is excluded | Error |
| Linked Scholar entry is absent from the latest complete capture | Warning |
| Scholar entry is linked to more than one distinct publication UUID | Error |

Permitted cardinality:

```text
Publication → zero, one, or several Scholar entries
Scholar entry → zero or one publication
```

Several Scholar entries may represent the same publication, as with the two
InternLM2.5-StepProver entries. Check each link separately.

For a shared Scholar entry, emit one grouped error listing every referencing
publication. Do not choose which link to keep. Count distinct publication UUIDs
for this rule; repeated links inside one publication and duplicate record UUIDs
have their own integrity findings.

A publication without a Scholar link, or an eligible Scholar entry without a
publication link, does not automatically produce a warning. Report these as
coverage statistics.

## 9. Consistency between linked endpoints

| Comparison | Rule |
| --- | --- |
| Type | Error when both types are known and incompatible |
| Title | Warning when no supported title variant matches |
| Authors | Warning for disagreement between available comparable bylines |
| Year | Warning when Scholar year differs from the publication's bibliographic year |
| Venue | Warning when comparable venue names disagree |
| Volume, issue, pages/article number | Warning when both sides supply clearly comparable conflicting values |
| Identifier-bearing URLs | Error when an explicitly recognized DOI/arXiv identifier contradicts the corresponding publication identifier |

Type compatibility:

| Publication `type` | Compatible Scholar `pub_type` |
| --- | --- |
| journal | journal |
| conference | conference |
| workshop | workshop |
| preprint | preprint |
| thesis | thesis |
| book-chapter | No exact Scholar category; warning requiring review |
| other | No exact correspondence; warning requiring review |

A missing Scholar `pub_type` produces its completeness warning and skips type
comparison. `incomplete` must be excluded and therefore cannot be linked.

For title comparison, normalize Unicode, case, whitespace, and punctuation
conservatively. Compare against the current publication title and, for an arXiv
preprint, every stored revision title. A valid Scholar entry should not be flagged
simply because a paper was renamed.

Author comparisons recognize initials and supported name variants, preserve
order, and consider historical arXiv bylines. Partial or unknown Scholar
authorship must not trigger an error for omitted authors. Fuzzy title/name
differences alone never establish an incorrect link.

Venue comparison recognizes the linked venue's preferred name, abbreviation,
aliases, and the publication's own venue wording. A longer Scholar venue string
containing year, volume, and pages is not itself a disagreement.

Use the bibliographic-year selection rules from DESIGN.md and SCHEMAS.md. Missing
comparison inputs produce applicable completeness findings and skipped checks,
rather than invented values or mismatch findings.

## 10. Output and completion

Default output shows counts followed by compact findings:

```text
Publications:       825
Scholar entries:    593
Links:              413
Errors:             …
Warnings:           …

ERROR   SCHOLAR_MULTIPLE_PUBLICATIONS
        Scholar: …
        Publications: …

WARNING PUB_MISSING_DATE
        Publication: …
```

The counts above are illustrative. `--details` adds file paths, field paths,
compared values, and explanations. JSON always contains those details, with
stable rule codes and all affected record IDs. Findings without a readable record
ID must still identify the source file.

The result includes:

- Files discovered, parsed, and unreadable.
- Records audited by collection.
- Link count, linked publication count, and linked Scholar count.
- Unlinked, archived, excluded, and absent counts.
- Publication-type versus Scholar-type cross-tab, counting each resolved
  publication–Scholar association once.
- Error and warning totals by rule and aspect.
- Whether the audit completed and which checks were skipped.

Statistics must state when invalid or ambiguous records prevent complete counts.
Do not silently drop problematic records and present the remaining population as
the complete catalog. Avoid duplicate findings when structural and audit checks
identify the same underlying problem.

| Exit code | Meaning |
| --- | --- |
| `0` | Complete audit with no errors; warnings allowed |
| `4` | Audit found errors |
| `1` | Audit could not complete reliably |
| `2` | Invalid command usage |

An operational failure that prevents a reliable audit takes precedence over the
normal findings exit code. Malformed records that are successfully detected and
reported are audit errors; dependent checks skipped because of those errors are
listed explicitly.

## 11. Implementation boundary

Implementation guarantees:

- The command and reusable `Catalog.audit()` / `auditRepository(root)` APIs
  return the expanded report, including findings and coverage statistics.
- Preserve the current schema-validation guarantees and nonblocking duplicate
  arXiv audit behavior.
- DESIGN.md and SCHEMAS.md document the approved link cardinality and its
  audit-only enforcement.
- Tests cover malformed files, required versus expected fields,
  ambiguous references, title revisions, partial bylines, date precision,
  one-publication-per-Scholar cardinality, and incomplete audit results.
- Keep source data and existing user edits intact; findings require explicit
  correction workflows.
