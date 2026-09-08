# MyPub

MyPub is a local-first publication catalog with a reusable TypeScript API and the `mypub` command-line interface. Curated records live as readable, versioned JSON; attachments use repository-relative paths tracked by Git LFS; machine-local state and the integrated SQLite read model live under Git-ignored `local/`.

## Requirements

- Node.js 22.12 or newer
- Git
- Git LFS

## Install and build

```sh
npm install
npm run build
npm link
```

Keep the data catalog separate from this code repository:

```sh
mkdir -p ~/Documents/publications
mypub --root ~/Documents/publications init --name "My Publications"
```

The CLI never starts a server and core operations never prompt. Queries and mutations support structured JSON output through the global `--json` flag. Run `mypub help` for the complete command list.

## Typical workflow

Run these commands from the data catalog directory, or supply `--root PATH`.

```sh
mypub import publications.bib
mypub review list --state pending
mypub review accept REVIEW_ID
mypub search "paper title"
mypub attachment add CITATION_KEY paper.pdf --role paper --primary
mypub relation add CONFERENCE_KEY PREPRINT_KEY --type published_version_of
mypub validate
mypub commit --message "Update publication catalog"
mypub sync
```

Version 2 is the only supported catalog schema; there is no v1 migration layer. DOI and arXiv lookups stage review proposals and are available with `mypub add --doi ...` and `mypub add --arxiv ...`. CSV, BibTeX, and JSON imports first create durable review records; accepted catalog values remain authoritative. Reimporting identical source bytes returns the existing reviews instead of producing duplicates.

`mypub status` shows compact labeled rows for the library, branch/upstream, uncommitted file count, upload/download commit counts, and last sync. Individual modifications are hidden by default. In an interactive terminal, status uses bold magenta for uncommitted changes, nonzero upload/download counts, and missing Git/upstream setup; bold red for Attention messages and file conflicts; and bold blue for the next action. Colors use the terminal’s theme-defined ANSI palette rather than fixed RGB values; bold adds emphasis independently of color. Routine clean/zero values stay plain. Redirected output, `--json`, terminals with `TERM=dumb`, and a nonempty `NO_COLOR` environment variable disable styling. `mypub status --details` adds a file list identifying changes by status, kind, and publication title or review summary. An `Attention` row appears only for problems; a `Next` line gives the immediate action. Routine catalog/LFS health is omitted. Saved edits await commit; only committed history counts as pending upload (`dirty` and `pending_upload` are separate in JSON). Remote comparisons use the last fetched state; status does not contact the remote. Use `mypub status --json` for structured output, including a `changes` list with paths, change statuses, optional labels, and previous paths for renames/copies. Sync validates before publishing, explicitly uploads outgoing Git LFS objects before pushing Git commits (even in clones without an LFS hook), and persists conflicts under ignored local state for later resolution.

### Commit and synchronize

Edits save immediately to the local catalog. `mypub commit` records a local checkpoint; `mypub sync` exchanges committed history with the configured upstream. Both commands print readable results by default and support `--json`.

| Behavior | `mypub commit [--message TEXT]` | `mypub sync [--message TEXT]` |
| --- | --- | --- |
| Network | None | Fetches the configured remote branch and pushes outgoing commits |
| Uncommitted changes | Validates and commits all managed changes | Refuses to proceed until the working tree and index are clean, including untracked files; ignored files are exempt |
| Managed scope | `catalog/`, `attachments/`, `.gitattributes`, `.gitignore` | Synchronizes the branch's full committed history, including any files committed with ordinary Git |
| Partial staging | Includes unstaged portions of managed files too | Never stages, commits edits, stashes, or discards changes |
| Unrelated files | Leaves unstaged files alone; rejects unrelated staged files | Require ordinary Git handling or ignoring before sync |
| No upstream | Local commits work | Reports synchronization is not configured |
| No changes | No empty commit | Reports already synchronized only after a successful remote check |
| Commit message | Supplied message or generated summary | Used only if a merge commit is needed |

No-change commits return after Git preflight without reading or validating the unchanged catalog. Use `mypub validate` for an explicit integrity check. Commits containing edits retain full catalog and evidence validation; historical records are read in a single Git batch.

Both require an initialized Git repository and a selected branch; finish or abort an active Git merge/rebase/cherry-pick/revert first. Pending catalog review proposals remain pending when committed. Commit validates attachment manifests against the staged LFS pointers and stores attachment bytes locally without uploading. A failed commit can leave managed files staged; it does not discard edits.

Sync always fetches the upstream to check its current state. Identical histories return immediately after preflight/fetch without full catalog or attachment validation; use `mypub validate` for integrity checks. When histories differ, full validation remains required before integration or upload. Fast-forwards validate the incoming catalog and attachment pointers, preserving review evidence, so remote commits can update an older local field layout (such as `urls` to `extra_urls`). Readable mode shows concise phase indicators on stderr; `--json` suppresses them. Network latency still applies to an unchanged sync.

