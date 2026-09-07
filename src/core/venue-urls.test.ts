import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Catalog } from "./catalog.js";
import { addVenue, mergeIdentity, updateIdentity } from "./identities.js";
import { nativeExport, parseNative } from "./native.js";

test("venue URLs round-trip with roles and labels and merge by URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "mypub-venue-urls-"));
  try {
    const c = new Catalog({ root }); await c.initialize();
    const home = { url: "https://example.org/", role: "homepage" as const };
    const proceedings = { url: "https://example.org/papers", role: "proceedings" as const, label: "Open papers" };
    const survivor = await addVenue(c, { venue_key: "survivor", kind: "conference", preferred_name: "Conference", urls: [home, proceedings] });
    const source = await addVenue(c, { venue_key: "source", kind: "conference", preferred_name: "Old Conference", urls: [{ ...home, role: "other", label: "Old label" }, { url: "https://example.org/submit", role: "submission" }] });
    await mergeIdentity(c, "venue", source.id, survivor.id, true);
    const urls = (await c.read()).venues.find(v => v.id === survivor.id)!.urls;
    assert.deepEqual(urls, [home, proceedings, { url: "https://example.org/submit", role: "submission" }]);
    const p = await c.add({ citation_key: "paper", type: "conference", title: "Paper", authors: [], venue: { name: "Conference", venue_id: survivor.id }, extra_urls: ["https://example.org/article"] });
    const exported = parseNative(JSON.parse(JSON.stringify(nativeExport(await c.read(), [p.id]))));
    assert.deepEqual(exported.venues.find(v => v.id === survivor.id)!.urls, urls);
    assert.deepEqual(exported.publications[0]!.extra_urls, ["https://example.org/article"]);
    for (const invalid of [["https://example.org/"], [{ url: "https://example.org/" }], [{ ...home, role: "invalid" }], [{ ...home, url: "relative/path" }], [{ ...home, label: "" }], [home, { ...home, role: "proceedings" }]]) {
      await assert.rejects(updateIdentity(c, "venue", survivor.id, { urls: invalid }));
    }
    assert.deepEqual((await c.read()).venues.find(v => v.id === survivor.id)!.urls, urls);
  } finally { await rm(root, { recursive: true, force: true }); }
});
