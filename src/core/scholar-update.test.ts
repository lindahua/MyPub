import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Catalog } from "./catalog.js";
import { MyPubError } from "./errors.js";
import { addAuthor, configureOwner } from "./identities.js";
import { backfillScholarDetails, updateScholar } from "./scholar-update.js";
import { importScholarSnapshot, linkScholar } from "./scholar.js";
import { parseScholarDetail, parseScholarOverview, scholarFetcher } from "../adapters/scholar.js";

const row = (id: string, citations = "1,234") => `<tr class="gsc_a_tr"><td><a class="gsc_a_at" href="/citations?citation_for_view=profile:${id}">Paper &amp; ${id}</a><div class="gs_gray">A, …</div><div class="gs_gray">Overview venue</div></td><td><a class="gsc_a_ac">${citations}</a></td><td class="gsc_a_y"><span>2026</span></td></tr>`;
const overview = (rows: string, more = false) => `<div id="gsc_prf_in">Self</div><table><tbody id="gsc_a_b">${rows || '<tr id="gsc_a_nn"><td>No articles</td></tr>'}</tbody></table><button id="gsc_bpf_more" ${more ? "" : "disabled"}>Show more</button>`;
const detail = `<div id="gsc_oci_title">Full &amp; title</div><div id="gsc_oci_table"><div class="gs_scl"><div class="gsc_oci_field">Authors</div><div class="gsc_oci_value">Alice Doe, Bob Li</div></div><div class="gs_scl"><div class="gsc_oci_field">Publication date</div><div class="gsc_oci_value">2026/8/15</div></div><div><div class="gsc_oci_field">Journal</div><div class="gsc_oci_value">Detailed journal</div></div><div><div class="gsc_oci_field">Description</div><div class="gsc_oci_value">A <b>useful</b> abstract.</div></div></div>`;
function transport(pages: (string | number)[], urls: string[] = []) {
  return { sleep: async () => {}, fetch: (async (url: string | URL | Request) => { urls.push(String(url)); const page = pages.shift(); assert.notEqual(page, undefined, "unexpected extra request"); return new Response(typeof page === "string" ? page : "error", { status: typeof page === "number" ? page : 200 }); }) as typeof fetch };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mypub-scholar-update-")), c = new Catalog({ root });
  await c.initialize(); const author = await addAuthor(c, { author_key: "self", preferred_name: "Self" }); await configureOwner(c, author.id, "profile");
  return { root, c };
}
test("live update paginates, excludes and unlinks absent entries, and restores source presence", async () => {
  const { root, c } = await fixture();
  try {
    const urls: string[] = [];
    const first = await updateScholar(c, transport([overview(row("a"), true), overview(row("b", "0")), detail, detail], urls));
    assert.equal(first.added, 2); assert.equal(new URL(urls[1]!).searchParams.get("cstart"), "100");
    let state = await c.read(); const a = state.gscholar_entries.find(g => g.scholar_id === "profile:a")!;
    assert.equal(a.citation_history.at(-1)?.count, 1234); assert.deepEqual(a.authors, ["Alice Doe", "Bob Li"]); assert.equal(a.publication_date, "2026/8/15"); assert.equal(a.venue, "Detailed journal"); assert.equal(a.year, 2026);
    assert.equal(state.reviews.find(r => r.id === first.source_review_id)?.evidence?.parser_version, "mypub-scholar-web/1");
    const p = await c.add({ citation_key: "local", title: "Curated", type: "other", authors: [] }); await linkScholar(c, p.id, a.id);
    const second = await updateScholar(c, transport([overview(row("b", "5"))])); assert.equal(second.added, 0);
    state = await c.read(); const absent = state.gscholar_entries.find(g => g.id === a.id)!; assert.equal(absent.presence, "absent"); assert.equal(absent.matching.policy, "excluded"); assert.equal(absent.matching.reason, "absent"); assert.equal((await c.get(p.id)).gscholar_entry_id, undefined); assert.equal((await c.details(p.id)).citation_count, null); assert.equal((await c.get(p.id)).title, "Curated");
    const absenceReview = state.reviews.find(r => r.id === absent.matching.decision_review_id)!; assert.equal(absenceReview.proposals.some(change => change.operation === "unlink" && change.target.entity_id === p.id && change.state === "accepted"), true);
    await updateScholar(c, transport([overview(row("a", "9") + row("b", ""))]));
    state = await c.read(); assert.equal(state.gscholar_entries.find(g => g.id === a.id)?.presence, "present"); assert.equal(state.gscholar_entries.find(g => g.id === a.id)?.matching.policy, "excluded"); assert.deepEqual(state.gscholar_entries.find(g => g.id === a.id)?.authors, a.authors); assert.equal((await c.details(p.id)).citation_count, null);
    assert.equal(state.gscholar_entries.find(g => g.scholar_id === "profile:b")?.citation_history.at(-1)?.count, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("failed pages, detail failures, duplicate pagination, and malformed responses never mutate the catalog", async () => {
  const { root, c } = await fixture();
  try {
    await updateScholar(c, transport([overview(row("a")), detail])); const before = await c.read();
    for (const pages of [[429], ["<html>recaptcha</html>"], ["<html>Login</html>"], [overview(row("b")), 500], [overview(row("a"), true), overview(row("a"))], [overview(row("a"), true), "truncated"], [overview(row("b")), "<div id=gsc_oci_title>truncated</div>"]]) {
      await assert.rejects(updateScholar(c, transport(pages))); assert.deepEqual(await c.read(), before);
    }
    await updateScholar(c, transport([overview("")])); assert.equal((await c.read()).gscholar_entries[0]?.presence, "absent");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("parser rejects ambiguous coverage and foreign IDs; keeps unknown counts and partial authors", () => {
  assert.throws(() => parseScholarOverview(overview(row("a")).replace(' disabled', '' ).replace(row("a"), ''), "profile"));
  assert.throws(() => parseScholarOverview(overview(row("a")).replace('id="gsc_bpf_more"', 'id="unknown"'), "profile"));
  assert.throws(() => parseScholarOverview(overview(row("a")), "other"));
  assert.equal(parseScholarOverview(overview(row("a", "")), "profile").entries[0]?.citation_count, null);
  assert.equal(parseScholarOverview(overview(row("a", "12*")), "profile").entries[0]?.estimated, true);
  const parsed = parseScholarDetail(detail.replace("Alice Doe, Bob Li", "Alice Doe, …"), "profile", "profile:a");
  assert.deepEqual(parsed.authors, ["Alice Doe"]); assert.equal(parsed.authors_completeness, "partial"); assert.equal(parsed.description, "A useful abstract.");
});
test("network errors are actionable and profile setup is required before requests", async () => {
  const get = scholarFetcher({ fetch: async () => { throw new Error("offline"); } }); await assert.rejects(get("https://scholar.google.com"), /request failed: offline/);
  const blocked = scholarFetcher({ fetch: async () => new Response("", { status: 302, headers: { location: "https://www.google.com/sorry/index" } }) }); await assert.rejects(blocked("https://scholar.google.com"), (error: unknown) => error instanceof Error && error.message === "Google Scholar blocked the request. Retry later.");
  const root = await mkdtemp(join(tmpdir(), "mypub-no-profile-"));
  try { const c = new Catalog({ root }); await c.initialize(); await assert.rejects(updateScholar(c, transport([])), /Configure the owner/); } finally { await rm(root, { recursive: true, force: true }); }
});
test("detail backfill enriches existing unknown entries in durable, resumable batches", async () => {
  const { root, c } = await fixture();
  try {
    const path = join(root, "unknown.json");
    await writeFile(path, JSON.stringify({ profile_id: "profile", captured_at: "2026-09-01T00:00:00Z", entries: [
      { scholar_id: "a", title: "Existing A", authors: ["Overview A"], authors_completeness: "unknown" },
      { scholar_id: "b", title: "Existing B", authors: ["Overview B"], authors_completeness: "unknown" }
    ] }));
    await importScholarSnapshot(c, path);
    const completeDetail = detail.replace("Full &amp; title", "Existing A");
    const interrupted = await backfillScholarDetails(c, { batchSize: 1, ...transport([completeDetail, 500, 500, 500]) });
    assert.equal(interrupted.processed, 1); assert.equal(interrupted.failed, 1); assert.equal(interrupted.remaining, 1);
    let state = await c.read();
    assert.equal(state.gscholar_entries.find(entry => entry.scholar_id.endsWith(":a"))?.authors_completeness, "complete");
    assert.equal(state.gscholar_entries.find(entry => entry.scholar_id.endsWith(":b"))?.authors_completeness, "unknown");
    assert.equal(state.reviews.filter(review => review.evidence?.parser_version === "mypub-scholar-detail-backfill/1").length, 1);
    const result = await backfillScholarDetails(c, { batchSize: 1, ...transport([detail.replace("Full &amp; title", "Existing B").replace("Alice Doe, Bob Li", "Overview B, …")]) });
    assert.deepEqual({ candidates: result.candidates, processed: result.processed, failed: result.failed, complete: result.complete, partial: result.partial, unknown: result.unknown, remaining: result.remaining, batches: result.batches }, { candidates: 1, processed: 1, failed: 0, complete: 0, partial: 1, unknown: 0, remaining: 0, batches: 1 });
    state = await c.read();
    assert.equal(state.gscholar_entries.find(entry => entry.scholar_id.endsWith(":b"))?.authors_completeness, "partial");
    assert.equal(state.reviews.filter(review => review.evidence?.parser_version === "mypub-scholar-detail-backfill/1").length, 2);
    assert.equal((await backfillScholarDetails(c, transport([]))).processed, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("relative block redirects stop backfill without retrying or saving the active batch", async () => {
  const { root, c } = await fixture();
  try {
    const path = join(root, "unknown.json");
    await writeFile(path, JSON.stringify({ profile_id: "profile", captured_at: "2026-09-01T00:00:00Z", entries: [
      { scholar_id: "a", title: "A" }, { scholar_id: "b", title: "B" }, { scholar_id: "c", title: "C" }
    ] }));
    await importScholarSnapshot(c, path);
    const before = await c.read();
    for (const location of ["/sorry/index?continue=x", "//www.google.com/sorry/index", "https://www.google.com/sorry/index"]) {
      let requests = 0;
      await assert.rejects(backfillScholarDetails(c, { sleep: async () => {}, fetch: async () => {
        requests++;
        return requests === 1 ? new Response(detail) : new Response("", { status: 302, headers: { location } });
      } }), (error: unknown) => error instanceof MyPubError && error.code === "SCHOLAR_BLOCKED");
      assert.equal(requests, 2);
      assert.deepEqual(await c.read(), before);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("sparse detail evidence retains a fuller existing author array and its unknown completeness", async () => {
  const { root, c } = await fixture();
  try {
    const path = join(root, "fuller.json");
    await writeFile(path, JSON.stringify({ profile_id: "profile", captured_at: "2026-09-01T00:00:00Z", entries: [{ scholar_id: "a", title: "Existing", authors: ["Alice Doe", "Bob Li"], authors_completeness: "unknown" }] }));
    await importScholarSnapshot(c, path);
    const result = await backfillScholarDetails(c, transport([detail.replace("Alice Doe, Bob Li", "Alice Doe, …")]));
    const entry = (await c.read()).gscholar_entries[0]!;
    assert.deepEqual(entry.authors, ["Alice Doe", "Bob Li"]); assert.equal(entry.authors_completeness, "unknown"); assert.equal(entry.authors_text, "Alice Doe, …");
    assert.equal(result.unknown, 1); assert.equal(result.remaining, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
