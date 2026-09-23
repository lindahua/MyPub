import assert from "node:assert/strict";
import test from "node:test";
import { LfsProgressTracker } from "./lfs-progress.js";

test("LFS progress averages file ratios instead of bytes or reporting each file", () => {
  const tracker = new LfsProgressTracker("upload", ["small.pdf", "large.pdf"]);
  assert.equal(tracker.accept("upload 1/2 0/10 small.pdf"), undefined);
  assert.equal(tracker.accept("upload 1/2 5/10 small.pdf"), 25);
  assert.equal(tracker.accept("upload 2/2 50/100 large.pdf"), 50);
  assert.equal(tracker.accept("upload 1/2 10/10 small.pdf"), 75);
  assert.equal(tracker.accept("upload 1/2 9/10 small.pdf"), undefined);
  assert.equal(tracker.accept("upload 2/2 100/100 large.pdf"), 100);
  assert.equal(tracker.finish(), undefined);
});

test("LFS progress ignores unrelated events and finishes when Git LFS omits byte events", () => {
  const tracker = new LfsProgressTracker("download", ["one.pdf", "two.pdf"]);
  assert.equal(tracker.accept("upload 1/2 10/10 one.pdf"), undefined);
  assert.equal(tracker.accept("download 1/2 10/10 other.pdf"), undefined);
  assert.equal(tracker.accept("not a progress line"), undefined);
  assert.equal(tracker.accept("download 1/2 0/0 one.pdf"), 50);
  assert.equal(tracker.finish(), 100);
});
