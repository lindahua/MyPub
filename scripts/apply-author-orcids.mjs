#!/usr/bin/env node
// Apply repeated, exact DOI/byline Crossref ORCID evidence with an accepted catalog review.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Catalog, touch } from "../dist/core/catalog.js";
import { fingerprint, now, uuid } from "../dist/core/utils.js";

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); if (at < 0) return undefined; const value = args[at + 1]; if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`); args.splice(at, 2); return value; };
const root = resolve(option("--root") ?? `${process.env.HOME}/Data/MyPubRepo`);
const input = resolve(option("--input") ?? "local/author-profiles/crossref-orcid-candidates.json");
const apply = args.includes("--apply");
if (args.some(value => value !== "--apply")) throw new Error(`Unknown argument: ${args.join(" ")}`);
const source = JSON.parse(await readFile(input, "utf8"));
const catalog = new Catalog({ root });
const state = await catalog.read();
const authors = new Map(state.authors.map(author => [author.id, author]));
const claims = new Map();
for (const author of state.authors.filter(author => !author.merged_into)) {
  for (const value of [author.identifiers.orcid, ...(author.identifier_aliases ?? []).filter(alias => alias.provider === "orcid").map(alias => alias.value)]) if (value) claims.set(value, author.id);
}
const byAuthor = new Map();
const byOrcid = new Map();
for (const candidate of source.candidates) {
  const author = authors.get(candidate.author_id);
  if (!author || author.merged_into || author.archived_at || author.identifiers.orcid) continue;
  const orcidVerified = candidate.status === "verified" && candidate.name_matches && candidate.matching_orcid_works?.length > 0;
  if (candidate.candidate_provider === "openalex" && !orcidVerified) continue;
  if ((!orcidVerified && candidate.evidence_count < 2) || candidate.same_name_ids.length !== 1) continue;
  if (state.authors.filter(other => !other.merged_into && other.preferred_name.normalize("NFKC").toLowerCase() === author.preferred_name.normalize("NFKC").toLowerCase()).length !== 1) continue;
  if (candidate.works.some(work => !work.doi || !work.publication_id || !work.source_url)) continue;
  if (!orcidVerified && new Set(candidate.works.map(work => work.doi)).size < 2) continue;
  if (orcidVerified && !candidate.matching_orcid_works.some(work => candidate.works.some(source => source.doi === work.doi))) continue;
  if (candidate.works.some(work => {
    const publication = state.publications.find(item => item.id === work.publication_id);
    const credit = publication?.authors[work.position - 1];
    return !publication || publication.identifiers.doi?.toLowerCase() !== work.doi || publication.title !== work.title || credit?.author_id !== author.id || credit.name !== work.credited_name;
  })) continue;
  const other = claims.get(candidate.orcid);
  if (other && other !== author.id) continue;
  byAuthor.set(author.id, [...(byAuthor.get(author.id) ?? []), candidate]);
  byOrcid.set(candidate.orcid, [...(byOrcid.get(candidate.orcid) ?? []), candidate]);
}
const accepted = [...byAuthor.values()].filter(group => group.length === 1).flat().filter(candidate => byOrcid.get(candidate.orcid).length === 1);
console.log(JSON.stringify({ mode: apply ? "apply" : "preview", candidates: accepted.map(candidate => ({ author_key: candidate.author_key, orcid: candidate.orcid, doi_count: candidate.evidence_count })) }, null, 2));
if (!apply || !accepted.length) process.exit(0);
const result = await catalog.change(state => {
  const saved = [];
  for (const candidate of accepted) {
    const author = state.authors.find(value => value.id === candidate.author_id);
    if (!author || author.identifiers.orcid || author.merged_into || author.archived_at) throw new Error(`Author changed: ${candidate.author_key}`);
    if (state.authors.some(other => other.id !== author.id && !other.merged_into && (other.identifiers.orcid === candidate.orcid || other.identifier_aliases?.some(alias => alias.provider === "orcid" && alias.value === candidate.orcid)))) throw new Error(`ORCID already claimed: ${candidate.orcid}`);
    const revision = fingerprint(author);
    author.identifiers.orcid = candidate.orcid;
    touch(author);
    const time = now();
    const payload = { author_id: author.id, orcid: candidate.orcid, works: candidate.works, ...(candidate.matching_orcid_works ? { matching_orcid_works: candidate.matching_orcid_works, orcid_names: candidate.orcid_names } : {}), ...(candidate.candidate_provider ? { candidate_provider: candidate.candidate_provider } : {}) };
    const reason = candidate.candidate_provider === "openalex" ? `Exact arXiv DOI/title/byline match in OpenAlex corroborated by the public ORCID name and DOI work listing.` : candidate.status === "verified" ? `Exact publisher DOI/byline match corroborated by the public ORCID name and DOI work listing.` : `Exact title, author name and byline position on ${candidate.evidence_count} distinct publisher DOI records.`;
    const review = {
      schema_version: 2, id: uuid(), summary: `Confirm ORCID for ${author.preferred_name}`,
      kind: "identity", state: "accepted", targets: [{ entity_type: "author", entity_id: author.id }],
      evidence: { provider: candidate.candidate_provider === "openalex" ? "openalex+orcid" : candidate.status === "verified" ? "crossref+orcid" : "crossref", captured_at: time, payload, completeness: "complete", parser_version: candidate.candidate_provider === "openalex" ? "mypub-openalex-orcid-public-record/1" : candidate.status === "verified" ? "mypub-crossref-orcid-public-record/1" : "mypub-crossref-orcid/1", input_fingerprint: fingerprint(payload) },
      proposals: [{ id: uuid(), target: { entity_type: "author", entity_id: author.id }, operation: "replace", path: "/identifiers/orcid", expected_revision: revision, proposed: candidate.orcid, state: "accepted", decided_at: time, decision_note: reason }],
      decision_note: reason,
      decided_at: time, created_at: time, updated_at: time,
    };
    state.reviews.push(review);
    saved.push({ author_key: author.author_key, orcid: candidate.orcid, review_id: review.id });
  }
  return saved;
});
console.log(JSON.stringify({ applied: result }, null, 2));
