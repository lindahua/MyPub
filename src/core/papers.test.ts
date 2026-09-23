import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PDFDocument } from "pdf-lib";
import { Catalog } from "./catalog.js";
import {
  downloadPaper,
  downloadPapers,
  verifyDownload,
  registerDownload,
  listDownloads,
} from "./papers.js";
import { paperCandidates, paperTransport } from "../adapters/papers.js";

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "mypub-papers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = new Catalog({ root });
  await c.initialize();
  const p = await c.add({
    citation_key: "paper",
    type: "conference",
    title: "Example Paper",
    authors: [{ name: "Ada" }],
    official_url: "https://publisher.test/article",
  });
  return { c, p, root };
}
async function pdf(title?: string) {
  const doc = await PDFDocument.create();
  doc.addPage();
  if (title) doc.setTitle(title);
  return Buffer.from(await doc.save());
}
function transport(bytes: Buffer, title = "Example Paper") {
  return paperTransport({
    intervalMs: 0,
    fetch: async (url) =>
      new Response(
        String(url).endsWith("/article")
          ? `<meta name="citation_title" content="${title}"><meta name="citation_pdf_url" content="/paper">`
          : new Uint8Array(bytes),
      ),
  });
}

test("download stages only, verifies, registers atomically and retries registration", async (t) => {
  const { c, p, root } = await setup(t),
    bytes = await pdf();
  const m = await downloadPaper(c, p.id, transport(bytes));
  assert.equal((await c.get(p.id)).attachments.length, 0);
  await assert.rejects(registerDownload(c, m.id), /Verify/);
  const verified = await verifyDownload(c, m.id);
  assert.equal(verified.state, "verified");
  assert.equal(verified.verification?.pages, 1);
  const a = await registerDownload(c, m.id);
  assert.equal(a.source_url, "https://publisher.test/paper");
  assert.deepEqual(await readFile(join(root, a.path)), bytes);
  assert.equal((await c.get(p.id)).primary_attachment_id, a.id);
  assert.equal((await registerDownload(c, m.id)).id, a.id);
  await assert.rejects(
    access(join(root, "local/downloads", m.id, "paper.pdf")),
  );
  assert.equal((await c.validate()).valid, true);
});

test("uncertain PDFs need explicit acceptance and retain existing primary", async (t) => {
  const { c, p, root } = await setup(t),
    bytes = await pdf();
  const local = join(root, "slides.pdf");
  await writeFile(local, await pdf("Slides"));
  const primary = await c.addAttachment(p.id, local, "slides", undefined, true);
  await c.update(p.id, { paper_url: "https://publisher.test/paper" });
  const m = await downloadPaper(c, p.id, transport(bytes));
  assert.equal((await verifyDownload(c, m.id)).state, "needs_review");
  assert.equal(
    (await verifyDownload(c, m.id, "Inspected title and authors")).state,
    "verified",
  );
  await registerDownload(c, m.id);
  assert.equal((await c.get(p.id)).primary_attachment_id, primary.id);
});

test("staged reuse avoids network, and changed bytes cannot be registered", async (t) => {
  const { c, p, root } = await setup(t),
    bytes = await pdf();
  const m = await downloadPaper(c, p.id, transport(bytes));
  const reused = await downloadPaper(c, p.id, async () => {
    throw new Error("must not fetch");
  });
  assert.equal(m.id, reused.id);
  await verifyDownload(c, m.id);
  await writeFile(
    join(root, "local/downloads", m.id, "paper.pdf"),
    await pdf("Changed"),
  );
  await assert.rejects(registerDownload(c, m.id), /changed since download/);
  assert.equal((await c.get(p.id)).attachments.length, 0);
});

test("stale verification refuses registration; explicit reinspection rebinds revision", async (t) => {
  const { c, p } = await setup(t),
    m = await downloadPaper(c, p.id, transport(await pdf()));
  await verifyDownload(c, m.id);
  await c.update(p.id, { notes: "Edited while downloading" });
  await assert.rejects(registerDownload(c, m.id), /changed after verification/);
  assert.equal((await verifyDownload(c, m.id)).state, "needs_review");
  await verifyDownload(c, m.id, "Rechecked current publication");
  await registerDownload(c, m.id);
});

