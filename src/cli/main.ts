#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Catalog } from "../core/catalog.js";
import { MyPubError } from "../core/errors.js";
import { importFile } from "../core/imports.js";
import { decideReview, getReview, listReviews } from "../core/reviews.js";
import { toBibtex, toCsv } from "../core/exports.js";
import { backup, restore } from "../core/backup.js";
import { initializeGit, listConflicts, resolveConflict, status, sync } from "../core/sync.js";
import { lookupArxiv, lookupDoi } from "../adapters/metadata.js";
import { run } from "../adapters/process.js";
import { rebuildSearchIndex } from "../adapters/search.js";
import { importScholarSnapshot } from "../core/scholar.js";
import type { AddPublicationInput, AttachmentRole, PublicationStatus, PublicationType, RelationType, ReviewState, SearchFilters } from "../core/types.js";

const HELP = `mypub — portable publication catalog

Usage: mypub [--root PATH] [--json] <command> [options]

Commands:
  init [--name NAME]                         Initialize catalog and Git LFS
  list|search [QUERY] [filters]              List/search publications
  show ID                                    Show a publication and incoming links
  add --json-file FILE | --doi DOI | --arxiv ID
  update ID --json-file FILE                 Update fields from JSON
  archive ID                                 Soft-delete a publication
  import FILE [--provider NAME] [--partial]  Stage BibTeX, CSV, or JSON
  relation add SOURCE TARGET --type TYPE
  relation remove SOURCE TARGET [--type TYPE]
  attachment add ID FILE --role ROLE [--label TEXT] [--primary]
  attachment list ID | fetch ID | open ID [ATTACHMENT_ID]
  review list [--state STATE] | show ID | accept|reject|defer ID
  sync [--message TEXT] | status
  conflicts [ID --choice ours|theirs [--file FILE]]
  export --format bibtex|csv|json [--output FILE] [filters]
  validate [--skip-attachments]
  backup DESTINATION | restore SOURCE
  index rebuild                               Rebuild local SQLite index
  scholar import FILE [--partial]             Import/reconcile citation snapshot CSV

Filters: --year YYYY --venue NAME --type TYPE --status STATUS --tag TAG --include-archived
Global:  --root PATH (default: current directory), --json
Exit codes: 0 success, 2 usage, 3 not found, 4 validation/conflict, 1 other failure`;

class Args {
  constructor(public values: string[]) {}
  takeFlag(name: string): boolean { const index = this.values.indexOf(name); if (index < 0) return false; this.values.splice(index, 1); return true; }
  take(name: string): string | undefined { const index = this.values.indexOf(name); if (index < 0) return undefined; const value = this.values[index + 1]; if (!value || value.startsWith("--")) usage(`${name} requires a value`); this.values.splice(index, 2); return value; }
  shift(required?: string): string | undefined { const value = this.values.shift(); if (!value && required) usage(`${required} is required`); return value; }
}
const usage = (message: string): never => { throw new MyPubError(message, "USAGE"); };
const output = (value: unknown, json: boolean): void => { if (json || typeof value !== "string") process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); else process.stdout.write(value.endsWith("\n") ? value : `${value}\n`); };
const filters = (args: Args): SearchFilters => { const year = args.take("--year"); const type = args.take("--type") as PublicationType | undefined; const status = args.take("--status") as PublicationStatus | undefined; const venue = args.take("--venue"); const tag = args.take("--tag"); return { ...(year ? { year: Number(year) } : {}), ...(venue ? { venue } : {}), ...(type ? { type } : {}), ...(status ? { status } : {}), ...(tag ? { tag } : {}), ...(args.takeFlag("--include-archived") ? { includeArchived: true } : {}) }; };

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = new Args([...argv]); const root = resolve(args.take("--root") ?? process.cwd()); const json = args.takeFlag("--json"); const command = args.shift(); if (!command || command === "help" || command === "--help" || command === "-h") { output(HELP, false); return 0; }
  const catalog = new Catalog({ root, onProgress: (event) => { if (!json) process.stderr.write(`${event.phase}: ${event.message}\n`); } });
  switch (command) {
    case "init": { const library = await catalog.initialize(args.take("--name") ?? "My Publications"); await initializeGit(catalog); output(library, json); break; }
    case "list": case "search": { const query = command === "search" ? args.shift() : undefined; const result = await catalog.list({ ...filters(args), ...(query ? { query } : {}) }); output(json ? result : table(result), json); break; }
    case "show": output(await catalog.details(args.shift("publication ID")!), json); break;
    case "add": { const file = args.take("--json-file"); const doi = args.take("--doi"); const arxiv = args.take("--arxiv"); let input: AddPublicationInput; if (file) input = JSON.parse(await readFile(file, "utf8")) as AddPublicationInput; else if (doi) input = await lookupDoi(doi); else if (arxiv) input = await lookupArxiv(arxiv); else usage("add requires --json-file, --doi, or --arxiv"); output(await catalog.add(input!), json); break; }
    case "update": { const id = args.shift("publication ID")!; const file = args.take("--json-file") ?? usage("update requires --json-file"); output(await catalog.update(id, JSON.parse(await readFile(file, "utf8")) as never), json); break; }
    case "archive": output(await catalog.archive(args.shift("publication ID")!), json); break;
    case "import": { const file = args.shift("import file")!; output(await importFile(catalog, file, args.take("--provider"), args.takeFlag("--partial") ? "partial" : "complete"), json); break; }
    case "relation": { const action = args.shift("relation action"); const source = args.shift("source")!; const target = args.shift("target")!; const type = args.take("--type") as RelationType | undefined; if (action === "add") output(await catalog.addRelation(source, target, type ?? usage("relation add requires --type"), args.take("--note")), json); else if (action === "remove") output(await catalog.removeRelation(source, target, type), json); else usage("relation action must be add or remove"); break; }
    case "attachment": await attachmentCommand(catalog, args, json); break;
    case "review": { const action = args.shift("review action"); if (action === "list") output(await listReviews(catalog, args.take("--state") as ReviewState | undefined), json); else { const id = args.shift("review ID")!; if (action === "show") output(await getReview(catalog, id), json); else if (["accept", "reject", "defer"].includes(action ?? "")) output(await decideReview(catalog, id, action === "accept" ? "accepted" : action === "reject" ? "rejected" : "deferred", args.take("--note")), json); else usage("invalid review action"); } break; }
    case "status": output(await status(catalog), json); break;
    case "sync": output(await sync(catalog, args.take("--message")), json); break;
    case "conflicts": { const id = args.shift(); if (!id) output(await listConflicts(catalog), json); else { const choice = args.take("--choice"); if (choice !== "ours" && choice !== "theirs") usage("conflict resolution requires --choice ours|theirs"); await resolveConflict(catalog, id, choice as "ours" | "theirs", args.take("--file")); output({ resolved: id }, json); } break; }
    case "export": { const format = args.take("--format") ?? "bibtex"; const records = await catalog.list(filters(args)); const content = format === "bibtex" ? toBibtex(records) : format === "csv" ? toCsv(records) : format === "json" ? `${JSON.stringify(records, null, 2)}\n` : usage("format must be bibtex, csv, or json"); const destination = args.take("--output"); if (destination) { await mkdir(dirname(resolve(destination)), { recursive: true }); await writeFile(resolve(destination), content, "utf8"); output({ output: resolve(destination), count: records.length }, json); } else output(content, false); break; }
    case "validate": { const result = await catalog.validate(!args.takeFlag("--skip-attachments")); output(result, json); return result.valid ? 0 : 4; }
    case "backup": output(await backup(catalog, args.shift("destination")!), json); break;
    case "restore": await restore(catalog, args.shift("source")!); output({ restored: true }, json); break;
    case "index": { if (args.shift("index action") !== "rebuild") usage("index action must be rebuild"); output(await rebuildSearchIndex(catalog), json); break; }
    case "scholar": { if (args.shift("scholar action") !== "import") usage("scholar action must be import"); const file = args.shift("snapshot file")!; output(await importScholarSnapshot(catalog, file, args.takeFlag("--partial") ? "partial" : "complete", args.take("--observed-at")), json); break; }
    default: usage(`Unknown command: ${command}`);
  }
  if (args.values.length) usage(`Unexpected arguments: ${args.values.join(" ")}`); return 0;
}