Sync fast-forwards when only the remote has new commits, uploads when only local history has advanced, and reconciles divergent histories by record UUID in a temporary workspace. A validated merge may create a merge commit; existing commits are never rebased or force-pushed. Conflicts preserve the current catalog. Record-resolution choices are saved locally and used by the next `sync`; changed histories require fresh reconciliation. Some reference or attachment conflicts require explicit catalog/Git edits, followed by `commit` where applicable.

A failed upload retains local commits and any remote changes already integrated locally. Sync is not an atomic operation across both computers; retry safely after resolving the failure. Only a completed synchronization updates the last-successful-sync timestamp. Metadata sync retains LFS pointers without downloading attachments; use explicit attachment downloads for offline access.

`mypub backup DESTINATION` captures current attachments, catalog JSON, Git history as a bundle, and fetched historical LFS objects when available. Keep backups outside the synchronized repository.

## Authors, venues, and Google Scholar

Publication bylines retain their printed names and roles beside optional shared author UUIDs. Venue links likewise preserve publication-specific wording. Identical names do not establish identity. Records use readable title/surname filenames with UUID suffixes, grouped by publication year or surname initial; missing values use `unknown_year` and `unknown_surname`.

```sh
mypub author add --json-file author.json
mypub venue add --json-file venue.json
mypub owner set AUTHOR_KEY --profile-id SCHOLAR_PROFILE_ID
mypub gscholar import snapshot.json
mypub gscholar reconcile
mypub gscholar link PUBLICATION_KEY ENTRY_UUID
mypub gscholar exclude ENTRY_UUID --reason "Not my publication" --unlink-publications
mypub audit
mypub history RECORD_UUID
```

Scholar JSON captures have `profile_id`, `captured_at`, `coverage` (`complete`, `partial`, or `unknown`), and an `entries` array. Entries require `scholar_id` and a title on first capture. Optional `citation_count` records a number or null; omitting it records no citation check. CSV supports the same row fields, with `--observed-at` and `--coverage` supplying capture context. Coverage defaults to unknown. Reimporting the same payload at the same capture time is idempotent. Only newer complete captures establish missing entries. Imports generate match proposals; links are explicit decisions.

Publication dates are top-level fields: usually `publication_date`, with `submission_date`, `acceptance_date`, `online_date`, and `issued_date` when known. For arXiv records, `publication_date` and `submission_date` are required and equal the full v1 date. `arxiv_versions` stores every retrieved version with its date, title, ordered author names, and abstract; arXiv lookup fetches the complete history. Later revisions never change the publication year. There is no publication status. `archive`/`unarchive` controls catalog visibility. Duplicate arXiv IDs are admitted and reported by `audit`; duplicate DOI IDs and dangling UUID links block writes.

`show --json` returns `record_revision` for author-credit edits. Credit positions are one-based. Reviews support individual `--proposal` acceptance/rejection and explicit reopening. Record revisions prevent stale proposals from overwriting newer edits. Git committers supply attribution; bibliographic authors are separate entities and no application accounts are stored.

Native `export --format json` includes referenced identities, Scholar entries, and review evidence. Import stages the envelope for acceptance and rejects destination collisions. Attachment bytes and Git history are not embedded. Backups restore Git history from the bundle; `--files-only` is an explicit option when history is not required. A backup reports whether historical LFS objects are complete and refuses missing/corrupt current attachment bytes.

## Development

`npm run build` rebuilds the core, CLI, and desktop bundles together so renderer assets stay consistent with the catalog schema. `npm run build:desktop` is an alias for that complete build. Restart an already-running viewer after rebuilding to load the updated renderer.

```sh
npm run check
npm run build
npm test
npm run coverage
```

The coverage command enforces minimum aggregate thresholds of 90% for lines and 80% for functions.

The Electron viewer is available with `npm run desktop`. Embedded graphical previews, browser capture, desktop editing, and hosted services remain outside this viewer phase. See [DESIGN.md](DESIGN.md) for architecture and requirements.

## Local configuration

Create `~/.config/mypub/config.json` to select your default catalog:

```json
{
  "repo_path": "~/Data/MyPubRepo"
}
```

Then run `mypub list`, `mypub status`, or other commands from any directory. `mypub config show` prints the stored configuration and effective repository path. `mypub --root /path/to/another/catalog list` overrides the default. Without a configured path, commands use the current directory. `init` and `restore` follow the same rules; pass `--root` when creating a different catalog.