test("HTML, truncated and fake PDFs remain unregistrable even with acceptance", async (t) => {
  const { c, p } = await setup(t);
  await c.update(p.id, { paper_url: "https://publisher.test/file" });
  await c.change((s) => {
    delete s.publications.find((x) => x.id === p.id)!.official_url;
  });
  for (const bytes of [
    Buffer.from("<html>Login</html>"),
    Buffer.from("%PDF-1.7\nstartxref\n0\n%%EOF"),
  ]) {
    const m = await downloadPaper(c, p.id, async (url) => ({
      url,
      bytes,
      contentType: "application/pdf",
    }));
    assert.equal((await verifyDownload(c, m.id, "Accept")).state, "invalid");
    await assert.rejects(registerDownload(c, m.id), /Verify/);
  }
});

test("discovery resolves relative URLs, excludes supplements and refuses ambiguous or wrong DOI", async (t) => {
  const { c, p } = await setup(t);
  const list = paperCandidates(
    '<a href="paper">PDF</a><a href="supp.pdf">Supplement PDF</a>',
    p.official_url!,
    p,
  );
  assert.deepEqual(
    list.map((c) => c.url),
    ["https://publisher.test/paper"],
  );
  const fetch = async () =>
    new Response('<a href="one">PDF</a><a href="two">PDF</a>');
  const result = await downloadPapers(c, [p.id], { fetch, intervalMs: 0 });
  assert.equal(result[0]?.status, "PAPER_AMBIGUOUS");
  assert.equal((await listDownloads(c)).length, 0);
  assert.throws(
    () =>
      paperCandidates(
        '<meta name="citation_doi" content="10.1000/wrong">',
        p.official_url!,
        { ...p, identifiers: { doi: "10.1000/right" } },
      ),
    /differs/,
  );
});

test("batch runs parallel across hosts, serial within a host, and keeps partial successes", async (t) => {
  const { c, p } = await setup(t),
    bytes = await pdf("Example Paper");
  await c.update(p.id, { paper_url: "https://a.test/one" });
  const p2 = await c.add({
    citation_key: "two",
    type: "conference",
    title: "Example Paper",
    authors: [],
    paper_url: "https://a.test/two",
  });
  const p3 = await c.add({
    citation_key: "three",
    type: "conference",
    title: "Example Paper",
    authors: [],
    paper_url: "https://b.test/three",
  });
  await c.add({
    citation_key: "bad",
    type: "conference",
    title: "Bad",
    authors: [],
    paper_url: "https://c.test/bad",
  });
  let active = 0,
    peak = 0;
  const hosts = new Map<string, number>();
  const fetch = async (url: string | URL | Request) => {
    const host = new URL(String(url)).host;
    assert.equal(hosts.get(host) ?? 0, 0);
    hosts.set(host, 1);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    hosts.set(host, 0);
    return host === "c.test"
      ? new Response("blocked", { status: 403 })
      : new Response(new Uint8Array(bytes));
  };
  const result = await downloadPapers(c, undefined, {
    fetch,
    intervalMs: 0,
    concurrency: 4,
    register: true,
  });
  assert.ok(peak > 1);
  assert.equal(result.filter((r) => r.status === "registered").length, 3);
  assert.equal(result.filter((r) => r.status === "PAPER_BLOCKED").length, 1);
  for (const id of [p.id, p2.id, p3.id])
    assert.equal((await c.get(id)).attachments.length, 1);
  const retry = await downloadPapers(c, [p.id, p2.id, p3.id], {
    missing: true,
    fetch: async () => {
      throw new Error("unexpected network");
    },
  });
  assert.equal(retry.length, 0);
});

test("max-new caps newly transferred PDFs while reused stages do not consume the allowance", async (t) => {
  const { c, p } = await setup(t),
    bytes = await pdf("Example Paper");
  await c.update(p.id, { paper_url: "https://one.test/paper" });
  const publications = [p];
  for (let index = 2; index <= 5; index++)
    publications.push(
      await c.add({
        citation_key: `cap-${index}`,
        type: "conference",
        title: "Example Paper",
        authors: [],
        paper_url: `https://${index}.test/paper`,
      }),
    );
  let calls = 0;
  const fetch = async (url: string | URL | Request) => {
    calls++;
    if (new URL(String(url)).hostname === "3.test")
      return new Response("missing", { status: 404 });
    return new Response(new Uint8Array(bytes));
  };
  await downloadPaper(c, p.id, paperTransport({ fetch, intervalMs: 0 }));
  const progress: string[] = [];
  const results = await downloadPapers(
    c,
    publications.map((item) => item.id),
    {
      fetch,
      intervalMs: 0,
      concurrency: 2,
      maxNew: 2,
      onProgress: (message) => progress.push(message),
    },
  );
  assert.equal(results.length, 4);
  assert.equal(results.filter((result) => result.new_download).length, 2);
  assert.equal(
    results.filter((result) => result.new_download === false).length,
    1,
  );
  assert.equal(results.filter((result) => result.error).length, 1);
  assert.equal(calls, 4);
  assert.match(
    progress[0]!,
    /5 publications selected.*at most 2 new downloads/,
  );
  assert.ok(progress.some((message) => /Starting \[1\/5\]/.test(message)));
  assert.ok(progress.some((message) => /Verifying \[1\/3\]/.test(message)));
  assert.match(progress.at(-1)!, /2 newly downloaded.*1 failed.*1 not examined/);
});

