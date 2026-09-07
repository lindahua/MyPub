#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `mypub-view — launch the MyPub desktop viewer

Usage: mypub-view [--root PATH]
       mypub-view --help

  --root PATH  Open an existing catalog (otherwise use configured repo_path).
  -h, --help   Show this help without starting Electron.

Choose another catalog with Change library… inside the app.
`;

export function parseViewArgs(args: string[]): string[] | "help" {
  if (args.length === 1 && ["-h", "--help"].includes(args[0]!)) return "help";
  if (args.length === 0) return [];
  if (args.length === 2 && args[0] === "--root" && args[1]?.trim() && !args[1].startsWith("--") && !args[1].includes("\0")) return args;
  throw new Error("Usage: mypub-view [--root PATH] | --help");
}

/** Spawn without a shell, preserving paths with spaces and the caller's directory. */
export async function runViewer(executable: string, entry: string, args: string[]): Promise<number> {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [entry, ...args], { stdio: "inherit", env });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    const cleanup = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); };
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    child.once("error", error => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => { cleanup(); resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)); });
  });
}

export async function mainView(args: string[]): Promise<number> {
  let forwarded: string[] | "help";
  try { forwarded = parseViewArgs(args); } catch (error) { console.error(String((error as Error).message)); return 2; }
  if (forwarded === "help") { process.stdout.write(HELP); return 0; }
  try {
    const desktop = join(dirname(fileURLToPath(import.meta.url)), "../desktop");
    for (const file of ["main.js", "worker.js", "preload.cjs", "renderer/index.html", "renderer/app.js", "renderer/app.css"]) {
      try { await access(join(desktop, file)); } catch { throw new Error("Desktop build is missing. Run npm run build:desktop in the source checkout, or reinstall the MyPub package."); }
    }
    const require = createRequire(import.meta.url);
    let executable: unknown;
    try { executable = require("electron"); } catch { throw new Error("Electron runtime is unavailable. Reinstall MyPub with its runtime dependencies (npm install in a source checkout)."); }
    if (typeof executable !== "string") throw new Error("Run mypub-view from a Node.js terminal.");
    return await runViewer(executable, join(desktop, "main.js"), forwarded);
  } catch (error) { console.error(`mypub-view: ${(error as Error).message}`); return 1; }
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => "") === fileURLToPath(import.meta.url)) {
  process.exitCode = await mainView(process.argv.slice(2));
}
