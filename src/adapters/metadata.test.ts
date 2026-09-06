import assert from "node:assert/strict";
import test from "node:test";
import { lookupArxiv, lookupDoi } from "./metadata.js";
import { MyPubError } from "../core/errors.js";

const errorCode = (code: string) => (error: unknown): boolean => error instanceof MyPubError && error.code === code;

test("Crossref metadata is normalized into a publication proposal", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: { title: ["Testing Systems"], author: [{ given: "Ada", family: "Lovelace", ORCID: "0000-0000" }], issued: { "date-parts": [[2026, 9, 1]] }, "container-title": ["Journal of Tests"], type: "journal-article", URL: "https://doi.org/10.5/test" } }), { status: 200 });
  try { const result = await lookupDoi("https://doi.org/10.5/TEST"); assert.equal(result.identifiers?.doi, "10.5/test"); assert.equal(result.type, "journal"); assert.equal(result.authors[0]?.name, "Ada Lovelace"); assert.equal(result.authors[0]?.orcid, "0000-0000"); assert.equal(result.dates?.issued, "2026"); }
  finally { globalThis.fetch = original; }
});

test("metadata providers surface unavailable and malformed records", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("missing", { status: 404 }); await assert.rejects(lookupDoi("10.5/missing"), errorCode("PROVIDER_FAILED")); await assert.rejects(lookupArxiv("2601.00001"), errorCode("PROVIDER_FAILED"));
    globalThis.fetch = async () => new Response(JSON.stringify({ message: {} }), { status: 200 }); await assert.rejects(lookupDoi("10.5/empty"), errorCode("PROVIDER_INVALID"));
    globalThis.fetch = async () => new Response("<?xml version='1.0'?><feed></feed>", { status: 200 }); await assert.rejects(lookupArxiv("2601.00002"), errorCode("NOT_FOUND"));
  } finally { globalThis.fetch = original; }
});

test("arXiv XML is normalized while retaining DOI evidence", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(`<?xml version="1.0"?><feed xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><title>  A Preprint Title </title><published>2026-02-03T00:00:00Z</published><author><name>Grace Hopper</name></author><author><name>Alan Turing</name></author><arxiv:doi>10.7/PAPER</arxiv:doi></entry></feed>`, { status: 200 });
  try { const result = await lookupArxiv("https://arxiv.org/abs/2602.00001v3"); assert.equal(result.identifiers?.arxiv, "2602.00001"); assert.equal(result.identifiers?.doi, "10.7/paper"); assert.equal(result.citation_key, "Hopper2026a"); assert.equal(result.authors.length, 2); }
  finally { globalThis.fetch = original; }
});
