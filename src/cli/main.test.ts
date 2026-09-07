import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { main } from "./main.js";
import { MyPubError } from "../core/errors.js";

async function invoke(args: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = ""; const original = process.stdout.write; process.stdout.write = ((chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; }) as typeof process.stdout.write;
  try { return { code: await main(args), stdout }; } finally { process.stdout.write = original; }
}

test("CLI provides an end-to-end JSON and readable workflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-cli-test-"));
  try {
    assert.match((await invoke(["--help"])).stdout, /mypub — portable publication catalog/);
    const initialized = await invoke(["--root", root, "--json", "init", "--name", "CLI Library"]); assert.equal(initialized.code, 0); assert.equal(JSON.parse(initialized.stdout).name, "CLI Library");
    const input = join(root, "publication.json"); await writeFile(input, JSON.stringify({ citation_key: "cli2026", type: "conference", title: "CLI Paper", authors: [{ name: "Command Author" }], publication_date: "2026", tags: ["cli"] }), "utf8");
    const added = JSON.parse((await invoke(["--root", root, "--json", "add", "--json-file", input])).stdout); assert.equal(added.citation_key, "cli2026");
    const secondInput = join(root, "second.json"); await writeFile(secondInput, JSON.stringify({ citation_key: "second2025", type: "arxiv", title: "Second Paper", authors: [{ name: "Second Author" }] }), "utf8"); const second = JSON.parse((await invoke(["--root", root, "--json", "add", "--json-file", secondInput])).stdout);
    const update = join(root, "update.json"); await writeFile(update, JSON.stringify({ venue: { name: "CLI Conference" } }), "utf8"); assert.equal(JSON.parse((await invoke(["--root", root, "--json", "update", "cli2026", "--json-file", update])).stdout).venue.name, "CLI Conference");
    assert.match((await invoke(["--root", root, "list", "--year", "2026", "--tag", "cli"])).stdout, /CLI Paper/); assert.match((await invoke(["--root", root, "search", "command author"])).stdout, /CLI Paper/); const shown = JSON.parse((await invoke(["--root", root, "--json", "show", "cli2026"])).stdout); assert.equal(shown.publication.id, added.id);
    assert.equal(JSON.parse((await invoke(["--root", root, "--json", "relation", "add", "cli2026", "second2025", "--type", "published_version_of", "--note", "Earlier"])).stdout).relations.length, 1); assert.equal(JSON.parse((await invoke(["--root", root, "--json", "relation", "remove", "cli2026", "second2025"])).stdout).relations.length, 0);
    const attachment = join(root, "slides.pdf"); await writeFile(attachment, "%PDF CLI", "utf8"); await invoke(["--root", root, "--json", "attachment", "add", "cli2026", attachment, "--role", "slides", "--label", "Talk"]); assert.equal(JSON.parse((await invoke(["--root", root, "--json", "attachment", "list", "cli2026"])).stdout).length, 1);
    const bib = join(root, "incoming.bib"); await writeFile(bib, "@misc{imported, title={Imported CLI}, author={Import Author}}", "utf8"); const imported = JSON.parse((await invoke(["--root", root, "--json", "import", bib, "--provider", "fixture", "--partial"])).stdout); const reviews = JSON.parse((await invoke(["--root", root, "--json", "review", "list", "--state", "pending"])).stdout); assert.equal(reviews[0].id, imported.review_ids[0]); assert.equal(JSON.parse((await invoke(["--root", root, "--json", "review", "show", reviews[0].id])).stdout).state, "pending"); assert.equal(JSON.parse((await invoke(["--root", root, "--json", "review", "reject", reviews[0].id, "--note", "No"])).stdout).state, "rejected");
    const authorFile = join(root, "author.json"); await writeFile(authorFile, JSON.stringify({ author_key: "self", preferred_name: "Owner" }));
    await invoke(["--root", root, "--json", "author", "add", "--json-file", authorFile]); await invoke(["--root", root, "--json", "owner", "set", "self", "--profile-id", "profile"]);
    const scholar = join(root, "scholar.csv"); await writeFile(scholar, "scholar_id,title,year,citations\nentry,CLI Paper,2026,3\n"); assert.equal(JSON.parse((await invoke(["--root", root, "--json", "gscholar", "import", scholar, "--partial"])).stdout).candidates.length, 1);
    const exportPath = join(root, "local", "exports", "papers.csv"); const exported = JSON.parse((await invoke(["--root", root, "--json", "export", "--format", "csv", "--output", exportPath])).stdout); assert.equal(exported.count, 2); assert.match(await readFile(exportPath, "utf8"), /cli2026/);
    assert.match((await invoke(["--root", root, "export", "--format", "bibtex"])).stdout, /@inproceedings/); assert.match((await invoke(["--root", root, "export", "--format", "json"])).stdout, /CLI Paper/);
    assert.equal((await invoke(["--root", root, "--json", "validate", "--skip-attachments"])).code, 0); const indexed = JSON.parse((await invoke(["--root", root, "--json", "index", "rebuild"])).stdout); assert.equal(indexed.indexed, 2); assert.equal(JSON.parse((await invoke(["--root", root, "--json", "conflicts"])).stdout).length, 0); assert.equal(JSON.parse((await invoke(["--root", root, "--json", "status"])).stdout).git, true); assert.match((await invoke(["--root", root, "status"])).stdout, /Uncommitted files:/); assert.equal(JSON.parse((await invoke(["--root", root, "--json", "commit", "--message", "CLI fixture"])).stdout).state, "committed"); assert.match((await invoke(["--root", root, "commit"])).stdout, /No local changes to commit/);
    const archived = JSON.parse((await invoke(["--root", root, "--json", "archive", "cli2026"])).stdout); assert.ok(archived.archived_at); await invoke(["--root", root, "--json", "archive", second.id]); assert.match((await invoke(["--root", root, "list"])).stdout, /No publications/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI reports usage errors to API callers", async () => {
  await assert.rejects(main(["unknown-command"]), (error: unknown) => error instanceof MyPubError && error.code === "USAGE");
  await assert.rejects(main(["relation", "add"]), (error: unknown) => error instanceof MyPubError && error.code === "USAGE");
  await assert.rejects(main(["--root"]), (error: unknown) => error instanceof MyPubError && error.code === "USAGE");
  await assert.rejects(main(["export", "--format", "invalid"]), (error: unknown) => error instanceof MyPubError && error.code === "USAGE");
  await assert.rejects(main(["index", "wrong"]), (error: unknown) => error instanceof MyPubError && error.code === "USAGE");
});
test("unsupported CLI flags cannot cause writes before the usage error", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-cli-args-")); try {
    await invoke(["--root", root, "init"]); const input = join(root, "publication.json"); await writeFile(input, JSON.stringify({ citation_key: "unexpected", title: "Paper", type: "other", authors: [] }));
    await assert.rejects(main(["--root", root, "add", "--json-file", input, "--status", "published"]), (e: unknown) => e instanceof MyPubError && e.code === "USAGE");
    const { Catalog } = await import("../core/catalog.js"); assert.equal((await new Catalog({ root }).list()).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
