import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Catalog } from "./catalog.js";
import { commit, initializeGit } from "./sync.js";
import { run } from "../adapters/process.js";

const make = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const root = await mkdtemp(join(tmpdir(), "mypub-paper-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = new Catalog({ root });
  await c.initialize();
  return { c, root };
};

test("a main PDF uses the publication year, title stem and UUID suffix and follows metadata edits", async (t) => {
  const { c, root } = await make(t);
  const p = await c.add({
    citation_key: "main",
    title: "Café & Vision!",
    type: "conference",
    publication_date: "2025",
    authors: [],
  });
  const input = join(root, "source.pdf");
  await writeFile(input, "%PDF example bytes");
  const a = await c.addAttachment(p.id, input, "paper", "Publisher PDF", true);
  assert.equal(
    a.path,
    `catalog/paper_files/2025/café_vision_${p.id.replaceAll("-", "").slice(0, 8)}.pdf`,
  );
  assert.match(
    await readFile(join(root, ".gitattributes"), "utf8"),
    /catalog\/paper_files\/\*\* filter=lfs/,
  );
  assert.equal((await c.validate()).valid, true);
  const previous = a.path;
  const changed = await c.update(p.id, {
    title: "Revised Café & Vision",
    publication_date: "2026",
  });
  const next = changed.attachments[0]!;
  assert.equal(
    next.path,
    `catalog/paper_files/2026/revised_café_vision_${p.id.replaceAll("-", "").slice(0, 8)}.pdf`,
  );
  assert.equal(
    await readFile(join(root, next.path), "utf8"),
    "%PDF example bytes",
  );
  await assert.rejects(readFile(join(root, previous)));
  assert.equal((await c.validate()).valid, true);
});

test("non-paper and additional paper attachments keep their distinct UUID paths", async (t) => {
  const { c, root } = await make(t);
  const p = await c.add({
    citation_key: "several",
    title: "Several",
    type: "journal",
    authors: [],
  });
  const pdf1 = join(root, "first.pdf"),
    pdf2 = join(root, "second.pdf"),
    video = join(root, "video.mp4");
  await writeFile(pdf1, "%PDF first");
  await writeFile(pdf2, "%PDF second");
  await writeFile(video, "video");
  const first = await c.addAttachment(p.id, pdf1, "paper");
  const second = await c.addAttachment(p.id, pdf2, "paper");
  const third = await c.addAttachment(p.id, video, "video");
  assert.match(
    first.path,
    /^catalog\/paper_files\/unknown_year\/several_[a-f0-9]+\.pdf$/,
  );
  assert.match(second.path, /^attachments\//);
  assert.match(third.path, /^attachments\//);
  assert.equal((await c.validate()).valid, true);
});

test("a metadata rename preserves an LFS pointer without downloading the PDF", async (t) => {
  const { c, root } = await make(t);
  const p = await c.add({
    citation_key: "pointer",
    title: "Pointer",
    type: "journal",
    authors: [],
  });
  const input = join(root, "source.pdf");
  await writeFile(input, "%PDF pointer fixture");
  const a = await c.addAttachment(p.id, input, "paper");
  await initializeGit(c);
  await run("git", ["config", "user.name", "MyPub Tests"], root);
  await run("git", ["config", "user.email", "tests@example.invalid"], root);
  assert.equal((await commit(c)).state, "committed");
  const pointer = (await run("git", ["show", `HEAD:${a.path}`], root)).stdout;
  assert.match(pointer, /^version https:\/\/git-lfs.github.com\/spec\/v1/);
  await writeFile(join(root, a.path), pointer);
  const updated = await c.update(p.id, { title: "Pointer Renamed" });
  assert.equal(
    await readFile(join(root, updated.attachments[0]!.path), "utf8"),
    pointer,
  );
  assert.equal((await commit(c)).state, "committed");
  assert.equal(
    (await run("git", ["show", `HEAD:${updated.attachments[0]!.path}`], root))
      .stdout,
    pointer,
  );
  assert.equal((await c.validate(false)).valid, true);
});

test("paper-file PDFs survive backup and restore without an attachments directory", async (t) => {
  const { c, root } = await make(t);
  const { backup, restore } = await import("./backup.js");
  const p = await c.add({
    citation_key: "backup",
    title: "Backup PDF",
    type: "journal",
    authors: [],
  });
  const input = join(root, "source.pdf");
  await writeFile(input, "%PDF backup data");
  const a = await c.addAttachment(p.id, input, "paper");
  const bundle = join(root, "..", `${p.id}-backup`),
    restoredRoot = join(root, "..", `${p.id}-restored`);
  t.after(() => rm(bundle, { recursive: true, force: true }));
  t.after(() => rm(restoredRoot, { recursive: true, force: true }));
  await backup(c, bundle, true);
  const restored = new Catalog({ root: restoredRoot });
  await restore(restored, bundle);
  assert.equal(
    await readFile(join(restoredRoot, a.path), "utf8"),
    "%PDF backup data",
  );
  assert.equal((await restored.validate()).valid, true);
});

test("a remote clone validates a paper-file LFS pointer during sync", async (t) => {
  const { c, root } = await make(t);
  const p = await c.add({
    citation_key: "remote",
    title: "Remote PDF",
    type: "journal",
    authors: [],
  });
  const input = join(root, "source.pdf");
  await writeFile(input, "%PDF remote data");
  const a = await c.addAttachment(p.id, input, "paper");
  await initializeGit(c);
  await run("git", ["config", "user.name", "MyPub Tests"], root);
  await run("git", ["config", "user.email", "tests@example.invalid"], root);
  await commit(c);
  const remote = join(root, "..", `${p.id}-remote.git`),
    clone = join(root, "..", `${p.id}-clone`);
  t.after(() => rm(remote, { recursive: true, force: true }));
  t.after(() => rm(clone, { recursive: true, force: true }));
  await run("git", ["init", "--bare", "--initial-branch=main", remote], root);
  await run("git", ["remote", "add", "origin", remote], root);
  await run("git", ["push", "-u", "origin", "main"], root);
  await run("git", ["clone", remote, clone], root);
  const other = new Catalog({ root: clone });
  assert.equal((await other.get(p.id)).attachments[0]?.path, a.path);
  await c.update(p.id, { title: "Remote PDF Revised" });
  await commit(c);
  await run("git", ["push"], root);
  const { sync } = await import("./sync.js");
  assert.equal((await sync(other)).state, "pulled");
  assert.match(
    (await other.get(p.id)).attachments[0]!.path,
    /remote_pdf_revised/,
  );
  assert.equal((await other.validate(false)).valid, true);
});

test("sync reconciles an independently added PDF with a renamed publication", async (t) => {
  const { c, root } = await make(t);
  const { sync } = await import("./sync.js");
  const p = await c.add({
    citation_key: "merged",
    title: "Original Paper",
    type: "journal",
    authors: [],
  });
  await initializeGit(c);
  await run("git", ["config", "user.name", "MyPub Tests"], root);
  await run("git", ["config", "user.email", "tests@example.invalid"], root);
  await commit(c);
  const remote = join(root, "..", `${p.id}-merge.git`),
    clone = join(root, "..", `${p.id}-merge-clone`);
  t.after(() => rm(remote, { recursive: true, force: true }));
  t.after(() => rm(clone, { recursive: true, force: true }));
  await run("git", ["init", "--bare", "--initial-branch=main", remote], root);
  await run("git", ["remote", "add", "origin", remote], root);
  await run("git", ["push", "-u", "origin", "main"], root);
  await run("git", ["clone", remote, clone], root);
  await run("git", ["config", "user.name", "MyPub Tests"], clone);
  await run("git", ["config", "user.email", "tests@example.invalid"], clone);
  const other = new Catalog({ root: clone });
  const input = join(root, "..", `${p.id}-source.pdf`);
  t.after(() => rm(input, { force: true }));
  await writeFile(input, "%PDF independently added");
  await c.addAttachment(p.id, input, "paper");
  await commit(c);
  await sync(c);
  await other.update(p.id, { title: "Renamed Paper" });
  await commit(other);
  const result = await sync(other);
  assert.equal(result.state, "merged");
  const updated = await other.get(p.id);
  assert.match(
    updated.attachments[0]!.path,
    /^catalog\/paper_files\/unknown_year\/renamed_paper_/,
  );
  assert.equal((await other.validate(false)).valid, true);
});

test("colliding publication UUID prefixes extend both PDF filenames without losing bytes", async (t) => {
  const { c, root } = await make(t);
  const first = await c.add({
    id: "12345678-1111-4111-8111-111111111111",
    citation_key: "first-collision",
    title: "Same Title",
    publication_date: "2025",
    type: "journal",
    authors: [],
  });
  const source = join(root, "first.pdf");
  await writeFile(source, "%PDF first collision");
  const original = await c.addAttachment(first.id, source, "paper");
  const second = await c.add({
    id: "12345678-2222-4222-8222-222222222222",
    citation_key: "second-collision",
    title: "Same Title",
    publication_date: "2025",
    type: "journal",
    authors: [],
  });
  const moved = (await c.get(first.id)).attachments[0]!;
  assert.notEqual(moved.path, original.path);
  assert.match(moved.path, /same_title_123456781111\.pdf$/);
  assert.equal(
    await readFile(join(root, moved.path), "utf8"),
    "%PDF first collision",
  );
  const otherSource = join(root, "second.pdf");
  await writeFile(otherSource, "%PDF second collision");
  const other = await c.addAttachment(second.id, otherSource, "paper");
  assert.match(other.path, /same_title_123456782222\.pdf$/);
  assert.equal((await c.validate()).valid, true);
});
