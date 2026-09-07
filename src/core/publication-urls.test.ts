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

test("publication URL roles and extra links persist through interchange and reviewed refresh", async () => {
 const root=await mkdtemp(join(tmpdir(),"mypub-publication-urls-"));
 try {
  const c=new Catalog({root});await c.initialize();
  const input={citation_key:"links",type:"journal" as const,title:"Links",authors:[{name:"Ada Lovelace"}],official_url:"https://example.org/article",paper_url:"https://example.org/download?id=1",extra_urls:["https://example.org/code","https://example.org/data"]};
  const p=await c.add(input);
  assert.equal((await c.get(p.id)).paper_url,input.paper_url);
  assert.deepEqual(parseNative(nativeExport(await c.read(),[p.id])).publications[0]?.extra_urls,input.extra_urls);
  for(const [ext,content] of [["csv",toCsv([p])],["bib",toBibtex([p])],["json",JSON.stringify(p)]]) {
   const path=join(root,`paper.${ext}`);await writeFile(path,content!);const result=await importFile(c,path);
   const review=(await c.read()).reviews.find(r=>r.id===result.source_review_id)!;
   assert.equal(result.matched,1);assert.deepEqual(review.proposals,[],ext);
  }
  const {official_url,paper_url,extra_urls,...missing}=input;
  const result=await stageImport(c,[missing],"test",missing);await decideReview(c,result.source_review_id,"accepted");
  const retained=await c.get(p.id);assert.equal(retained.official_url,official_url);assert.equal(retained.paper_url,paper_url);assert.deepEqual(retained.extra_urls,extra_urls);
  await assert.rejects(c.update(p.id,{official_url:"relative"}));
  await assert.rejects(c.update(p.id,{paper_url:""}));
  await assert.rejects(c.update(p.id,{extra_urls:[extra_urls[0]!,extra_urls[0]!]}));
  await assert.rejects(c.update(p.id,{urls:[]} as never));
 } finally {await rm(root,{recursive:true,force:true});}
});
