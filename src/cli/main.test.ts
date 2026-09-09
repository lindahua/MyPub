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
    const secondInput = join(root, "second.json"); await writeFile(secondInput, JSON.stringify({ citation_key: "second2025", type: "preprint", title: "Second Paper", authors: [{ name: "Second Author" }], identifiers: { arxiv: "2501.00002" }, publication_date: "2025-01-01", submission_date: "2025-01-01", arxiv_versions: [{ version: 1, submission_date: "2025-01-01", title: "Second Paper", authors: ["Second Author"], abstract: "Original abstract" }] }), "utf8"); const second = JSON.parse((await invoke(["--root", root, "--json", "add", "--json-file", secondInput])).stdout);
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
    assert.equal((await invoke(["--root", root, "--json", "validate", "--skip-attachments"])).code, 0); const indexed = JSON.parse((await invoke(["--root", root, "--json", "index", "rebuild"])).stdout); assert.equal(indexed.indexed, 2); assert.equal(JSON.parse((await invoke(["--root", root, "--json", "conflicts"])).stdout).length, 0); assert.equal(JSON.parse((await invoke(["--root", root, "--json", "status"])).stdout).git, true); assert.doesNotMatch((await invoke(["--root", root, "status"])).stdout, /Uncommitted files:/); assert.match((await invoke(["--root", root, "status", "--details"])).stdout, /Uncommitted files:/); assert.equal(JSON.parse((await invoke(["--root", root, "--json", "commit", "--message", "CLI fixture"])).stdout).state, "committed"); assert.match((await invoke(["--root", root, "commit"])).stdout, /No local changes to commit/);
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

test("gscholar update dispatches, rejects unknown options, and scholar is not an alias", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-cli-scholar-"));
  try {
    await invoke(["--root", root, "init"]);
    await assert.rejects(main(["--root", root, "scholar", "update"]), (error: unknown) => error instanceof MyPubError && error.code === "USAGE");
    for (const command of ["gscholar"]) {
      await assert.rejects(main(["--root", root, command, "update"]), (error: unknown) => error instanceof MyPubError && error.code === "PROFILE_NOT_CONFIGURED");
      await assert.rejects(main(["--root", root, command, "update", "--unexpected"]), (error: unknown) => error instanceof MyPubError && error.code === "USAGE");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("gscholar update prints progress and a readable summary, keeping JSON stdout clean", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-cli-progress-"));
  const originalFetch = globalThis.fetch, originalStderr = process.stderr.write;
  let stderr = "";
  try {
    const { Catalog } = await import("../core/catalog.js");
    const { addAuthor, configureOwner } = await import("../core/identities.js");
    const { importScholarSnapshot } = await import("../core/scholar.js");
    const c = new Catalog({ root }); await c.initialize();
    const author = await addAuthor(c, { author_key: "self", preferred_name: "Self" }); await configureOwner(c, author.id, "profile");
    const path = join(root, "capture.json");
    await writeFile(path, JSON.stringify({ profile_id: "profile", captured_at: "2020-01-01T00:00:00Z", entries: [{ scholar_id: "existing", title: "Existing", citation_count: 2 }, { scholar_id: "gone", title: "Gone", citation_count: 3 }] }));
    await importScholarSnapshot(c, path);
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr += chunk.toString(); return true; }) as typeof process.stderr.write;
    globalThis.fetch = async url => {
      assert.equal(new URL(String(url)).searchParams.has("view_op"), false, "existing entries need no detail request");
      return new Response('<div id="gsc_prf_in">Self</div><table><tbody id="gsc_a_b"><tr class="gsc_a_tr"><td><a class="gsc_a_at" href="/citations?citation_for_view=profile:existing">Existing</a></td><td><a class="gsc_a_ac">7</a></td></tr></tbody></table><button id="gsc_bpf_more" disabled>Show more</button>');
    };
    const readable = await invoke(["--root", root, "gscholar", "update"]);
    assert.equal(readable.stdout, "Google Scholar update complete.\nEntries observed: 1\nNew entries added: 0\nExisting entries refreshed: 1\nCitation counts checked: 1\nNewly absent: 1\nRestored: 0\nTotal absent: 1\n");
    assert.match(stderr, /Fetching Scholar profile page 1/); assert.match(stderr, /Read 1 entries on page 1 \(1 total\)/); assert.match(stderr, /Saving 1 Scholar entries/);
    stderr = "";
    const structured = JSON.parse((await invoke(["--root", root, "--json", "gscholar", "update"])).stdout);
    assert.equal(structured.updated, 1); assert.equal(structured.newly_absent, 0); assert.equal(structured.absent.length, 1); assert.match(stderr, /Fetching Scholar profile page 1/);
    globalThis.fetch = async () => new Response("Blocked", { status: 429 });
    await assert.rejects(invoke(["--root", root, "gscholar", "update"]), /blocked/);
  } finally { globalThis.fetch = originalFetch; process.stderr.write = originalStderr; await rm(root, { recursive: true, force: true }); }
});
