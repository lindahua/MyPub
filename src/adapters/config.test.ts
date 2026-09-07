import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { configPath, expandHome, readUserConfig, resolveRepoRoot } from "./config.js";

test("user configuration selects a stable repository with explicit overrides", async () => {
  const home = await mkdtemp(join(tmpdir(), "mypub-config-"));
  const path = configPath(home), cwd = join(home, "elsewhere");
  try {
    assert.deepEqual(await readUserConfig(home), {});
    assert.equal(await resolveRepoRoot(undefined, home, cwd), cwd);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ repo_path: "~/Data/My Pub" }));
    assert.equal(await resolveRepoRoot(undefined, home, cwd), join(home, "Data/My Pub"));
    assert.equal(await resolveRepoRoot("./override", home, cwd), join(cwd, "override"));
    assert.equal(await resolveRepoRoot("~/override", home, cwd), join(home, "override"));
    assert.equal(expandHome("~", home), home);
    await writeFile(path, JSON.stringify({ repo_path: "/absolute/catalog" }));
    assert.equal(await resolveRepoRoot(undefined, home, cwd), "/absolute/catalog");
    for (const value of ["{", "null", "[]", '"text"', '{"repo_path":null}', '{"repo_path":""}', '{"repo_path":"relative"}', '{"repo_path":"~other/repo"}', '{"repo_path":"/bad\\u0000path"}', '{"repo_pth":"/repo"}']) {
      await writeFile(path, value);
      await assert.rejects(readUserConfig(home), /Invalid .*config.json/);
      assert.equal(await resolveRepoRoot("/override", home, cwd), "/override");
    }
    await rm(path); await mkdir(path);
    await assert.rejects(readUserConfig(home), /Cannot read .*config.json/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("CLI uses the configured catalog from another directory and keeps help available", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const { Catalog } = await import("../core/catalog.js");
  const home = await mkdtemp(join(tmpdir(), "mypub-config-cli-"));
  const root = join(home, "catalog"), path = configPath(home);
  const cli = fileURLToPath(new URL("../cli/main.js", import.meta.url));
  const invoke = (args: string[]) => promisify(execFile)(process.execPath, [cli, ...args], { cwd: home, env: { ...process.env, HOME: home } });
  try {
    const link = join(home, "mypub.js");
    await symlink(cli, link);
    const linked = await promisify(execFile)(process.execPath, [link, "--help"]);
    assert.match(linked.stdout, /mypub — portable publication catalog/);
    await new Catalog({ root }).initialize("Configured catalog");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ repo_path: root }));
    assert.deepEqual(JSON.parse((await invoke(["--json", "list"])).stdout), []);
    assert.equal(JSON.parse((await invoke(["config", "show"])).stdout).repo_path, root);
    await assert.rejects(invoke(["config", "show", "unexpected"]), /USAGE/);
    await writeFile(path, "broken");
    await assert.rejects(invoke(["list"]), /CONFIG/);
    assert.match((await invoke(["--help"])).stdout, /config show/);
    assert.deepEqual(JSON.parse((await invoke(["--root", root, "--json", "list"])).stdout), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});
