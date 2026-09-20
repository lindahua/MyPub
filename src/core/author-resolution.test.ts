import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Catalog } from "./catalog.js";
import { addAuthor, unlinkCredit } from "./identities.js";
import { stageImport } from "./imports.js";
import { decideReview } from "./reviews.js";
import { fingerprint } from "./utils.js";

test("name resolution creates, reuses and preserves identities with review history", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-name-")), c = new Catalog({ root });
  try {
    await c.initialize();
    const a = await addAuthor(c, { author_key: "ada", preferred_name: "Ada Lovelace", aliases: ["A. Lovelace"] });
    const p = await c.add({ citation_key: "one", type: "other", title: "One", authors: [{ name: " A.  LOVELACE " }, { name: "New Person", roles: ["corresponding"] }] });
    assert.equal(p.authors[0]!.author_id, a.id);
    assert.ok(p.authors[1]!.author_id);
    const q = await c.add({ citation_key: "two", type: "other", title: "Two", authors: [{ name: "New Person" }] });
    assert.equal(q.authors[0]!.author_id, p.authors[1]!.author_id);
    await unlinkCredit(c, q.id, 1, fingerprint(q));
    assert.equal((await c.get(q.id)).authors[0]!.author_id, undefined);
    assert.deepEqual(await c.resolveAuthors(), { linked: 1, created: 0, unresolved: 0 });
    const before = await c.read();
    assert.deepEqual(await c.resolveAuthors(), { linked: 0, created: 0, unresolved: 0 });
    assert.equal((await c.read()).reviews.length, before.reviews.length);
    assert.equal(before.authors.find(x => x.id === p.authors[1]!.author_id)!.name_parts, undefined);
    assert.equal((await c.validate(false)).valid, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ambiguous names, repeated bylines and archived identities are handled safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-name-")), c = new Catalog({ root });
  try {
    await c.initialize();
    await addAuthor(c, { author_key: "sam1", preferred_name: "Sam", aliases: [] });
    await addAuthor(c, { author_key: "sam2", preferred_name: "Sam", aliases: [] });
    const old = await addAuthor(c, { author_key: "old", preferred_name: "Old", archived_at: "2020-01-01T00:00:00Z" });
    const p = await c.add({ citation_key: "one", type: "other", title: "One", authors: [{ name: "Sam" }, { name: "Twice" }, { name: "Twice" }, { name: "Old" }] });
    assert.deepEqual(p.authors.slice(0, 3).map(a => a.author_id), [undefined, undefined, undefined]);
    assert.notEqual(p.authors[3]!.author_id, old.id);
    assert.equal((await c.read()).authors.length, 4);
    const active = await addAuthor(c, { author_key: "variant", preferred_name: "Full Name", aliases: ["F. Name"] });
    const variants = await c.add({ citation_key: "variants", type: "other", title: "Variants", authors: [{ name: "Full Name", author_id: active.id }, { name: "F. Name" }] });
    assert.equal(variants.authors[1]!.author_id, undefined);
    const before = await c.read();
    await assert.rejects(c.add({ citation_key: "one", type: "other", title: "Invalid duplicate key", authors: [{ name: "Must Roll Back" }] }));
    assert.deepEqual(await c.read(), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("imports resolve only on acceptance and reuse identities across a batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-name-")), c = new Catalog({ root });
  try {
    await c.initialize();
    const inputs = ["one", "two"].map(title => ({ citation_key: title, type: "other" as const, title, authors: [{ name: "New" }] }));
    const staged = await stageImport(c, inputs, "test", inputs);
    assert.equal((await c.read()).authors.length, 0);
    await decideReview(c, staged.review_ids[0]!, "accepted");
    const s = await c.read();
    assert.equal(s.authors.length, 1);
    assert.equal(s.publications[0]!.authors[0]!.author_id, s.publications[1]!.authors[0]!.author_id);
    assert.equal((await c.validate(false)).valid, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
