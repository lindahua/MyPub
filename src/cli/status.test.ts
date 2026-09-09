import assert from "node:assert/strict";
import test from "node:test";
import { formatStatus } from "./status.js";
import type { StatusResult } from "../core/types.js";

const base: StatusResult = { catalog: "ready", git: true, lfs: true, branch: "main", commit: "0123456789abcdef0123456789abcdef01234567", upstream: "origin/main", ahead: 0, behind: 0, dirty: false, pending_upload: false, needs_review: false };
test("status explains uncommitted metadata even when commits are aligned", () => {
  const text = formatStatus({ ...base, dirty: true, pending_upload: false, changes: [{ path: "catalog/publications/2025/paper.json", status: "modified", label: "Mask-DPO" }, { path: "catalog/reviews/link.json", status: "added", label: "Link Scholar Mask-DPO" }] }, "/library", true);
  assert.match(text, /modified +publication +Mask-DPO/);
  assert.match(text, /added +review +Link Scholar Mask-DPO/);
  assert.match(text, /Local: +2 uncommitted files/);
  assert.match(text, /mypub commit/); assert.doesNotMatch(text, /Next: mypub sync/);
  assert.match(text, /0 to upload, 0 to download \(last fetched\)/);
});
test("status distinguishes clean, divergent, unconfigured and conflicted libraries", () => {
  assert.match(formatStatus(base, "/library"), /Local: +clean/);
  assert.doesNotMatch(formatStatus(base, "/library"), /Next:/);
  const divergent = formatStatus({ ...base, ahead: 2, behind: 1, pending_upload: true }, "/library");
  assert.match(divergent, /2 to upload/); assert.match(divergent, /1 to download/);
  const { upstream, ...unconfigured } = base;
  assert.match(formatStatus(unconfigured, "/library"), /no upstream/);
  assert.match(formatStatus({ ...base, branch: "" }, "/library"), /select a branch/);
  assert.match(formatStatus({ ...base, needs_review: true }, "/library"), /mypub conflicts/);
  assert.match(formatStatus({ ...base, git: false, catalog: "missing", lfs: false }, "/library"), /Attention: catalog missing/);
});

test("status keeps routine health quiet and separates unrelated files from managed edits", () => {
  const clean = formatStatus(base, "/library");
  assert.equal(clean.split("\n").length, 6);
  assert.match(clean, /Commit: +0123456789abcdef0123456789abcdef01234567/);
  assert.doesNotMatch(clean, /Attention:|Catalog:|LFS|Next:/);
  const mixed = formatStatus({ ...base, dirty: true, changes: [{ path: ".gitignore", status: "modified" }, { path: "notes.txt", status: "added" }] }, "/library", true);
  assert.match(mixed, /modified +config +\.gitignore/);
  assert.match(mixed, /added +other +notes.txt/);
  assert.match(mixed, /Next: mypub commit; handle other files with Git or ignore them/);
  const detached = formatStatus({ ...base, branch: "", lfs: false }, "/library");
  assert.match(detached, /detached HEAD/); assert.match(detached, /Attention: Git LFS not installed/);
  assert.match(detached, /Next: select a branch/);
});

test("status renders last sync in local time and retains the original timestamp", () => {
  const original = "2026-09-09T01:34:52Z";
  const expected = new Date(original);
  const pad = (value: number) => String(value).padStart(2, "0");
  const localDateTime = `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())} ${pad(expected.getHours())}:${pad(expected.getMinutes())}:${pad(expected.getSeconds())}`;
  const text = formatStatus({ ...base, last_successful_sync: original }, "/library");
  assert.match(text, new RegExp(`Last sync: ${localDateTime} UTC[+-]\\d{2}:\\d{2} \\[${original}\\]`));
});

test("status summarizes changes by default and lists them only with details", () => {
  const status = { ...base, dirty: true, changes: [{ path: "catalog/publications/paper.json", status: "modified" as const, label: "A Paper" }] };
  const summary = formatStatus(status, "/library");
  assert.match(summary, /Local: +1 uncommitted file/);
  assert.doesNotMatch(summary, /Uncommitted files:|A Paper|paper.json/);
  assert.match(formatStatus(status, "/library", true), /modified +publication +A Paper/);
});
