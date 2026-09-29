#!/usr/bin/env node
// Apply manually reviewed ORCID records with exact catalog work overlap.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Catalog, touch } from "../dist/core/catalog.js";
import { fingerprint, now, uuid } from "../dist/core/utils.js";

const args = process.argv.slice(2);
const option = name => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  args.splice(at, 2);
  return value;
};
const root = resolve(option("--root") ?? `${process.env.HOME}/Data/MyPubRepo`);
const input = resolve(option("--input") ?? "local/author-profiles/orcid-review-batch-1.json");
const cache = resolve(option("--cache") ?? "local/author-profiles/orcid");
const apply = args.includes("--apply");
if (args.some(value => value !== "--apply")) throw new Error(`Unknown argument: ${args.join(" ")}`);
const entries = JSON.parse(await readFile(input, "utf8"));
const catalog = new Catalog({ root });
const state = await catalog.read();
const normalName = value => value.normalize("NFKC").toLocaleLowerCase("und").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const accepted = [];
const claimed = new Map();
for (const author of state.authors.filter(item => !item.merged_into)) {
  for (const value of [author.identifiers.orcid, ...(author.identifier_aliases ?? []).filter(alias => alias.provider === "orcid").map(alias => alias.value)]) {
    if (value) claimed.set(value, author.id);
  }
}
for (const entry of entries) {
  if (!/^\d{4}-\d{4}-\d{4}-[\dX]{4}$/.test(entry.orcid)) throw new Error(`Bad ORCID: ${entry.orcid}`);
  const author = state.authors.find(item => item.author_key === entry.author_key);
  if (!author || author.merged_into || author.archived_at) throw new Error(`Author unavailable: ${entry.author_key}`);
  if (author.identifiers.orcid === entry.orcid) continue;
  if (author.identifiers.orcid || claimed.has(entry.orcid)) throw new Error(`Conflicting ORCID: ${entry.author_key}`);
  if (state.authors.filter(item => !item.merged_into && normalName(item.preferred_name) === normalName(author.preferred_name)).length !== 1) throw new Error(`Same-name author needs separate identity review: ${entry.author_key}`);
  if (!entry.reason || !Array.isArray(entry.matched_dois) || entry.matched_dois.length < 2) throw new Error(`Incomplete evidence: ${entry.author_key}`);
  const record = JSON.parse(await readFile(resolve(cache, `${entry.orcid}.json`), "utf8"));
  if (record["orcid-identifier"]?.path !== entry.orcid) throw new Error(`ORCID record mismatch: ${entry.author_key}`);
  const name = record.person?.name ?? {};
  const orcidName = [(name["given-names"]?.value ?? ""), (name["family-name"]?.value ?? "")].filter(Boolean).join(" ");
  if (normalName(orcidName) !== normalName(author.preferred_name)) throw new Error(`ORCID name mismatch: ${entry.author_key}`);
  const evidence = [];
  for (const doi of entry.matched_dois) {
    const target = doi.toLowerCase();
    const publications = state.publications.filter(item => item.identifiers.doi?.toLowerCase() === target && item.authors.some(credit => credit.author_id === author.id));
    if (publications.length !== 1) throw new Error(`Catalog work mismatch: ${entry.author_key} ${doi}`);
    const group = (record["activities-summary"]?.works?.group ?? []).find(item => (item["external-ids"]?.["external-id"] ?? []).some(external => {
      const type = external["external-id-type"]?.toLowerCase();
      const value = external["external-id-value"]?.toLowerCase();
      if (type === "doi") return value?.replace(/^https:\/\/doi\.org\//, "") === target;
      if (type === "arxiv") {
        const arxiv = value?.match(/\d{4}\.\d{4,5}/)?.[0];
        return arxiv && `10.48550/arxiv.${arxiv}` === target;
      }
      return false;
    }));
    if (!group) throw new Error(`Public ORCID work mismatch: ${entry.author_key} ${doi}`);
    evidence.push({ publication_id: publications[0].id, doi: target, title: publications[0].title, orcid_work_titles: (group["work-summary"] ?? []).map(summary => summary.title?.title?.value).filter(Boolean), publication_url: `https://doi.org/${doi}` });
  }
  if (new Set(evidence.map(item => item.doi)).size !== evidence.length) throw new Error(`Duplicate work evidence: ${entry.author_key}`);
  claimed.set(entry.orcid, author.id);
  accepted.push({ entry, author, expectedRevision: fingerprint(author), orcidName, evidence });
}
console.log(JSON.stringify({ mode: apply ? "apply" : "preview", candidates: accepted.map(({ entry, evidence }) => ({ author_key: entry.author_key, orcid: entry.orcid, matched_works: evidence.length })) }, null, 2));
if (!apply || !accepted.length) process.exit(0);
const saved = await catalog.change(state => accepted.map(({ entry, expectedRevision, orcidName, evidence }) => {
  const author = state.authors.find(item => item.author_key === entry.author_key);
  if (!author || fingerprint(author) !== expectedRevision) throw new Error(`Author changed: ${entry.author_key}`);
  if (state.authors.some(other => other.id !== author.id && !other.merged_into && (other.identifiers.orcid === entry.orcid || other.identifier_aliases?.some(alias => alias.provider === "orcid" && alias.value === entry.orcid)))) throw new Error(`ORCID claimed: ${entry.orcid}`);
  for (const work of evidence) {
    const publication = state.publications.find(item => item.id === work.publication_id);
    if (!publication || publication.identifiers.doi?.toLowerCase() !== work.doi || !publication.authors.some(credit => credit.author_id === author.id)) throw new Error(`Catalog work changed: ${entry.author_key} ${work.doi}`);
  }
  const revision = fingerprint(author);
  author.identifiers.orcid = entry.orcid;
  touch(author);
  const time = now();
  const payload = { author_id: author.id, orcid: entry.orcid, orcid_name: orcidName, matched_works: evidence, reason: entry.reason };
  const review = {
    schema_version: 2, id: uuid(), summary: `Confirm ORCID for ${author.preferred_name}`,
    kind: "identity", state: "accepted", targets: [{ entity_type: "author", entity_id: author.id }],
    evidence: { provider: "orcid-public-record", captured_at: time, source_reference: `https://orcid.org/${entry.orcid}`, payload, completeness: "complete", parser_version: "mypub-reviewed-orcid-public-record/1", input_fingerprint: fingerprint(payload) },
    proposals: [{ id: uuid(), target: { entity_type: "author", entity_id: author.id }, operation: "replace", path: "/identifiers/orcid", expected_revision: revision, proposed: entry.orcid, state: "accepted", decided_at: time, decision_note: entry.reason }],
    decision_note: entry.reason, decided_at: time, created_at: time, updated_at: time,
  };
  state.reviews.push(review);
  return { author_key: entry.author_key, orcid: entry.orcid, review_id: review.id };
}));
console.log(JSON.stringify({ applied: saved }, null, 2));
