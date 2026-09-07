import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Catalog } from "./catalog.js";
import { importScholarSnapshot, linkScholar, matchingPolicy, reconcileScholar } from "./scholar.js";
import { addAuthor, configureOwner } from "./identities.js";
import { decideReview, reopenReview } from "./reviews.js";

async function fixture() { const root = await mkdtemp(join(tmpdir(), "mypub-scholar-")); const c = new Catalog({ root }); await c.initialize(); const a = await addAuthor(c, { author_key: "self", preferred_name: "Self" }); await configureOwner(c, a.id, "profile"); return { root, c }; }
async function snapshot(root: string, captured_at: string, entries: unknown[], coverage = "partial") { const path = join(root, "capture.json"); await writeFile(path, JSON.stringify({ profile_id: "profile", captured_at, coverage, entries })); return path; }
test("Scholar capture preserves source details, requires explicit matching, and shares counts", async () => {
  const { root, c } = await fixture(); try {
    const first = await c.add({ citation_key: "one", title: "Shared Paper", type: "journal", authors: [{ name: "A" }], publication_date: "2026" });
    const second = await c.add({ citation_key: "two", title: "Shared Paper", type: "conference", authors: [{ name: "B" }], publication_date: "2026" });
    const path = await snapshot(root, "2026-09-01T00:00:00Z", [{ scholar_id: "entry", title: "Shared Paper", year: 2026, authors: ["A", "B"], authors_text: "A, B, …", authors_completeness: "partial", publication_date: "2026/9/1", volume: "3", citation_count: 12, annual_counts: { "2025": 2, "2026": 10 } }]);
    const result = await importScholarSnapshot(c, path); assert.equal(result.candidates[0]?.publication_ids.length, 2); assert.deepEqual(result.matched, []);
    assert.equal((await importScholarSnapshot(c, path)).source_review_id, result.source_review_id);
    const entry = (await c.read()).gscholar_entries[0]!; assert.equal(entry.publication_date, "2026/9/1"); assert.equal(entry.authors_text, "A, B, …");
    await linkScholar(c, first.id, entry.id); await linkScholar(c, second.id, entry.id);
    assert.equal((await c.details(first.id)).citation_count, 12); assert.equal((await reconcileScholar(c)).shared_counts[0]?.publication_ids.length, 2);
    await importScholarSnapshot(c, await snapshot(root, "2026-09-02T00:00:00Z", [{ scholar_id: "entry", title: "Shared Paper", citation_count: null }]));
    assert.equal((await c.details(first.id)).citation_count, null);
    await importScholarSnapshot(c, await snapshot(root, "2026-08-01T00:00:00Z", [{ scholar_id: "entry", title: "Older spelling", citation_count: 5 }]));
    assert.equal((await c.read()).gscholar_entries[0]?.title, "Shared Paper"); assert.equal((await c.details(first.id)).citation_count, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("exclusion requires atomic unlinking, survives refresh, and does not lose citations", async () => {
  const { root, c } = await fixture(); try {
    const p = await c.add({ citation_key: "paper", type: "other", title: "Paper", authors: [] });
    await importScholarSnapshot(c, await snapshot(root, "2026-09-01T00:00:00Z", [{ scholar_id: "entry", title: "Paper", citation_count: 4 }])); const id = (await c.read()).gscholar_entries[0]!.id;
    await linkScholar(c, p.id, id); await assert.rejects(matchingPolicy(c, id, true, "Not mine")); assert.equal((await c.get(p.id)).gscholar_entry_id, id);
    await matchingPolicy(c, id, true, "Not mine", true); assert.equal((await c.get(p.id)).gscholar_entry_id, undefined);
    await importScholarSnapshot(c, await snapshot(root, "2026-09-02T00:00:00Z", [{ scholar_id: "entry", title: "Paper", citation_count: 7 }]));
    assert.equal((await c.read()).gscholar_entries[0]?.matching.policy, "excluded"); assert.equal((await c.read()).gscholar_entries[0]?.citation_history.at(-1)?.count, 7);
    await assert.rejects(linkScholar(c, p.id, id)); await matchingPolicy(c, id, false); assert.equal((await c.get(p.id)).gscholar_entry_id, undefined);
    const pending = (await c.read()).reviews.find(r => r.proposals.some(x => x.proposed === id && x.state === "pending"))!;
    await decideReview(c, pending.id, "rejected"); await assert.rejects(linkScholar(c, p.id, id)); await reopenReview(c, pending.id); await decideReview(c, pending.id, "accepted"); assert.equal((await c.get(p.id)).gscholar_entry_id, id);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("only newer complete captures mark entries missing; metadata-only capture adds no count", async () => {
  const { root, c } = await fixture(); try {
    await importScholarSnapshot(c, await snapshot(root, "2026-09-02T00:00:00Z", [{ scholar_id: "entry", title: "Paper", citation_count: 0 }]));
    await importScholarSnapshot(c, await snapshot(root, "2026-09-03T00:00:00Z", [])); assert.equal((await c.read()).gscholar_entries[0]?.presence, "present");
    await importScholarSnapshot(c, await snapshot(root, "2026-09-01T00:00:00Z", [], "complete")); assert.equal((await c.read()).gscholar_entries[0]?.presence, "present");
    await importScholarSnapshot(c, await snapshot(root, "2026-09-04T00:00:00Z", [{ scholar_id: "entry", title: "Paper", authors: ["Full", "List"], authors_completeness: "complete" }])); assert.equal((await c.read()).gscholar_entries[0]?.citation_history.length, 1);
    await importScholarSnapshot(c, await snapshot(root, "2026-09-05T00:00:00Z", [], "complete")); const entry = (await c.read()).gscholar_entries[0]!; assert.equal(entry.presence, "missing"); assert.equal(entry.citation_history.at(-1)?.count, null);
    await importScholarSnapshot(c, await snapshot(root, "2026-09-06T00:00:00Z", [{ scholar_id: "entry", title: "Paper", authors: ["Full"], authors_completeness: "partial" }])); const fresh = (await c.read()).gscholar_entries[0]!; assert.equal(fresh.presence, "present"); assert.deepEqual(fresh.authors, ["Full", "List"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("invalid citation counts roll back the whole capture", async () => {
  const { root, c } = await fixture(); try { for (const count of [-1, 1.5, "many"]) { await assert.rejects(importScholarSnapshot(c, await snapshot(root, "2026-09-01T00:00:00Z", [{ scholar_id: "entry", title: "Paper", citation_count: count }]))); assert.equal((await c.read()).gscholar_entries.length, 0); assert.equal((await c.read()).reviews.length, 0); } } finally { await rm(root, { recursive: true, force: true }); }
});
test("an older newly discovered entry respects a previously imported complete capture", async () => {
  const { root, c } = await fixture(); try {
    await importScholarSnapshot(c, await snapshot(root, "2026-09-05T00:00:00Z", [], "complete"));
    await importScholarSnapshot(c, await snapshot(root, "2026-09-01T00:00:00Z", [{ scholar_id: "old", title: "Historical Entry", citation_count: 8 }]));
    const g = (await c.read()).gscholar_entries[0]!; assert.equal(g.presence, "missing"); assert.equal(g.missing_since, "2026-09-05T00:00:00Z"); assert.equal(g.citation_history.at(-1)?.count, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
