import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "./catalog.js";
import { importFile, stageImport } from "./imports.js";
import { decideReview } from "./reviews.js";
import { toCsv, toBibtex } from "./exports.js";
import { nativeExport, parseNative } from "./native.js";

test("abstracts survive storage, interchange, and reviewed refresh without source erasure", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-abstract-"));
  try {
    const c = new Catalog({ root }); await c.initialize();
    const abstract = 'First paragraph, with α.\n\nSecond paragraph.';
    const p = await c.add({ citation_key: "abstract", type: "journal", title: "Abstract Test", authors: [{ name: "Ada Lovelace" }], abstract });
    assert.equal((await c.get(p.id)).abstract, abstract);
    assert.equal(parseNative(nativeExport(await c.read(), [p.id])).publications[0]?.abstract, abstract);
    for (const [ext, content] of [["csv", toCsv([p])], ["bib", toBibtex([p])], ["json", JSON.stringify(p)]]) {
      const path = join(root, `roundtrip.${ext}`); await writeFile(path, content!);
      const result = await importFile(c, path);
      const review = (await c.read()).reviews.find(r => r.id === result.source_review_id)!;
      assert.equal(review.proposals.some(x => x.path === "/abstract"), false, ext);
      assert.equal(result.matched, 1, ext);
    }
    const next = { citation_key: p.citation_key, type: p.type, title: p.title, authors: p.authors, abstract: "Revised abstract" };
    const staged = await stageImport(c, [next], "test", next);
    assert.equal((await c.get(p.id)).abstract, abstract);
    await decideReview(c, staged.source_review_id, "accepted");
    assert.equal((await c.get(p.id)).abstract, next.abstract);
    const { abstract: omitted, ...missing } = next;
    const refresh = await stageImport(c, [missing], "test", missing);
    await decideReview(c, refresh.source_review_id, "accepted");
    assert.equal((await c.get(p.id)).abstract, next.abstract);
    for (const invalid of ["", "   ", null, 42]) await assert.rejects(c.update(p.id, { abstract: invalid as string }));
    await c.update(p.id, { abstract: "Manually edited" });
    assert.equal((await c.get(p.id)).abstract, "Manually edited");
  } finally { await rm(root, { recursive: true, force: true }); }
});
