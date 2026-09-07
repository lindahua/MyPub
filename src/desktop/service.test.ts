import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Catalog } from "../core/catalog.js";
import { LibraryService, relevantChange } from "./service.js";
import type { DesktopState } from "./types.js";
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "mypub-desktop-"));
  const catalog = new Catalog({ root });
  await catalog.initialize("Desktop test");
  const paper = await catalog.add({
    citation_key: "one",
    title: "Original",
    type: "journal",
    authors: [],
    publication_date: "2024",
  });
  const events: DesktopState[] = [];
  const service = new LibraryService(root, (e) => events.push(e), 100);
  t.after(async () => {
    service.stop();
    await delay(300);
    await rm(root, { recursive: true, force: true });
  });
  await service.start();
  return { root, catalog, paper, service, events };
}
async function until(condition: () => boolean) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 6000)
      throw new Error("Timed out waiting for refresh");
    await delay(40);
  }
}
test("watches canonical edits, database replacement/deletion, and recovers from invalid JSON", async (t) => {
  const { root, catalog, paper, service } = await setup(t);
  const path = join(root, service.state.snapshot!.paths[paper.id]!);
  const json = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...json, title: "External edit" }));
  await until(
    () =>
      service.state.snapshot?.state.publications[0]?.title === "External edit",
  );
  const valid = await readFile(path, "utf8");
  await writeFile(path, "{");
  await until(() => service.state.status === "stale");
  assert.equal(
    service.state.snapshot?.state.publications[0]?.title,
    "External edit",
  );
  assert.match(service.state.error!, /JSON|SCHEMA|INVALID/i);
  await writeFile(path, valid);
  await until(() => service.state.status === "current");
  const renamed = path.replace(".json", "_renamed.json");
  await rename(path, renamed);
  await until(
    () =>
      service.state.snapshot?.paths[paper.id]?.endsWith("_renamed.json") ===
      true,
  );
  await catalog.rebuildIndex();
  await rm(join(root, "local/index.sqlite"));
  await until(() => service.state.status === "current");
  await service.refresh();
  assert.ok((await readFile(join(root, "local/index.sqlite"))).length > 0);
});
test("lock retry retains current snapshot and resolves without another edit", async (t) => {
  const { root, service } = await setup(t);
  const lock = join(root, "local/write.lock");
  service.setActive(false);
  await writeFile(lock, `${process.pid} test`);
  await service.refresh();
  assert.equal(service.state.status, "waiting");
  assert.ok(service.state.snapshot);
  await rm(lock);
  await until(() => service.state.status === "current");
});
test("wrong folders are never initialized and no watcher loop follows local outputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mypub-not-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LibraryService(root, () => {});
  await service.start();
  service.stop();
  assert.equal(service.state.status, "stale");
  await assert.rejects(readFile(join(root, "catalog/library.json")));
  assert.equal(relevantChange("local/write.lock"), false);
  assert.equal(relevantChange("local/index-abc.sqlite.tmp"), false);
  assert.equal(relevantChange("local/index.sqlite"), true);
  assert.equal(relevantChange("catalog/publications/2025/x.json"), true);
});
test("file opening rejects LFS pointers, missing binaries and escaping symlinks; citations use the core exporter", async (t) => {
  const { root, catalog, paper, service } = await setup(t);
  const source = join(root, "source.pdf");
  await writeFile(source, "%PDF test");
  const a = await catalog.addAttachment(paper.id, source, "paper");
  const library = (await catalog.library()).id;
  await service.refresh();
  assert.equal(service.state.snapshot?.availability[a.id], "local");
  assert.match(
    await service.action("citation", library, paper.id),
    /@article\{one/,
  );
  assert.ok(
    (await service.action("attachment", library, paper.id, a.id)).endsWith(
      "source.pdf",
    ),
  );
  await writeFile(
    join(root, a.path),
    "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 9\n",
  );
  await service.refresh();
  assert.equal(service.state.snapshot?.availability[a.id], "not-downloaded");
  await assert.rejects(
    service.action("attachment", library, paper.id, a.id),
    /not available/,
  );
  await rm(join(root, a.path));
  await symlink("/etc/hosts", join(root, a.path));
  await service.refresh();
  assert.equal(service.state.snapshot?.availability[a.id], "error");
  await assert.rejects(service.action("attachment", library, paper.id, a.id));
  await assert.rejects(
    service.action("citation", "different", paper.id),
    /library changed/,
  );
});