async function attachmentCommand(catalog: Catalog, args: Args, json: boolean): Promise<void> {
  const action = args.shift("attachment action"); const id = args.shift("publication ID")!;
  if (action === "add") { const file = args.shift("file")!; const role = args.take("--role") as AttachmentRole | undefined; output(await catalog.addAttachment(id, file, role ?? usage("attachment add requires --role"), args.take("--label"), args.takeFlag("--primary")), json); return; }
  const publication = await catalog.get(id); if (action === "list") { output(publication.attachments, json); return; }
  if (action === "fetch") { for (const item of publication.attachments) await run("git", ["lfs", "pull", "--include", item.path, "--exclude", ""], catalog.root); output({ fetched: publication.attachments.length }, json); return; }
  if (action === "open") { const attachmentId = args.shift(); const attachment = attachmentId ? publication.attachments.find((item) => item.id === attachmentId) : publication.attachments.find((item) => item.id === publication.primary_attachment_id) ?? publication.attachments[0]; if (!attachment) throw new MyPubError("Publication has no attachment", "NOT_FOUND"); const target = join(catalog.root, attachment.path); const executable = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"; const openArgs = process.platform === "win32" ? ["/c", "start", "", target] : [target]; await run(executable, openArgs, catalog.root); output({ opened: target }, json); return; }
  usage("attachment action must be add, list, fetch, or open");
}

function table(records: Awaited<ReturnType<Catalog["list"]>>): string { if (!records.length) return "No publications."; const rows = records.map((record) => [record.citation_key, (record.dates.issued ?? record.dates.online ?? "").slice(0, 4), record.type, record.title]); const widths = [0, 1, 2, 3].map((index) => Math.max(...rows.map((row) => row[index]!.length), ["KEY", "YEAR", "TYPE", "TITLE"][index]!.length)); return [["KEY", "YEAR", "TYPE", "TITLE"], ...rows].map((row) => row.map((cell, index) => index === 3 ? cell : cell.padEnd(widths[index]!)).join("  ")).join("\n"); }

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().then((code) => { process.exitCode = code; }).catch((error: unknown) => { const typed = error instanceof MyPubError ? error : new MyPubError(error instanceof Error ? error.message : String(error), "UNEXPECTED"); process.stderr.write(`${typed.code}: ${typed.message}\n`); if (process.env.MYPUB_DEBUG && error instanceof Error) process.stderr.write(`${error.stack ?? ""}\n`); process.exitCode = typed.code === "USAGE" ? 2 : typed.code === "NOT_FOUND" ? 3 : typed.code.includes("VALIDATION") || typed.code.includes("CONFLICT") ? 4 : 1; });
