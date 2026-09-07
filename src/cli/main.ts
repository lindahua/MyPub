#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configPath, readUserConfig, resolveRepoRoot } from "../adapters/config.js";
import { Catalog } from "../core/catalog.js";
import { MyPubError } from "../core/errors.js";
import { importFile, stageImport } from "../core/imports.js";
import { decideReview, getReview, listReviews, reopenReview } from "../core/reviews.js";
import { toBibtex, toCsv } from "../core/exports.js";
import { nativeExport } from "../core/native.js";
import { backup, restore } from "../core/backup.js";
import { commit, initializeGit, listConflicts, resolveConflict, status, sync } from "../core/sync.js";
import { lookupArxiv, lookupDoi } from "../adapters/metadata.js";
import { run } from "../adapters/process.js";
import { rebuildSearchIndex } from "../adapters/search.js";
import { importScholarSnapshot, linkScholar, matchingPolicy, reconcileScholar } from "../core/scholar.js";
import { addAuthor, addVenue, updateIdentity, archiveIdentity, identityDetails, updateCredit, unlinkCredit, linkVenue, mergeIdentity, configureOwner } from "../core/identities.js";
import { history } from "../core/history.js";
import { formatStatus } from "./status.js";
import { publicationDate } from "../core/paths.js";
import type { AttachmentRole, Coverage, RelationType, ReviewState, SearchFilters } from "../core/types.js";

