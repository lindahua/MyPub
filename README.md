# MyPub

MyPub is a local-first publication catalog with a reusable TypeScript API and the `mypub` command-line interface. Curated records live as readable, versioned JSON; attachments use repository-relative paths tracked by Git LFS; machine-local state and the rebuildable SQLite index live under `local/`.

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

Initialize a catalog in the current directory:

```sh
mypub init --name "My Publications"
```

The CLI never starts a server and core operations never prompt. Queries and mutations support structured JSON output through the global `--json` flag. Run `mypub help` for the complete command list.

## Typical workflow

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

DOI and arXiv lookups are available with `mypub add --doi ...` and `mypub add --arxiv ...`. CSV, BibTeX, and JSON imports first create durable review records; accepted catalog values remain authoritative. Reimporting identical source bytes returns the existing reviews instead of producing duplicates.

`mypub status` distinguishes local dirtiness, commits pending upload, last successful sync, and stored conflicts. Sync validates before publishing, relies on the Git LFS pre-push hook to upload binary objects first, and persists Git conflicts under ignored local state for later resolution.

`mypub backup DESTINATION` captures current attachments, catalog JSON, Git history as a bundle, and fetched historical LFS objects when available. Keep backups outside the synchronized repository.

## Development

```sh
npm run check
npm run build
npm test
npm run coverage
```

The coverage command enforces minimum aggregate thresholds of 90% for lines and 80% for functions.

Electron, graphical previews, browser capture, and hosted services are deliberately not part of this phase. See [DESIGN.md](DESIGN.md) for architecture and requirements.
