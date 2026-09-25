import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Catalog } from "./catalog.js";

test("catalog To-Do items persist, link to publications, and can be completed and reopened", async t => {
  const root = await mkdtemp(join(tmpdir(), "mypub-todos-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = new Catalog({ root });
  await catalog.initialize();
  const publication = await catalog.add({ citation_key: "todo-test", type: "journal", title: "Early access paper", authors: [] });
  const item = await catalog.addTodo("Check final issue and PDF", publication.id);
  assert.equal(item.publication_id, publication.id);
  assert.equal((await catalog.snapshot()).state.todos[0]?.title, item.title);
  const path = (await catalog.snapshot()).paths[item.id]!;
  assert.match(path, /^catalog\/todos\//);
  assert.equal(JSON.parse(await readFile(join(root, path), "utf8")).id, item.id);
  assert.ok((await catalog.setTodoCompleted(item.id, true)).completed_at);
  assert.ok((await catalog.read()).todos[0]?.completed_at);
  assert.equal((await catalog.setTodoCompleted(item.id, false)).completed_at, undefined);
  assert.equal((await catalog.read()).todos[0]?.completed_at, undefined);
  await assert.rejects(catalog.addTodo("Bad reference", "00000000-0000-4000-8000-000000000000"));
  assert.equal((await catalog.read()).todos.length, 1);
});
