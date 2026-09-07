# MyPub

MyPub is a local-first publication catalog with a reusable TypeScript API and the `mypub` command-line interface. Curated records live as readable, versioned JSON; attachments use repository-relative paths tracked by Git LFS; machine-local state and the integrated SQLite read model live under Git-ignored `local/`.

## Requirements

- Node.js 22 or newer
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
mypub sync
```

Version 2 is the only supported catalog schema; there is no v1 migration layer. DOI and arXiv lookups stage review proposals and are available with `mypub add --doi ...` and `mypub add --arxiv ...`. CSV, BibTeX, and JSON imports first create durable review records; accepted catalog values remain authoritative. Reimporting identical source bytes returns the existing reviews instead of producing duplicates.

`mypub status` distinguishes local dirtiness, commits pending upload, last successful sync, and stored conflicts. Sync validates before publishing, relies on the Git LFS pre-push hook to upload binary objects first, and persists Git conflicts under ignored local state for later resolution.

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

Publication dates are top-level optional fields: usually `publication_date`, with `submission_date`, `acceptance_date`, `online_date`, and `issued_date` when known. There is no publication status. `archive`/`unarchive` controls catalog visibility. Duplicate arXiv IDs are admitted and reported by `audit`; duplicate DOI IDs and dangling UUID links block writes.

`show --json` returns `record_revision` for author-credit edits. Credit positions are one-based. Reviews support individual `--proposal` acceptance/rejection and explicit reopening. Record revisions prevent stale proposals from overwriting newer edits. Git committers supply attribution; bibliographic authors are separate entities and no application accounts are stored.

Native `export --format json` includes referenced identities, Scholar entries, and review evidence. Import stages the envelope for acceptance and rejects destination collisions. Attachment bytes and Git history are not embedded. Backups restore Git history from the bundle; `--files-only` is an explicit option when history is not required. A backup reports whether historical LFS objects are complete and refuses missing/corrupt current attachment bytes.

## Development

```sh
npm run check
npm run build
npm test
npm run coverage
```

The coverage command enforces minimum aggregate thresholds of 90% for lines and 80% for functions.

Electron, graphical previews, browser capture, and hosted services are deliberately not part of this phase. See [DESIGN.md](DESIGN.md) for architecture and requirements.

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

All edits must use the JSON-backed core operations. The database and its sidecar/temporary files are never tracked by Git or Git LFS; MyPub ensures `/local/` is ignored and refuses synchronization of tracked local files. A refresh failure leaves canonical JSON intact and reports `CACHE_STALE`; if its details say `saved: true`, retry a read instead of repeating the edit. `mypub index rebuild` remains available for explicit repair. Concurrent catalog operations report `CATALOG_LOCKED` for retry. Freshness checks still read catalog bytes on each operation; background watching and incremental refresh are deferred.