const HELP = `mypub — portable publication catalog

Usage: mypub [--root PATH] [--json] <command> [options]

  config show
  init [--name NAME]
  list|search [QUERY] [filters] | show ID
  add --json-file FILE | --doi DOI | --arxiv ID
  update ID --json-file FILE [--expected-revision HASH]
  archive ID | unarchive ID
  author|venue list|show ID|add --json-file FILE|update ID --json-file FILE
  author|venue archive ID|restore ID|merge SOURCE TARGET [--apply]
  author unresolved | venue unresolved
  author credit PUBLICATION POSITION --json-file FILE --expected-revision HASH
  author unlink PUBLICATION POSITION --expected-revision HASH
  venue link PUBLICATION VENUE | venue unlink PUBLICATION
  owner set AUTHOR [--profile-id ID] | owner show
  import FILE [--provider NAME] [--partial]
  relation add SOURCE TARGET --type TYPE | remove SOURCE TARGET [--type TYPE]
  attachment add ID FILE --role ROLE [--label TEXT] [--primary]
  attachment list ID | fetch ID | open ID [ATTACHMENT_ID]
  review list [--state STATE] | show ID | accept|reject|defer ID [--proposal ID]
  review reopen ID [--proposal ID]
  gscholar import FILE [--coverage complete|partial|unknown] [--observed-at TIME]
  gscholar reconcile | link PUBLICATION ENTRY | unlink PUBLICATION
  gscholar exclude ENTRY --reason TEXT [--unlink-publications] [--preview]
  gscholar include ENTRY [--reason TEXT] [--preview]
  commit [--message TEXT]
  sync [--message TEXT] | status [--details] | history [RECORD_UUID]
  conflicts [ID --choice ours|theirs [--file FILE]]
  export --format bibtex|csv|json [--output FILE] [filters]
  validate [--skip-attachments] | audit | recover | repair-paths
  backup DESTINATION [--files-only] | restore SOURCE | index rebuild

Commit saves all managed edits locally without network access. Sync requires a clean tree and a remote upstream; its --message applies only to merge commits.

Repository: --root overrides ~/.config/mypub/config.json repo_path; otherwise use the current directory.

Filters: --year YYYY --venue ID_OR_NAME --author UUID_OR_KEY --role ROLE
         --type TYPE --tag TAG --include-archived
Credit positions are one-based. show returns record_revision for credit edits. Metadata lookups stage reviews for acceptance.
Only schema version 2 is supported. Electron is planned for a later phase.`;
class Args {
  constructor(public values: string[]) {}
  takeFlag(name: string): boolean { const i = this.values.indexOf(name); if (i < 0) return false; this.values.splice(i, 1); return true; }
  take(name: string): string | undefined { const i = this.values.indexOf(name); if (i < 0) return undefined; const v = this.values[i + 1]; if (!v || v.startsWith("--")) usage(`${name} requires a value`); this.values.splice(i, 2); return v; }
  shift(required?: string): string | undefined { const v = this.values.shift(); if ((!v || v.startsWith("--")) && required) usage(`${required} is required`); return v; }
}
const usage = (message: string): never => { throw new MyPubError(message, "USAGE"); };
const output = (value: unknown, json: boolean): void => { process.stdout.write(typeof value === "string" && !json ? value.endsWith("\n") ? value : `${value}\n` : `${JSON.stringify(value ?? { ok: true }, null, 2)}\n`); };
const jsonFile = async (path: string): Promise<any> => JSON.parse(await readFile(path, "utf8"));
function filters(a: Args): SearchFilters {
  const year = a.take("--year"), venue = a.take("--venue"), author = a.take("--author"), role = a.take("--role"), type = a.take("--type"), tag = a.take("--tag");
  if (year && !/^\d{4}$/.test(year)) usage("year must be YYYY");
  if (role && !["first", "first_listed", "co_first", "co_last", "corresponding", "equal_contributor"].includes(role)) usage("invalid author role");
  if (type && !["arxiv", "conference", "workshop", "journal", "book-chapter", "thesis", "other"].includes(type)) usage("invalid publication type");
  return { ...(year ? { year: Number(year) } : {}), ...(venue ? { venue } : {}), ...(author ? { author } : {}), ...(role ? { role: role as SearchFilters["role"] & string } : {}), ...(type ? { type: type as SearchFilters["type"] & string } : {}), ...(tag ? { tag } : {}), includeArchived: a.takeFlag("--include-archived") };
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const a = new Args([...argv]); const explicitRoot = a.take("--root"), json = a.takeFlag("--json"), command = a.shift();
  if (!command || ["help", "--help", "-h"].includes(command)) { output(HELP, false); return 0; }
  if (command === "config") {
    if (a.shift() !== "show" || a.values.length) usage("Usage: mypub config show");
    const config = await readUserConfig();
    output({ config_file: configPath(), config, repo_path: await resolveRepoRoot(explicitRoot) }, json);
    return 0;
  }
  const root = await resolveRepoRoot(explicitRoot);
  const c = new Catalog({ root }); let action: () => Promise<unknown>; let raw = false; let exitCode = 0;
  switch (command) {
    case "init": { const name = a.take("--name"); action = async () => { const l = await c.initialize(name); await initializeGit(c); return l; }; break; }
    case "list": case "search": { const f = filters(a); const query = a.shift(); action = async () => { const records = await c.list({ ...f, ...(query ? { query } : {}) }); return json ? records : table(records); }; break; }
    case "show": { const id = a.shift("publication ID")!; action = () => c.details(id); break; }
    case "add": { const file = a.take("--json-file"), doi = a.take("--doi"), arxiv = a.take("--arxiv"); if ([file, doi, arxiv].filter(Boolean).length !== 1) usage("add requires exactly one of --json-file, --doi, or --arxiv"); action = async () => { if (file) return c.add(await jsonFile(file)); let payload: unknown; const capture = (p: unknown): void => { payload = p; }; const input = doi ? await lookupDoi(doi, capture) : await lookupArxiv(arxiv!, capture); return stageImport(c, [input], doi ? "crossref" : "arxiv", payload); }; break; }
    case "update": { const id = a.shift("publication ID")!, file = a.take("--json-file") ?? usage("update requires --json-file"), expected = a.take("--expected-revision"); action = async () => c.update(id, await jsonFile(file), expected); break; }
    case "archive": case "unarchive": { const id = a.shift("publication ID")!; action = () => command === "archive" ? c.archive(id) : c.restorePublication(id); break; }
    case "author": case "venue": {
      const kind = command, sub = a.shift("action")!;
      if (sub === "list") action = async () => (await c.read())[kind === "author" ? "authors" : "venues"];
      else if (sub === "unresolved") action = async () => (await c.read()).publications.flatMap(p => kind === "author" ? p.authors.flatMap((credit, position) => credit.author_id ? [] : [{ publication_id: p.id, position, name: credit.name }]) : p.venue && !p.venue.venue_id ? [{ publication_id: p.id, name: p.venue.name }] : []);
      else if (sub === "add") { const file = a.take("--json-file") ?? usage("add requires --json-file"); action = async () => kind === "author" ? addAuthor(c, await jsonFile(file)) : addVenue(c, await jsonFile(file)); }
      else if (sub === "merge") { const source = a.shift("source")!, target = a.shift("target")!, apply = a.takeFlag("--apply"); action = () => mergeIdentity(c, kind, source, target, apply); }
      else if (kind === "author" && ["credit", "unlink"].includes(sub)) { const pub = a.shift("publication")!, position = Number(a.shift("position")), expected = a.take("--expected-revision") ?? usage("credit edits require --expected-revision"), file = sub === "credit" ? a.take("--json-file") ?? usage("credit requires --json-file") : undefined; if (!Number.isInteger(position) || position < 1) usage("position must be a positive integer"); action = async () => file ? updateCredit(c, pub, position, await jsonFile(file), expected) : unlinkCredit(c, pub, position, expected); }
      else if (kind === "venue" && ["link", "unlink"].includes(sub)) { const pub = a.shift("publication")!, venue = sub === "link" ? a.shift("venue")! : undefined; action = () => linkVenue(c, pub, venue); }
      else { const id = a.shift("identity ID")!; if (sub === "show") action = () => identityDetails(c, kind, id); else if (sub === "update") { const file = a.take("--json-file") ?? usage("update requires --json-file"), expected = a.take("--expected-revision"); action = async () => updateIdentity(c, kind, id, await jsonFile(file), expected); } else if (["archive", "restore"].includes(sub)) action = () => archiveIdentity(c, kind, id, sub === "archive"); else usage("invalid identity action"); }
      break;
    }
    case "owner": { const sub = a.shift("action"); if (sub === "show") action = async () => (await c.read()).owner; else if (sub === "set") { const id = a.shift("author")!, profile = a.take("--profile-id"); action = () => configureOwner(c, id, profile); } else usage("owner action must be set or show"); break; }
    case "import": { const file = a.shift("file")!, provider = a.take("--provider"), coverage = a.takeFlag("--partial") ? "partial" : "complete"; action = () => importFile(c, file, provider, coverage); break; }
    case "relation": { const sub = a.shift("action"), source = a.shift("source")!, target = a.shift("target")!, type = a.take("--type") as RelationType | undefined, note = a.take("--note"); if (sub === "add") { if (!type) usage("relation add requires --type"); action = () => c.addRelation(source, target, type!, note); } else if (sub === "remove") action = () => c.removeRelation(source, target, type); else usage("invalid relation action"); break; }
    case "attachment": { const sub = a.shift("action"), id = a.shift("publication")!;
      if (sub === "add") { const file = a.shift("file")!, role = a.take("--role") as AttachmentRole | undefined, label = a.take("--label"), primary = a.takeFlag("--primary"); if (!role) usage("attachment add requires --role"); action = () => c.addAttachment(id, file, role!, label, primary); }
      else if (sub === "list") action = async () => (await c.get(id)).attachments;
      else if (sub === "fetch") action = async () => { const p = await c.get(id); for (const item of p.attachments) await run("git", ["lfs", "pull", "--include", item.path, "--exclude", ""], c.root); return { fetched: p.attachments.length }; };
      else if (sub === "open") { const aid = a.shift(); action = async () => { const p = await c.get(id), att = aid ? p.attachments.find(x => x.id === aid) : p.attachments.find(x => x.id === p.primary_attachment_id) ?? p.attachments[0]; if (!att) throw new MyPubError("Attachment not found", "NOT_FOUND"); const target = join(c.root, att.path); await run(process.platform === "darwin" ? "open" : "xdg-open", [target], c.root); return { opened: target }; }; }
      else usage("invalid attachment action"); break;
    }
    case "review": { const sub = a.shift("action"); if (sub === "list") { const state = a.take("--state") as ReviewState | undefined; action = () => listReviews(c, state); } else { const id = a.shift("review ID")!; if (sub === "show") action = () => getReview(c, id); else if (sub === "reopen") { const proposal = a.take("--proposal"); action = () => reopenReview(c, id, proposal); } else if (["accept", "reject", "defer"].includes(sub ?? "")) { const note = a.take("--note"), proposal = a.take("--proposal"); action = () => decideReview(c, id, sub === "accept" ? "accepted" : sub === "reject" ? "rejected" : "deferred", note, proposal ? [proposal] : undefined); } else usage("invalid review action"); } break; }
    case "gscholar": case "scholar": { const sub = a.shift("action");
      if (sub === "import") { const file = a.shift("file")!, partial = a.takeFlag("--partial"), coverage = a.take("--coverage") ?? (partial ? "partial" : "unknown"), time = a.take("--observed-at"); if (!["complete", "partial", "unknown"].includes(coverage)) usage("invalid coverage"); action = () => importScholarSnapshot(c, file, coverage as Coverage, time); }
      else if (sub === "reconcile") action = () => reconcileScholar(c);
      else if (sub === "link" || sub === "unlink") { const pub = a.shift("publication")!, entry = sub === "link" ? a.shift("entry")! : undefined; action = () => linkScholar(c, pub, entry); }
      else if (sub === "exclude" || sub === "include") { const id = a.shift("entry")!, reason = a.take("--reason"), unlink = a.takeFlag("--unlink-publications"), preview = a.takeFlag("--preview"); action = () => matchingPolicy(c, id, sub === "exclude", reason, unlink, preview); }
      else usage("invalid gscholar action"); break;
    }
    case "status": { const details = a.takeFlag("--details"); action = async () => { const result = await status(c); return json ? result : formatStatus(result, c.root, details); }; break; }
    case "history": { const id = a.shift(); action = () => history(c, id); break; }
    case "commit": { const message = a.take("--message"); action = async () => { const result = await commit(c, message); return json ? result : result.state === "no-changes" ? "No local changes to commit." : `Committed locally: ${result.commit!.slice(0, 12)} — ${result.message}\nNothing was uploaded. Run mypub sync when ready to synchronize.`; }; break; }
    case "sync": { const message = a.take("--message"); action = async () => { const result = await sync(c, message, json ? undefined : event => { process.stderr.write(`${event.message}\n`); }); if (result.state === "needs-review") exitCode = 4; return json ? result : ({ "needs-review": "Synchronization paused: conflicts need review. Run mypub conflicts. Your current catalog is preserved.", "up-to-date": "Already synchronized with the configured upstream.", pushed: "Uploaded local commits. Synchronized with the configured upstream.", pulled: "Downloaded and applied remote commits. Synchronized with the configured upstream.", merged: "Combined local and remote commits. Synchronized with the configured upstream." })[result.state]; }; break; }
    case "conflicts": { const id = a.shift(); if (!id) action = () => listConflicts(c); else { const choice = a.take("--choice"), file = a.take("--file"); if (choice !== "ours" && choice !== "theirs") usage("choice must be ours or theirs"); action = () => resolveConflict(c, id, choice as "ours" | "theirs", file); } break; }
    case "export": { const format = a.take("--format") ?? "bibtex", dest = a.take("--output"), f = filters(a); if (!["bibtex", "csv", "json"].includes(format)) usage("format must be bibtex, csv, or json"); raw = !dest; action = async () => { const records = await c.list(f); const content = format === "bibtex" ? toBibtex(records) : format === "csv" ? toCsv(records) : `${JSON.stringify(nativeExport(await c.read(), records.map(p => p.id)), null, 2)}\n`; if (!dest) return content; await mkdir(dirname(resolve(dest)), { recursive: true }); await writeFile(resolve(dest), content); return { output: resolve(dest), count: records.length }; }; break; }
    case "validate": { const verify = !a.takeFlag("--skip-attachments"); action = async () => { const result = await c.validate(verify); exitCode = result.valid ? 0 : 4; return result; }; break; }
    case "audit": action = async () => { const findings = await c.audit(); exitCode = findings.length ? 4 : 0; return findings; }; break;
    case "recover": action = () => c.recover(); break;
    case "repair-paths": action = () => c.repairPaths(); break;
    case "backup": { const dest = a.shift("destination")!, filesOnly = a.takeFlag("--files-only"); action = () => backup(c, dest, filesOnly); break; }
    case "restore": { const source = a.shift("source")!; action = () => restore(c, source); break; }
    case "index": if (a.shift("action") !== "rebuild") usage("index action must be rebuild"); action = () => rebuildSearchIndex(c); break;
    default: usage(`Unknown command: ${command}`);
  }
  // Parse every argument before performing any mutation.
  if (a.values.length) usage(`Unexpected arguments: ${a.values.join(" ")}`);
  output(await action!(), raw ? false : json); return exitCode;
}
function table(records: Awaited<ReturnType<Catalog["list"]>>): string { return records.length ? ["KEY  YEAR  TYPE  TITLE", ...records.map(p => `${p.citation_key}  ${publicationDate(p)?.slice(0, 4) ?? ""}  ${p.type}  ${p.title}`)].join("\n") : "No publications."; }
if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : undefined)) main().then((code) => { process.exitCode = code; }).catch((error: unknown) => { const typed = error instanceof MyPubError ? error : new MyPubError(error instanceof Error ? error.message : String(error), "UNEXPECTED"); process.stderr.write(`${typed.code}: ${typed.message}\n`); if (process.env.MYPUB_DEBUG && error instanceof Error) process.stderr.write(`${error.stack ?? ""}\n`); process.exitCode = typed.code === "USAGE" ? 2 : typed.code === "NOT_FOUND" ? 3 : typed.code.includes("VALIDATION") || typed.code.includes("CONFLICT") ? 4 : 1; });
