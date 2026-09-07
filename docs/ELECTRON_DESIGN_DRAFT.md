# MyPub desktop — design draft

7 September 2026 · Approved design; viewer implementation added after review.

This document retains the reviewed target design for the Electron viewer. The first viewer implementation is now available alongside the TypeScript core and `mypub` CLI; [DESIGN.md section 10](../DESIGN.md#10-implemented-electron-viewer) distinguishes implemented behavior from remaining refinements. Read this alongside [DESIGN.md](../DESIGN.md) and [SCHEMAS.md](../SCHEMAS.md); neither the canonical catalog schema nor the current implementation boundary changes merely by accepting a visual direction. The accompanying clickable preview uses fictional demonstration records, not the user's database.

## 1. Product direction

A local desktop reading room for the publication catalog: open the application, understand the collection, find a paper, follow its authors or venue, and inspect the associated Scholar evidence without losing context.

Recommend a quiet, light interface with a narrow persistent sidebar, generous paper titles, restrained teal accents, and compact secondary metadata. Use light appearance by default, independently of the operating system theme, as requested in review. Dark/system appearance may remain an explicit optional preference. The primary views are bibliographic lists; tables are an optional denser presentation. Charts serve as navigation into lists. Readable text and explicit labels carry meaning independently of color.

First delivery is a viewer. It opens existing catalogs, queries their local database, refreshes automatically, opens available attachments and external links, and copies citations. Editing, imports, merges, linking decisions, Git synchronization controls, automatic Scholar retrieval, and embedded PDF editing are later work. Existing CLI workflows can continue while the viewer is open. Database repair is derived-cache maintenance, not a catalog edit.

## 2. Application shell and navigation

Left navigation: **Overview**, **Publications**, **Authors**, **Venues**, **Google Scholar**. Put the current library name and a “Change library…” action above it, and local-data freshness below it. Keep database freshness, Scholar capture age, and any future Git sync status distinct.

The first launch uses an explicitly chosen folder, or the existing configured `repo_path` if valid. Offer a folder picker when none is configured; never treat Electron's working directory as an intended library. Display the selected path before opening. An invalid configured path shows an actionable error and “Choose another library.” Opening does not initialize or migrate a catalog. Library switching cancels outstanding queries and resets library-specific navigation state.

A header search opens cross-collection results in four labeled sections. Each collection page also has scoped search. Back/forward restores page, query, filters, grouping, scroll position, and selected UUID. Cross-collection navigation retains the original state as a history entry rather than carrying incompatible filters silently to the destination.

Selecting an entry expands a detail pane directly beneath that entry, at every window width. This applies to Publications, Authors, Venues, Scholar entries, and Overview’s most-cited rows. The entry and surrounding list stay in place; opening details never moves the pane to the top or scrolls away from the entry. Clicking the title again or “Hide details” collapses it. Allow multiple entries to remain expanded so inspecting another record does not collapse content above and shift the reading position. Keep keyboard focus on the triggering title, expose its expanded state accessibly, and put detail controls next in tab order. Preserve expanded UUIDs across refreshes and keep the selected year/venue and filters intact. Dedicated routes may still support explicit cross-collection links, but ordinary inspection uses this inline expansion.

## 3. Overview

Default scope: all non-archived publication records; related versions remain separate publications. A visible year range can narrow publication metrics and charts. Scope labels must make clear that whole-profile Scholar metrics do not follow publication filters.

| Element | Definition and interaction |
| --- | --- |
| Publications | Count distinct active publication UUIDs. Click to browse the same scope. |
| Authors | Count distinct resolved author identities linked to publications in scope, including still-linked archived identities; merged aliases do not add people. Label “Linked authors.” |
| Venues | Count distinct resolved venue IDs represented in scope. Unresolved venue wording is reported separately. |
| Scholar coverage | Publications with a confirmed entry link divided by publications in scope. This measures links, not known citation counts. |
| Publications by year | Bars using the canonical bibliographic year; a separate Unknown year count. Click a year to open the equivalent publication filter. |
| Leading venues | Horizontal bars, top 8 plus Other and Unresolved/No venue. Count distinct publication UUIDs. Click a venue to open its bibliography. |
| Most cited papers | Top five publications in scope ranked by their latest observed Scholar citation count, descending, with title as a stable tie-breaker. Show the count and observation date on each row; clicking opens publication details. Exclude unknown counts and unlinked records; known zero remains eligible. Shared entry counts are explicitly labeled on each affected paper and are never summed. If no counts are known, show “No citation observations available.” |
| Scholar snapshot | Selected profile, latest capture time and coverage, optional captured totals. Missing totals say “Not captured”; explicit null says “Unavailable.” Show the date of any older retained metric used. |

Do not add a headline “total citations” by summing publication rows. An optional analytical sum must deduplicate linked Scholar entries, disclose unknown counts and observation-date range, and be labeled as an entry-count sum rather than the profile total. Whole-profile h-index/i10-index are shown only when captured, never silently estimated from the local subset.

Citation-history charts belong primarily on Scholar entry details. Plot observed totals at their actual observation times; show gaps for null, decreases as recorded, and no invented daily values. Annual citation bars use `annual_citations` snapshots with their own capture date; do not derive annual bars by differencing cumulative totals. When data is absent, show a useful empty state rather than an empty chart or zeros.

## 4. Publications

Toolbar: search, **Filter**, **Group: Year / Venue / None**, **Sort**, and optional list/table toggle. Start with year groups, newest first. Within a group, sort by bibliographic date then title. Venue mode groups by resolved identity, then by year. Unresolved literal venue names are visibly separate from confirmed identities; missing venues have their own group.

When grouped by year or venue, add a slim **Years / Venues navigator to the left of the publication list**, inside the Publications page. Show all matching groups with counts, newest years first (Unknown last) or venue names alphabetically. Selecting a group immediately switches the list to that group and highlights the navigator item; “All years / All venues” restores the full grouped list. Keep search and filter conditions intact, and show “N of M publications” to distinguish group navigation from the filtered result total. Counts reflect current search/filters before the navigator selection. Retain the selected group across valid refreshes; return to All if that group no longer has matches. Changing grouping resets the group selection. Hide the navigator for ungrouped or empty results. At narrow widths it becomes a wrapping strip above the results. With both navigation and record details visible, details use the list column’s full width directly beneath their own entry; they never occupy a separate top or side pane.

Each list row shows title, ordered credited authors (collapsed after a reasonable number with “+N”), venue and year, type, tags, citation count with observation date available, and attachment availability. Preserve printed author names even when a preferred identity name differs. Highlight the owner only through `self_author_id`, never by matching a name string.

Default table columns: title, year, venue, type, citations, files. Optional columns include authors, tags, citation key and last updated. Sortable headers expose direction. Null citations sort last in both directions and render as “Unknown.” An unlinked publication says “No Scholar link,” not “0 citations.” Shared Scholar counts carry a “Shared entry” label.

Detail sections: bibliography and identifiers; ordered authors with explicit roles; tags and notes; attachments; related publications including incoming relations; linked Scholar entry with source/curated differences; record timestamps and catalog path. Date precision is preserved. Explain the field supplying a fallback bibliographic year. Related preprints and journal/conference versions remain independently navigable.

Opening a local primary PDF uses the OS viewer in the first delivery. A manifest alone does not establish that bytes exist locally: distinguish Available locally, Not downloaded (LFS pointer), Missing file and Check failed. A not-downloaded attachment explains that the existing CLI can fetch it; a future explicit Download action is outside this viewer milestone. External links open only after a user click. BibTeX copy uses the existing exporter.

## 5. Search and combined filters

Search matches titles, citation keys, identifiers, credited names, author preferred names/aliases, venue preferred names/aliases/abbreviations, and tags. Multiword search defaults to all normalized terms; quoted phrases match together. Show this brief explanation in search help. Do not expose raw SQLite FTS or SQL syntax. Notes can be an explicit opt-in search field. This token/phrase behavior is a new GUI query contract: the CLI currently uses normalized literal substring matching and retains that behavior unless separately changed.

Quick filters cover year/range (including Unknown), venue, publication type, author, tag and Scholar linkage. Values within a quick multiselect are OR; different facets are AND. Tag and author facets also offer “Require all selected.” Identity pickers show preferred names plus distinguishing keys/notes for duplicate names, and store full UUIDs. Search text is ANDed with the filter expression.

An advanced filter editor shows readable **Match all / Match any** groups and explicit operators. Support nested groups to a bounded depth of 3, with removable conditions. The expanded expression is the source of truth; quick controls are shortcuts into that same expression, not an independent hidden filter set. If a rule cannot be represented by a simple facet, show it in the builder instead of silently simplifying it.

Example:

> Year between 2022 and 2026 AND (Venue is CVPR OR Venue is ICCV) AND Author is [selected identity] with role Corresponding AND Tag is not Survey AND Citations at least 20.

| Collection | Filter fields |
| --- | --- |
| Publications | Bibliographic year/range/unknown; resolved venue or unresolved literal wording; type; exact author with role; tags; DOI/arXiv presence; citation threshold/known/unknown; Scholar linked/unlinked; attachment manifest/local availability; active/archived/all |
| Authors | Preferred/alias/credited name search; key or identifier; ORCID/Scholar ID presence; linked publication count; active/archived/merged; “Has a publication matching…” year/venue/type/tag/credit-role conditions |
| Venues | Name/abbreviation/alias/key search; kind; linked publication count; active/archived/merged; “Has a publication matching…” year/type/tag conditions |
| Scholar | Source title/byline/venue/description/ID search; source year; source venue text; citations/range/unknown; linked/unlinked; eligible/excluded; present/missing; authors completeness; last seen/citation observation date; pending/rejected candidate evidence |

Author-and-role conditions must match the same credit. “First listed” means position zero; “First author” includes first listed or explicit co-first. Conditions within one “Has a publication matching…” group must match the same linked publication. Scholar source-name filters are literal metadata searches; they do not imply curated author or venue identities. Offer a separately labeled “Linked publication matches…” subgroup for curated constraints.

Numeric comparisons exclude null unless the user explicitly includes Unknown. “Is not venue X” excludes missing values by default, with a visible “Include unknown” option. Missingness has explicit operators throughout. Empty groups are removed; invalid or incomplete rules do not run and show inline explanations. The builder displays a live result count and a plain-language expression.

Results update after a short debounce. Chips show the active expression, with clear removal and Clear all; never hide constraints in a collapsed sidebar. Facet counts apply all other constraints while temporarily omitting that facet's own condition; disable or label zero-count choices. Zero results preserves the query and offers removal of individual conditions.

Saved views are useful but optional for a follow-up delivery. Store expressions, sort and grouping as device preferences keyed by library UUID. Do not insert undocumented GUI fields into the strict existing config/settings JSON. Define a separate versioned GUI preference format in SCHEMAS.md when implementation begins; transient state alone needs no schema extension.

## 6. Authors

A searchable directory, sortable by name, linked publication count, or most recent publication year. Default excludes archived identities and merge tombstones. A–Z browsing uses reviewed family names where available and an Unspecified group otherwise; never guess surnames from the final token.

Each entry shows preferred name, identifying key/disambiguation, aliases, confirmed ORCID/Scholar profiles, and publication count. Details show a filtered bibliography grouped by year, credited spellings and roles per paper. Count each linked publication once; unresolved same-name credits appear as separately labeled candidates and never inflate confirmed bibliography counts. Merged identity links resolve to the survivor while preserving redirect context. Archived identities referenced by active publications remain accessible through those publications.

## 7. Venues

A searchable directory with kind tabs/filter and publication counts. Rows show abbreviation, preferred name, kind and years represented. A venue is a series, so a CVPR page spans all years. An event year is displayed separately when recorded and is not substituted for publication year.

Details show aliases, homepage, year distribution and bibliography. Provide an Unresolved venue wording view alongside the identity directory, with exact literal-name groups and no automatic merge. Identically named distinct venue UUIDs remain distinct and display disambiguation context.

## 8. Google Scholar

Page heading identifies the one mirrored profile and says “Local snapshot • captured [time] • complete/partial/unknown coverage.” No “Live Scholar” label. An author profile link does not create another mirrored profile.

Show source entries as a table: title/byline, source venue, source year, latest citations, linked publication count, eligibility, presence, and last seen. These dimensions stay separate: an eligible entry can be unlinked or missing; an excluded entry remains visible and can have newer citation observations. Link state comes from publication references. Provide convenient Unlinked, Excluded, Missing and Unknown citations filter shortcuts without treating them as mutually exclusive states.

Details show literal source metadata, retained author-array completeness, citation observations, linked publications, and review evidence. Compare curated title/year/venue with source wording side by side when linked. Display pending candidates and pair-specific rejections as evidence, not confirmed links. Reading evidence does not accept/reject/reopen anything. No “Match automatically” action in the viewer.

## 9. Automatic database refresh

Watch the **parent directory** of `local/index.sqlite`, not just an open file handle: the core rebuilds into a temporary database and atomically replaces the destination. Filter directory events to the active database and relevant sidecars/deletion/replacement. Temporary rebuild files are not completed refreshes. Reopen read connections after replacement; never keep reading an old inode indefinitely.

Also watch canonical `catalog/` JSON recursively so edits, renames, imports and Git changes trigger the existing freshness validation/rebuild path. Database events request a freshness check and reread, not an unconditional rebuild. Database output must never be included in the canonical source fingerprint. This separation prevents a watcher/rebuild loop.

Proposed flow:

1. Collect events for approximately 300 ms; coalesce bursts into one refresh request.
2. A background service uses the existing core catalog read path, including its lock, source fingerprint validation and automatic cache repair. Do not bypass core freshness guarantees to query a file merely because it exists.
3. Under one validated database snapshot, return visible results, facets, aggregates and selected detail with a generation token. New queries use the same token or restart against the newer snapshot.
4. Publish one coherent generation to the renderer. Discard results from older requests or the previous library. Coalesce changes arriving during a refresh into a single follow-up pass.
5. Preserve query, groups, expanded sections, selected UUID, keyboard focus and a scroll anchor. If the selected record disappears, show “This record is no longer available” with Back; do not select a different row silently. If only its filter eligibility changes, explain that it no longer matches the current view.

Use a source freshness check on open, window focus and resume from sleep. A roughly 5-second check while the app is foreground is a correctness backstop for missed events; suspend routine polling while backgrounded and recheck on focus. These are initial tuning values to measure against actual library size and storage behavior. Target refresh within about 1 second after a stable valid external change for a few thousand records on local storage; this is an acceptance target, not a measured guarantee.

`CATALOG_LOCKED`: retain the visible snapshot with “Updating…” and retry with bounded backoff. After a prolonged lock, say “Waiting for another catalog operation” with Retry and diagnostics. Do not remove another process's lock automatically.

Invalid JSON, unsupported versions or reference errors: retain the last valid snapshot only with a persistent “Showing data from [time]; catalog change could not be loaded” banner and specific file/error details. Never label it current. If no snapshot exists, show an error page and the folder picker. Retry after later file changes and offer an explicit Retry. A missing/corrupt database follows automatic core repair from validated JSON. If that fails, show the failure without changing source records. Inactive-window refresh need not animate or emit repeated notifications.

Local status labels: Current, Updating, Waiting, or Stale—refresh failed, each with last successful load time. A quiet “Updated just now” indicator replaces disruptive success dialogs. Scholar capture times remain visible even when the local database has just refreshed.

## 10. Implementation outline

Propose Electron with a React/TypeScript renderer. Keep renderer UI state and reusable core services separate. A narrow validated preload bridge exposes typed operations for opening a catalog, queries, details, refresh events, citation export and explicit opening of files/URLs. It does not expose raw SQL, arbitrary filesystem paths, Node primitives or a general command runner.

Keep filesystem watching, validated core operations and synchronous SQLite work in a dedicated background service/worker so catalog hashing and full rebuilds do not freeze the UI. Use short-lived read-only DB connections within the existing locking model. Extend the core with structured query expressions and snapshot-consistent summary APIs; do not copy schema semantics into components. Existing simple CLI queries remain compatible.

Design security requirements for implementation: isolated renderer with Node access disabled, narrow IPC input validation, bundled application resources, no remote page privileged embedding, and explicit allowlisting for external URL schemes. Resolve attachment requests by catalog UUID and validate the resulting managed path. Confirm Electron/runtime compatibility with the existing `node:sqlite` adapter before choosing package versions; the implementation verifies the Electron runtime with the existing SQLite adapter through desktop integration tests.

List virtualization/pagination may be introduced at large result sizes while retaining semantic, keyboard-accessible behavior. Cache rendered query results by library/generation/expression, not just search text. Attachment availability is a separate derived filesystem check with its own invalidation and is not inferred solely from the DB. First implement a simple full snapshot refresh; measure before introducing incremental index updates.

## 11. Reviewable milestones and acceptance

1. **Shell and local reads:** open configured/chosen catalog; route across five pages; browse details; show real derived statistics with explicit scopes.
2. **Finding records:** grouping, search, quick and advanced filters, authors/venues/Scholar reverse navigation, empty states and null semantics.
3. **Refresh and resilience:** directory/database replacement watches, canonical edits, coherent updates, lock retry, focus/resume backstop, stale/error states and state preservation.
4. **Desktop polish:** keyboard navigation, system appearance, attachment/link opening, citation copy, packaging and startup/runtime compatibility checks.

Acceptance scenarios:

- Expand and collapse an entry near the bottom of a long list: details appear directly below that entry, focus stays on its title, and no jump to the top occurs. Opening a second entry leaves the first expanded. Verify this with year/venue grouping, ungrouped results, all directories and Overview.
- Select a year or venue from the Publications navigator; search and filters remain unchanged, All restores every matching group, and counts update when filters change.
- Overview most-cited rankings use latest known numeric observations only, retain zero, exclude latest null values and show shared-entry labels.
- Combine a year range, either of two venues, an exact author-role pair and an excluded tag; changing grouping leaves the result UUID set unchanged.
- Two people with the same name remain distinguishable; an unresolved same-name credit is not an exact identity match.
- Author/venue related-publication groups bind constraints to one publication, and author-role pairs bind to one credit.
- Two publications sharing one Scholar entry do not inflate entry-level aggregates; a latest null citation supersedes an older number and differs from zero.
- Missing publication dates group under Unknown; source-year differences remain visible rather than corrected.
- A CLI rebuild that atomically replaces SQLite refreshes all visible sections without losing selection/search; DB deletion recreates it from valid source.
- Canonical add/edit/delete/rename and Git checkout trigger refresh; invalid partial writes show stale state and recover after valid data is restored.
- Rapid changes during a rebuild never mix result counts and details from different generations; a late response from another library cannot render.
- Holding the catalog lock, missing a watcher event, sleeping/resuming and switching libraries have clear recovery behavior.
- An LFS pointer is not offered as a readable PDF. A viewer never modifies curated records or silently initiates a remote sync or Scholar capture.
- Core query tests cover group/identity/null semantics; integration tests cover watcher/replacement/error paths; desktop checks cover keyboard flow, focus retention, readable narrow layouts, default light appearance even on a dark OS, and explicit optional dark-theme contrast.

## 12. What the clickable draft demonstrates

The preview demonstrates five-page navigation, derived sample dashboard counts and drill-downs, collection search, additive all/any filters, year/venue grouping with a left group navigator, most-cited paper rankings, inline expandable details and cross-links, plus sample refresh/error appearances through optional design controls. Its rule editor is a deliberately smaller flat subset of the proposed production builder. It does not open the real library, run Electron, watch files, export citations, fetch attachments or implement saved views. Advanced nested groups, global search results and full production field coverage are specified above for review rather than implied to work in the preview.

Recommended review focus: whether the navigation and list/detail balance feel right, whether the shared filter builder is understandable, and whether this viewer-first milestone contains the workflows needed before adding editing.

### Pagination revision (implemented)

Publications and Google Scholar use numbered pagination, with Previous/Next controls and direct page selection. The main limit is `max_pagesize_main` (default 30). Author and venue inline bibliographies use independent pagination with `max_pagesize_dropdown` (default 15). Both are optional positive safe integer user preferences. Bibliographies show title, complete credited author list, venue and year; their ordering is descending publication date/year, with year headings. Page limits apply to papers across all year groups on the page. Unknown years appear last. Main page selection resets when search, filtering, sorting or group selection changes; live refresh preserves the page or clamps it to the last available page.
