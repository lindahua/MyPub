#!/usr/bin/env node
// Apply individually verified author-controlled Scholar links with review evidence.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Catalog, touch } from "../dist/core/catalog.js";
import { fingerprint, now, uuid } from "../dist/core/utils.js";

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); if (at < 0) return undefined; const value = args[at + 1]; if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`); args.splice(at, 2); return value; };
const root = resolve(option("--root") ?? `${process.env.HOME}/Data/MyPubRepo`);
const input = resolve(option("--input") ?? "local/author-profiles/scholar-confirmed.json");
const apply = args.includes("--apply");
if (args.some(value => value !== "--apply")) throw new Error(`Unknown argument: ${args.join(" ")}`);
const entries = JSON.parse(await readFile(input, "utf8"));
const catalog = new Catalog({ root });
const state = await catalog.read();
const accepted = [];
const claimed = new Map(state.authors.filter(author => !author.merged_into).flatMap(author => author.identifiers.google_scholar ? [[author.identifiers.google_scholar, author.id]] : []));
for (const entry of entries) {
  const author = state.authors.find(item => item.author_key === entry.author_key);
  if (!author || author.merged_into || author.archived_at) throw new Error(`Author unavailable: ${entry.author_key}`);
  if (author.identifiers.google_scholar === entry.scholar_id) continue;
  if (author.identifiers.google_scholar) throw new Error(`Conflicting Scholar ID: ${entry.author_key}`);
  const profile = new URL(entry.profile_url);
  if (!/^scholar\.google\.[\w.]+$/.test(profile.hostname) || profile.pathname !== "/citations" || profile.searchParams.get("user") !== entry.scholar_id) throw new Error(`Invalid Scholar URL: ${entry.author_key}`);
  if (claimed.has(entry.scholar_id)) throw new Error(`Scholar ID already assigned: ${entry.scholar_id}`);
  if (!entry.homepage_url || !entry.publication_ids?.length || !entry.reason) throw new Error(`Incomplete evidence: ${entry.author_key}`);
  if (entry.evidence_provider && !["author-homepage", "institutional-profile", "coauthor-project", "coauthor-homepage"].includes(entry.evidence_provider)) throw new Error(`Invalid evidence provider: ${entry.author_key}`);
  if (Boolean(entry.scholar_profile_name) !== Boolean(entry.scholar_matched_title)) throw new Error(`Incomplete Scholar profile evidence: ${entry.author_key}`);
  for (const publicationId of entry.publication_ids) if (!state.publications.some(item => item.id === publicationId && item.authors.some(credit => credit.author_id === author.id))) throw new Error(`Publication evidence does not link author: ${entry.author_key}`);
  claimed.set(entry.scholar_id, author.id);
  accepted.push(entry);
}
console.log(JSON.stringify({ mode: apply ? "apply" : "preview", candidates: accepted.map(entry => ({ author_key: entry.author_key, scholar_id: entry.scholar_id })) }, null, 2));
if (!apply || !accepted.length) process.exit(0);
const saved = await catalog.change(state => accepted.map(entry => {
  const author = state.authors.find(item => item.author_key === entry.author_key);
  if (!author || author.identifiers.google_scholar) throw new Error(`Author changed: ${entry.author_key}`);
  const revision = fingerprint(author);
  author.identifiers.google_scholar = entry.scholar_id;
  touch(author);
  const time = now();
  const payload = { author_id: author.id, scholar_id: entry.scholar_id, profile_url: entry.profile_url, homepage_url: entry.homepage_url, publication_ids: entry.publication_ids, scholar_profile_name: entry.scholar_profile_name, scholar_matched_title: entry.scholar_matched_title, reason: entry.reason };
  const review = {
    schema_version: 2, id: uuid(), summary: `Confirm Google Scholar profile for ${author.preferred_name}`,
    kind: "identity", state: "accepted", targets: [{ entity_type: "author", entity_id: author.id }],
    evidence: { provider: entry.evidence_provider ?? "author-homepage", captured_at: time, source_reference: entry.homepage_url, payload, completeness: "complete", parser_version: "mypub-author-scholar/1", input_fingerprint: fingerprint(payload) },
    proposals: [{ id: uuid(), target: { entity_type: "author", entity_id: author.id }, operation: "replace", path: "/identifiers/google_scholar", expected_revision: revision, proposed: entry.scholar_id, state: "accepted", decided_at: time, decision_note: entry.reason }],
    decision_note: entry.reason, decided_at: time, created_at: time, updated_at: time,
  };
  state.reviews.push(review);
  return { author_key: author.author_key, scholar_id: entry.scholar_id, review_id: review.id };
}));
console.log(JSON.stringify({ applied: saved }, null, 2));
