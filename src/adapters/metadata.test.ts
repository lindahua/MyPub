import assert from "node:assert/strict";
import test from "node:test";
import { lookupArxiv, lookupDoi } from "./metadata.js";
import { MyPubError } from "../core/errors.js";

const errorCode = (code: string) => (error: unknown): boolean => error instanceof MyPubError && error.code === code;

test("Crossref metadata is normalized into a publication proposal", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: { title: ["Testing Systems"], abstract: "<jats:p>First &amp; &#945;.</jats:p><jats:p>Second.</jats:p>", author: [{ given: "Ada", family: "Lovelace", ORCID: "0000-0000" }], issued: { "date-parts": [[2026, 9, 1]] }, "container-title": ["Journal of Tests"], type: "journal-article", URL: "https://doi.org/10.1005/test" } }), { status: 200 });
  try { const result = await lookupDoi("https://doi.org/10.1005/TEST"); assert.equal(result.identifiers?.doi, "10.1005/test"); assert.equal(result.official_url, "https://doi.org/10.1005/test"); assert.equal(result.paper_url, undefined); assert.equal(result.type, "journal"); assert.equal(result.authors[0]?.name, "Ada Lovelace"); assert.equal(result.authors[0]?.name_parts?.family, "Lovelace"); assert.equal(result.publication_date, "2026-09-01"); assert.equal(result.abstract, "First & α.\n\nSecond."); }
  finally { globalThis.fetch = original; }
});

test("metadata providers surface unavailable and malformed records", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("missing", { status: 404 }); await assert.rejects(lookupDoi("10.1005/missing"), errorCode("PROVIDER_FAILED")); await assert.rejects(lookupArxiv("2601.00001"), errorCode("PROVIDER_FAILED"));
    globalThis.fetch = async () => new Response(JSON.stringify({ message: {} }), { status: 200 }); await assert.rejects(lookupDoi("10.1005/empty"), errorCode("PROVIDER_INVALID"));
    globalThis.fetch = async () => new Response("<?xml version='1.0'?><feed></feed>", { status: 200 }); await assert.rejects(lookupArxiv("2601.00002"), errorCode("NOT_FOUND"));
  } finally { globalThis.fetch = original; }
});


const entry = (version: number) => `<entry><id>http://arxiv.org/abs/2602.00001v${version}</id><title>${version === 1 ? "First &amp; Original" : "Revised Title"}</title><published>2026-02-03T00:00:00Z</published><updated>${version === 1 ? "2026-02-03" : "2026-03-04"}T00:00:00Z</updated><summary>Abstract ${version} &lt; &#945;</summary><author><name>Grace Hopper</name></author>${version > 1 ? "<author><name>Alan Turing</name></author>" : ""}<arxiv:doi>10.1007/PAPER</arxiv:doi></entry>`;
test("arXiv lookup retains each version's metadata and always dates the paper from v1", async () => {
  const original = globalThis.fetch; const requests: string[] = []; let evidence: unknown;
  globalThis.fetch = async input => { requests.push(String(input)); return new Response(`<feed>${entry(requests.length === 1 ? 2 : 1)}</feed>`); };
  try {
    const result = await lookupArxiv("https://arxiv.org/abs/2602.00001v1", value => { evidence = value; });
    assert.equal(requests.length, 2); assert.match(requests[1]!, /2602.00001v1/);
    assert.equal(result.type, "preprint");
    assert.equal(result.publication_date, "2026-02-03"); assert.equal(result.submission_date, "2026-02-03");
    assert.equal(result.official_url, "https://arxiv.org/abs/2602.00001"); assert.equal(result.paper_url, "https://arxiv.org/pdf/2602.00001"); assert.equal(result.title, "Revised Title"); assert.equal(result.abstract, "Abstract 2 < α"); assert.equal(result.authors.length, 2); assert.equal(result.identifiers?.doi, undefined);
    assert.deepEqual(result.arxiv_versions?.map(v => [v.version, v.title, v.authors.length, v.abstract, v.submission_date]), [[1, "First & Original", 1, "Abstract 1 < α", "2026-02-03"], [2, "Revised Title", 2, "Abstract 2 < α", "2026-03-04"]]);
    assert.equal((evidence as { responses: string[] }).responses.length, 2);
  } finally { globalThis.fetch = original; }
});
test("arXiv lookup rejects incomplete histories instead of filling gaps with latest metadata", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(`<feed>${entry(2)}</feed>`);
  try { await assert.rejects(lookupArxiv("2602.00001"), errorCode("PROVIDER_INVALID")); }
  finally { globalThis.fetch = original; }
});
