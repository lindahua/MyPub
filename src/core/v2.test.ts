import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile, mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "./catalog.js";
import { addAuthor, addVenue, updateIdentity, updateCredit, unlinkCredit, linkVenue, mergeIdentity, archiveIdentity, identityDetails, configureOwner } from "./identities.js";
import { catalogFiles, slug, surnameBucket } from "./paths.js";
import { atomicWriteJson, fingerprint, now, sha256, uuid, withLock } from "./utils.js";
import { importFile } from "./imports.js";
import { decideReview, reopenReview } from "./reviews.js";
import { nativeExport, importNative } from "./native.js";
import { history } from "./history.js";
import { commit, initializeGit } from "./sync.js";
import { run } from "../adapters/process.js";
import { backup, restore } from "./backup.js";
import { importScholarSnapshot, linkScholar } from "./scholar.js";
import { assertRecord } from "./schemas.js";
import { validateState } from "./validation.js";

async function fixture() { const root = await mkdtemp(join(tmpdir(), "mypub-v2-")); const c = new Catalog({ root }); await c.initialize(); return { root, c }; }
const input = { citation_key: "paper", type: "journal" as const, title: "A Paper", authors: [{ name: "Lin D." }, { name: "Lin D." }] };
const recordPath = async (c: Catalog, id: string) => join(c.root, [...catalogFiles(await c.read())].find(([, v]) => (v as { id?: string }).id === id)![0]);
test("same-name people remain distinct, credit roles and printed variants survive identity edits", async () => {
  const { root, c } = await fixture(); try {
    const a = await addAuthor(c, { author_key: "lin_d", preferred_name: "D. Lin", name_parts: { family: "Lin", given: "D." }, identifiers: { google_scholar: "personA" } });
    const b = await addAuthor(c, { author_key: "lin_other", preferred_name: "D. Lin", name_parts: { family: "Lin", given: "D." }, identifiers: { google_scholar: "personB" } });
    const p = await c.add({ ...input, authors: [{ name: "D. H. Lin", author_id: a.id, roles: ["co_first", "corresponding"] }, { name: "D. Lin", author_id: b.id, roles: ["co_first"] }] });
    assert.equal((await c.list({ author: a.id, role: "corresponding" })).length, 1); assert.equal((await c.list({ author: b.id, role: "first" })).length, 1); assert.equal((await c.list({ author: b.id, role: "first_listed" })).length, 0);
    await updateIdentity(c, "author", a.id, { preferred_name: "Dahua Lin", name_parts: { family: "Lin", given: "Dahua" }, aliases: ["D. H. Lin"] });
    assert.deepEqual((await c.get(p.id)).authors, p.authors); assert.match(await recordPath(c, a.id), /authors\/l\/lin_dahua_/);
    const rev = (await c.details(p.id)).record_revision; await updateCredit(c, p.id, 2, { name: "Other D. Lin" }, rev); await assert.rejects(unlinkCredit(c, p.id, 2, rev));
    await unlinkCredit(c, p.id, 2, (await c.details(p.id)).record_revision); assert.equal((await c.get(p.id)).authors[1]?.author_id, undefined);
    assert.equal((await identityDetails(c, "author", a.id)).publications.length, 1);
    await assert.rejects(addAuthor(c, { author_key: "duplicate", preferred_name: "Other", identifiers: { google_scholar: "personA" } }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("reviewed author and venue merges preserve credits and references; invalid merge is atomic", async () => {
  const { root, c } = await fixture(); try {
    const a = await addAuthor(c, { author_key: "a", preferred_name: "Alice" }), b = await addAuthor(c, { author_key: "b", preferred_name: "A. Person" });
    const p = await c.add({ ...input, authors: [{ name: "Alice P.", author_id: b.id }] });
    assert.deepEqual((await mergeIdentity(c, "author", b.id, a.id)).publication_ids, [p.id]); await mergeIdentity(c, "author", b.id, a.id, true);
    assert.equal((await c.get(p.id)).authors[0]?.name, "Alice P."); assert.equal((await c.get(p.id)).authors[0]?.author_id, a.id); await assert.rejects(archiveIdentity(c, "author", b.id, false));
    const v = await addVenue(c, { venue_key: "v", preferred_name: "Conference Series", kind: "conference" }); const w = await addVenue(c, { venue_key: "w", preferred_name: "Conf", kind: "conference" });
    await c.update(p.id, { venue: { name: "Proceedings of Conf 2026", event_year: 2026 } }); await linkVenue(c, p.id, w.id); await mergeIdentity(c, "venue", w.id, v.id, true);
    assert.equal((await c.get(p.id)).venue?.name, "Proceedings of Conf 2026"); assert.equal((await c.get(p.id)).venue?.venue_id, v.id);
    const d = await addAuthor(c, { author_key: "d", preferred_name: "Distinct" }); await c.update(p.id, { authors: [{ name: "Alice", author_id: a.id }, { name: "Distinct", author_id: d.id }] });
    await assert.rejects(mergeIdentity(c, "author", d.id, a.id, true)); assert.equal((await c.read()).authors.find(x => x.id === d.id)?.merged_into, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("readable filenames extend colliding UUID prefixes and move with corrected dates and surnames", async () => {
  const { root, c } = await fixture(); try {
    const a = await c.add({ ...input, id: "12345678-1111-4111-8111-111111111111" }); const old = await recordPath(c, a.id);
    const b = await c.add({ ...input, citation_key: "other", id: "12345678-2222-4222-8222-222222222222" }); assert.match(await recordPath(c, a.id), /a_paper_123456781111.json$/); assert.match(await recordPath(c, b.id), /123456782222/); await assert.rejects(readFile(old));
    await c.update(a.id, { publication_date: "2026-02", submission_date: "2024" }); assert.match(await recordPath(c, a.id), /publications\/2026\/a_paper_/);
    const person = await addAuthor(c, { author_key: "person", preferred_name: "Émile Person" }); assert.match(await recordPath(c, person.id), /unknown_surname/); await updateIdentity(c, "author", person.id, { name_parts: { family: "Éclair", given: "Émile" } }); assert.match(await recordPath(c, person.id), /authors\/e\/éclair_émile_/);
    assert.equal(surnameBucket("张"), "张"); assert.equal(surnameBucket("3D"), "_other"); assert.equal(slug("?!", "publication"), "publication");
    const wrong = join(c.publicationsDir, "wrong.json"); await rename(await recordPath(c, a.id), wrong); assert.ok((await c.validate(false)).issues.some(x => x.code === "PATH_MISMATCH")); await c.repairPaths(); await assert.rejects(readFile(wrong));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("duplicate arXiv IDs are admitted and audited; status and invalid dates remain blocking", async () => {
  const { root, c } = await fixture(); try {
    const a = await c.add({ ...input, identifiers: { arxiv: "2601.00001v2" } }); const b = await c.add({ ...input, citation_key: "other", identifiers: { arxiv: "2601.00001" } });
    assert.equal((await c.validate(false)).valid, true); assert.deepEqual((await c.audit())[0]?.publication_ids, [a.id, b.id].sort()); await assert.rejects(c.get("2601.00001"));
    for (const patch of [{ status: "published" }, { dates: { issued: "2026" } }, { publication_date: "2025-02-29" }, { created_by: "local-user" }]) await assert.rejects(c.update(a.id, patch as never));
    await c.update(a.id, { publication_date: "2024-02-29", acceptance_date: "2024-01" });
    const valid = await c.get(a.id); assert.throws(() => assertRecord("publication", { ...valid, schema_version: 1 })); assert.throws(() => assertRecord("publication", { ...valid, updated_at: "2026-09-07T25:00:00Z" }));
    await atomicWriteJson(join(c.catalogDir, "library.json"), { ...(await c.library()), schema_version: 1 }); await assert.rejects(c.add(input), /Only catalog schema version 2/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("review acceptance detects intervening edits and preserves immutable evidence", async () => {
  const { root, c } = await fixture(); try {
    const p = await c.add({ ...input, identifiers: { doi: "10.1000/test" } }); const path = join(root, "source.json"); await writeFile(path, JSON.stringify({ ...input, title: "New Title", identifiers: { doi: "10.1000/test" }, volume: "2" }));
    const imported = await importFile(c, path); await c.update(p.id, { notes: "Manual correction" }); await assert.rejects(decideReview(c, imported.source_review_id, "accepted"), /target changed/); assert.equal((await c.get(p.id)).title, "A Paper");
    await decideReview(c, imported.source_review_id, "deferred"); await reopenReview(c, imported.source_review_id); await decideReview(c, imported.source_review_id, "accepted"); assert.equal((await c.get(p.id)).title, "New Title"); assert.equal((await c.get(p.id)).notes, "Manual correction");
    await assert.rejects(c.change(s => { s.reviews.find(r => r.id === imported.source_review_id)!.evidence!.payload = "changed"; }), /immutable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("terminal review snapshots retain the former arxiv type without weakening live records", async () => {
  const { root, c } = await fixture(); try {
    const publication = await c.add({ ...input, type: "preprint" });
    const state = await c.read(); const time = now(); const proposedId = uuid();
    state.reviews.push({
      schema_version: 2, id: uuid(), summary: "Historical arXiv import", kind: "migration", state: "accepted",
      targets: [{ entity_type: "publication", entity_id: proposedId }],
      evidence: { provider: "pubman2", captured_at: time, payload: {}, completeness: "complete", parser_version: "test/1", input_fingerprint: fingerprint({}) },
      proposals: [{ id: uuid(), target: { entity_type: "publication", entity_id: proposedId }, operation: "create", proposed: { ...publication, id: proposedId, citation_key: "historical", type: "arxiv" }, state: "accepted", decided_at: time }],
      created_at: time, updated_at: time, decided_at: time,
    });
    assert.equal(validateState(state).valid, true);
    assert.throws(() => assertRecord("publication", { ...publication, type: "arxiv" }));
    state.reviews[0]!.proposals[0]!.state = "pending";
    delete state.reviews[0]!.proposals[0]!.decided_at;
    state.reviews[0]!.state = "pending";
    delete state.reviews[0]!.decided_at;
    assert.equal(validateState(state).valid, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("ready transactions recover before reads and failed staging never becomes visible", async () => {
  const { root, c } = await fixture(); try {
    const p = await c.add(input), path = await recordPath(c, p.id), id = uuid(), directory = join(c.localDir, "transactions", id); await mkdir(join(directory, "data"), { recursive: true });
    const changed = { ...p, notes: "Recovered" }; const staged = join(directory, "data/0"); await writeFile(staged, JSON.stringify(changed));
    await atomicWriteJson(join(directory, "manifest.json"), { schema_version: 2, id, state: "applying", created_at: now(), updated_at: now(), operations: [{ type: "write", path: path.slice(root.length + 1), staged_path: "data/0", sha256: await sha256(staged) }] });
    assert.equal((await c.get(p.id)).notes, "Recovered"); await assert.rejects(readFile(join(directory, "manifest.json")));
    const staging = uuid(); await atomicWriteJson(join(c.localDir, "transactions", staging, "manifest.json"), { id: staging, state: "staging" }); await c.recover(); assert.equal((await c.get(p.id)).notes, "Recovered");
    await withLock(join(c.localDir, "write.lock"), async () => { await assert.rejects(c.read(), /writer/); });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("native export round-trips dependency-closed entities, Scholar evidence and decisions", async () => {
  const { root, c } = await fixture(); const other = await fixture(); try {
    const a = await addAuthor(c, { author_key: "self", preferred_name: "Self" }); await configureOwner(c, a.id, "profile"); const v = await addVenue(c, { venue_key: "journal", preferred_name: "Journal", kind: "journal" }); const p = await c.add({ ...input, authors: [{ name: "S.", author_id: a.id }], venue: { name: "J.", venue_id: v.id } });
    const capture = join(root, "scholar.json"); await writeFile(capture, JSON.stringify({ profile_id: "profile", captured_at: "2026-09-01T00:00:00Z", entries: [{ scholar_id: "entry", title: "A Paper", citation_count: 10 }] })); await importScholarSnapshot(c, capture); const entry = (await c.read()).gscholar_entries[0]!; await linkScholar(c, p.id, entry.id);
    const envelope = nativeExport(await c.read(), [p.id]); assert.equal(envelope.authors[0]?.id, a.id); assert.ok(envelope.reviews.length); const imported = await importNative(other.c, envelope); assert.equal((await other.c.list()).length, 0); await decideReview(other.c, imported.source_review_id, "accepted");
    assert.deepEqual(await other.c.get(p.id), await c.get(p.id)); assert.equal((await other.c.details(p.id)).citation_count, 10); assert.equal((await other.c.validate(false)).valid, true); assert.equal((await importNative(other.c, envelope)).duplicates, 1);
    const collision = structuredClone(envelope); collision.publications[0]!.title = "Collision"; await assert.rejects(importNative(other.c, collision), /collision/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(other.root, { recursive: true, force: true }); }
});
test("Git history uses historical committer across renames and survives a backup bundle", async () => {
  const { root, c } = await fixture(); const container = await mkdtemp(join(tmpdir(), "mypub-history-")); try {
    await initializeGit(c); await run("git", ["config", "user.name", "Actual Committer"], root); await run("git", ["config", "user.email", "committer@example.invalid"], root);
    const p = await c.add(input); await run("git", ["add", "catalog"], root); await run("git", ["commit", "--author", "Original Author <author@example.invalid>", "-m", "Add publication"], root);
    await c.update(p.id, { title: "Renamed Publication", publication_date: "2026" }); await commit(c, "Rename and date");
    await run("git", ["config", "user.name", "Changed Configuration"], root);
    const events = await history(c, p.id); assert.equal(events.length, 2); assert.equal(events[1]?.committer.name, "Actual Committer"); assert.equal(events[1]?.author.name, "Original Author"); assert.ok(events[0]?.paths.some(path => path.includes("/2026/")));
    const attachment = join(container, "paper.pdf"); await writeFile(attachment, "%PDF history fixture"); await c.addAttachment(p.id, attachment, "paper"); await commit(c, "Add file"); const withAttachment = await history(c, p.id);
    await backup(c, join(container, "backup")); const restored = new Catalog({ root: join(container, "restored") }); await restore(restored, join(container, "backup")); assert.deepEqual(await history(restored, p.id), withAttachment); assert.equal((await restored.validate(true)).valid, true);
  } finally { await rm(root, { recursive: true, force: true }); await rm(container, { recursive: true, force: true }); }
});
