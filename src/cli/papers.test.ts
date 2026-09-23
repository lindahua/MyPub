import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { Catalog } from "../core/catalog.js";
import { main } from "./main.js";

async function invoke(root: string, args: string[]) {
  let stdout = "",
    stderr = "";
  const original = process.stdout.write;
  const originalError = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(["--root", root, "--json", "attachment", ...args]);
    return { code, value: JSON.parse(stdout), stderr };
  } finally {
    process.stdout.write = original;
    process.stderr.write = originalError;
  }
}

test("PDF CLI stages, inspects, accepts and registers; usage errors do not fetch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mypub-paper-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = new Catalog({ root });
  await c.initialize();
  const p = await c.add({
    citation_key: "cli",
    title: "CLI Paper",
    type: "conference",
    authors: [],
    paper_url: "https://example.test/paper",
  });
  const doc = await PDFDocument.create();
  doc.addPage();
  const bytes = await doc.save();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(new Uint8Array(bytes));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  for (const args of [
    ["download", "--all", "--concurrency", "0"],
    ["download", "--all", "--max-new", "0"],
    ["download", "--all", "--preview", "--max-new", "1"],
    ["download", "cli", "--unknown"],
    ["download", "--all", "--url", "https://example.test/pdf"],
  ])
    await assert.rejects(invoke(root, args));
  assert.equal(calls, 0);
  const preview = await invoke(root, ["download", "cli", "--preview"]);
  assert.equal(preview.value[0].status, "preview");
  assert.equal(calls, 0);
  const result = await invoke(root, ["download", "cli"]);
  assert.equal(result.code, 0);
  assert.equal(result.value[0].status, "needs_review");
  assert.match(result.stderr, /PDF batch: 1 publication selected/);
  assert.match(result.stderr, /Starting \[1\/1\] cli/);
  assert.match(result.stderr, /Verifying \[1\/1\] cli/);
  assert.match(result.stderr, /PDF batch complete: 1 examined/);
  const id = result.value[0].download_id;
  assert.equal((await c.get(p.id)).attachments.length, 0);
  assert.equal((await invoke(root, ["downloads"])).value.length, 1);
  assert.equal((await invoke(root, ["inspect", id])).value.id, id);
  await assert.rejects(invoke(root, ["register", id]), /Verify/);
  assert.equal(
    (await invoke(root, ["verify", id, "--accept-reason", "Reviewed the PDF"]))
      .value.state,
    "verified",
  );
  // A second verification preserves acceptance while the file and record are unchanged.
  assert.equal((await invoke(root, ["verify", id])).value.state, "verified");
  const a = (await invoke(root, ["register", id])).value;
  assert.equal((await c.get(p.id)).attachments[0]?.id, a.id);
  assert.deepEqual(
    (await invoke(root, ["download", "--all", "--missing"])).value,
    [],
  );
  assert.equal(calls, 1);
});
