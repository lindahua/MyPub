import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseViewArgs, runViewer } from "./view.js";

test("viewer launcher validates arguments and help never launches Electron", () => {
  assert.deepEqual(parseViewArgs([]), []);
  assert.deepEqual(parseViewArgs(["--root", "/library with spaces"]), ["--root", "/library with spaces"]);
  for (const args of [["--root"], ["--root", ""], ["--inspect"], ["--root", "x", "--no-sandbox"]]) assert.throws(() => parseViewArgs(args), /Usage/);
  const entry = fileURLToPath(new URL("./view.js", import.meta.url));
  const help = spawnSync(process.execPath, [entry, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0); assert.match(help.stdout, /mypub-view.*launch/); assert.match(help.stdout, /--root PATH/);
  const invalid = spawnSync(process.execPath, [entry, "--unknown"], { encoding: "utf8" });
  assert.equal(invalid.status, 2); assert.match(invalid.stderr, /Usage/);
});

test("launcher forwards literal paths and propagates child exit and launch failure", async t => {
  const root = await mkdtemp(join(tmpdir(), "mypub-launch-")); t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "fake runtime.cjs"), output = join(root, "arguments.json");
  await writeFile(script, 'require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3))); process.exitCode = 7;');
  const path = join(root, 'library with spaces $literal');
  assert.equal(await runViewer(process.execPath, script, [output, "--root", path]), 7);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), ["--root", path]);
  await assert.rejects(runViewer(join(root, "missing-executable"), script, []), /ENOENT/);
});