Use an absolute path or `~/`; relative paths in the config are rejected. Only `repo_path` is currently supported. The file is local to your OS user and is outside catalog Git history and backups. Per-catalog device settings remain in `local/settings.json`, and commit identity remains controlled by Git.

For an installation under your own account when npm's default global directory is not writable:

```sh
npm run build
npm install --global --prefix "$HOME/.local" .
```

Ensure `~/.local/bin` is on your shell's `PATH`, then run `mypub --help`. This local-directory installation links to the codebase; run `npm run build` after source changes.

## Local database

`local/index.sqlite` is a disposable read model derived from the JSON catalog. It contains complete records plus relational tables for authors, venues, credits, identifiers, relations, attachments, Scholar citations, and review decisions. Publication list/search/lookup uses SQLite; SQL views include `author_bibliography`, `venue_year_summary`, and `review_queue`.

The database refreshes automatically after catalog saves (including uncommitted edits), imports/review decisions, synchronization integration, restore, and transaction recovery. Before reads, MyPub hashes catalog contents and paths to detect external edits, renames, deletions, and Git checkout/reset changes. Unchanged sources reuse the database; missing, corrupt, or incompatible caches rebuild automatically. CLI search retains literal normalized substring matching.

All edits must use the JSON-backed core operations. The database and its sidecar/temporary files are never tracked by Git or Git LFS; MyPub ensures `/local/` is ignored and refuses synchronization of tracked local files. A refresh failure leaves canonical JSON intact and reports `CACHE_STALE`; if its details say `saved: true`, retry a read instead of repeating the edit. `mypub index rebuild` remains available for explicit repair. Concurrent catalog operations report `CATALOG_LOCKED` for retry. Freshness checks still read catalog bytes on each operation; the Electron viewer watches source/database changes in the background; incremental database refresh remains deferred.


## Desktop viewer

```sh
npm install
npm run build:desktop
npm link
mypub-view
# Or choose an explicit existing catalog:
mypub-view --root ~/Data/MyPubRepo
# Help without opening a window:
mypub-view --help
```

The light-themed Electron app opens the configured `repo_path`, or lets you choose a library folder. It has Overview, Publications, Authors, Venues and Google Scholar pages. Group publications by year or venue, use the left navigator, combine conditions with the Filter builder, and click any entry to open its details in a pane on the right. Selecting another record replaces the pane contents. Close it with the × button, Escape, or the selected row; the list and details scroll independently. On narrow windows the pane overlays the right side of the list. The overview shows the most cited papers, using observed Scholar counts rather than inferred totals.

Search across the library with Command/Ctrl+K. Back/forward buttons (or Alt+Left/Right) restore the preceding view. The filter builder supports AND/OR groups, identity selectors, author roles, numeric ranges, missing values and constraints on a linked publication. Unknown citation counts are distinct from zero. The viewer can copy BibTeX and open local PDFs/images/text/videos or HTTP(S) links. Unmaterialized LFS attachments must first be fetched through the CLI.

Catalog and database changes refresh automatically, including CLI edits and SQLite replacement. Filters and the selected detail pane remain in place. A failed refresh shows the last valid snapshot with an error; Retry rechecks the catalog. All metadata remains in the canonical JSON files. No automatic remote sync, Scholar capture or publication edit is performed by the viewer.

Development requires Node.js 22.12+ and the npm-installed Electron runtime. The renderer and worker are bundled/compiled locally; no HTTP server is needed. After `npm link` (or installation of a packed MyPub package), `mypub-view` works from any directory. It stays attached to the terminal until Electron exits. Electron is a runtime dependency, and package creation builds and includes the desktop assets. `npm run desktop` remains a source-development shortcut; signed installers are not included.

```sh
npm run check
npm run build:desktop
npm test
npm run test:desktop
```

Desktop tests launch Electron and need a graphical desktop session. See [the desktop design](docs/ELECTRON_DESIGN_DRAFT.md) and [the implemented scope](DESIGN.md#10-implemented-electron-viewer).

Desktop paper lists use pages of 30; author and venue dropdown bibliographies use pages of 15, grouped by year from newest to oldest. Each bibliography paper includes its title, credited author list, venue and year. To change the limits, add optional positive integer preferences to `~/.config/mypub/config.json` and restart the viewer:

```json
{
  "repo_path": "~/Data/MyPubRepo",
  "max_pagesize_main": 30,
  "max_pagesize_dropdown": 15
}
```

Venue links use labeled objects, for example `{"url":"https://cvpr.thecvf.com/","role":"homepage"}` or `{"url":"https://www.computer.org/csdl/proceedings/1000147","role":"proceedings","label":"IEEE proceedings"}`. Supported roles are `homepage`, `proceedings`, `submission`, and `other`. The viewer uses the label when supplied, otherwise a role-based caption. Publication URLs remain strings.
