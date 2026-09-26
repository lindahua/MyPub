import assert from "node:assert/strict";
import test from "node:test";
import { officialUrlDoi } from "./doi.js";

test("official publisher URLs expose their publication DOI", () => {
  const publication = (official_url: string, type: "conference" | "preprint" = "conference", arxiv?: string) => ({ type, official_url, identifiers: { ...(arxiv ? { arxiv } : {}) } });
  assert.equal(officialUrlDoi(publication("https://dl.acm.org/doi/10.1145/123.456")), "10.1145/123.456");
  assert.equal(officialUrlDoi(publication("https://link.springer.com/chapter/10.1007/978-3-030-58601-0_45")), "10.1007/978-3-030-58601-0_45");
  assert.equal(officialUrlDoi(publication("https://doi.org/10.1109/ABC.2026.1")), "10.1109/abc.2026.1");
  assert.equal(officialUrlDoi(publication("https://arxiv.org/abs/2609.05141v2", "preprint", "2609.05141")), "10.48550/arxiv.2609.05141");
  assert.equal(officialUrlDoi(publication("https://arxiv.org/abs/2609.05141", "preprint", "2609.99999")), undefined);
  assert.equal(officialUrlDoi(publication("https://example.org/doi/10.1234/5678")), undefined);
});