test("transport bounds redirects and streamed sizes and retries transient failures", async () => {
  await assert.rejects(
    paperTransport({
      intervalMs: 0,
      fetch: async () =>
        new Response(null, { status: 302, headers: { location: "/loop" } }),
    })("https://test.example/a"),
    /redirects/,
  );
  await assert.rejects(
    paperTransport({
      intervalMs: 0,
      maxBytes: 2,
      fetch: async () => new Response("too long"),
    })("https://test.example/a"),
    /size limit/,
  );
  let calls = 0;
  const waits: number[] = [];
  const response = await paperTransport({
    intervalMs: 0,
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetch: async () =>
      ++calls === 1
        ? new Response(null, { status: 429, headers: { "retry-after": "1" } })
        : new Response("ok"),
  })("https://test.example/a");
  assert.equal(response.bytes.toString(), "ok");
  assert.equal(calls, 2);
  assert.ok(waits.some((ms) => ms > 0));
});

test("registration recovers after catalog commit and restores identical missing attachment bytes", async (t) => {
  const { c, p, root } = await setup(t),
    bytes = await pdf();
  const m = await downloadPaper(c, p.id, transport(bytes));
  const verified = await verifyDownload(c, m.id);
  const a = await registerDownload(c, m.id);
  const stage = join(root, "local/downloads", m.id);
  // Simulate the old verified manifest surviving a crash after the catalog transaction.
  await writeFile(join(stage, "manifest.json"), JSON.stringify(verified));
  await writeFile(join(stage, "paper.pdf"), bytes);
  await writeFile(
    join(root, a.path),
    "version https://git-lfs.github.com/spec/v1\n",
  );
  assert.equal((await registerDownload(c, m.id)).id, a.id);
  assert.deepEqual(await readFile(join(root, a.path)), bytes);
  assert.equal((await c.get(p.id)).attachments.length, 1);
  const reviews = (await c.read()).reviews.filter((r) =>
    r.summary.startsWith("Discovered paper URL"),
  );
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]?.state, "pending");
  assert.equal((await c.get(p.id)).paper_url, undefined);
});

test("explicit candidate selection and broken paper URL fallback retain provenance", async (t) => {
  const { c, p } = await setup(t),
    bytes = await pdf();
  await c.update(p.id, { paper_url: "https://old.test/missing" });
  const fetch = async (url: string | URL | Request) =>
    String(url).includes("old.test")
      ? new Response(null, { status: 404 })
      : String(url).endsWith("article")
        ? new Response(
            '<meta name="citation_title" content="Example Paper"><meta name="citation_pdf_url" content="/download">',
          )
        : new Response(new Uint8Array(bytes));
  const results = await downloadPapers(c, [p.id], { fetch, intervalMs: 0 });
  assert.equal(results[0]?.status, "verified");
  const staged = (await listDownloads(c))[0]!;
  assert.equal(staged.requested_url, "https://publisher.test/download");
  const selected = await downloadPaper(
    c,
    p.id,
    async (url) => ({ url, bytes, contentType: "application/pdf" }),
    "https://publisher.test/selected",
  );
  assert.notEqual(selected.id, staged.id);
  assert.equal(selected.requested_url, "https://publisher.test/selected");
  const updated = await c.get(p.id);
  assert.throws(
    () =>
      paperCandidates(
        '<meta name="citation_doi" content="10.1000/a-b">',
        p.official_url!,
        { ...updated, identifiers: { doi: "10.1000/a.b" } },
      ),
    /differs/,
  );
});
