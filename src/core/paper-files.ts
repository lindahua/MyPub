import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CatalogState, Publication } from "./types.js";
import { catalogFiles } from "./paths.js";
import { MyPubError } from "./errors.js";

export const PAPER_FILES = "catalog/paper_files/";
export const PAPER_LFS_RULE =
  "catalog/paper_files/** filter=lfs diff=lfs merge=lfs -text";

/** Match the publication JSON's year, stem, and collision-safe UUID suffix. */
export function paperFilePaths(state: CatalogState): Map<string, string> {
  const paths = new Map<string, string>();
  for (const [path, value] of catalogFiles(state)) {
    if (!path.startsWith("catalog/publications/") || !path.endsWith(".json"))
      continue;
    const p = value as Publication;
    const name = path.slice("catalog/publications/".length, -5);
    paths.set(p.id, `${PAPER_FILES}${name}.pdf`);
  }
  return paths;
}
export function paperFilePath(state: CatalogState, p: Publication): string {
  const path = paperFilePaths(state).get(p.id);
  if (!path)
    throw new MyPubError(
      "Publication has no derived PDF path",
      "ATTACHMENT_PATH",
    );
  return path;
}

/** Reconcile already-managed readable PDF paths during a metadata edit. */
export async function movePaperFiles(
  root: string,
  state: CatalogState,
  binary: Map<string, Buffer>,
  removed: Set<string>,
): Promise<void> {
  const paths = paperFilePaths(state);
  const moves = state.publications.flatMap((p) =>
    p.attachments
      .filter(
        (a) => a.path.startsWith(PAPER_FILES) && a.path !== paths.get(p.id),
      )
      .map((a) => ({ a, target: paths.get(p.id)! })),
  );
  const sources = new Set(moves.map(({ a }) => a.path));
  for (const { a, target } of moves) {
    if (binary.has(target))
      throw new MyPubError(`PDF path collision: ${target}`, "ATTACHMENT_PATH");
    if (!sources.has(target)) {
      try {
        await lstat(join(root, target));
        throw new MyPubError(
          `PDF path already exists: ${target}`,
          "ATTACHMENT_PATH",
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    let bytes: Buffer;
    const stagedSource = binary.get(a.path);
    try {
      const source = join(root, a.path);
      if (stagedSource) bytes = stagedSource;
      else {
        if ((await lstat(source)).isSymbolicLink())
          throw new MyPubError("PDF path is a symlink", "UNSAFE_PATH");
        bytes = await readFile(source);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        throw new MyPubError(
          `Fetch missing PDF before renaming: ${a.path}`,
          "ATTACHMENT_NOT_LOCAL",
        );
      throw e;
    }
    const pointer =
      /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\n$/.exec(
        bytes.toString("utf8"),
      );
    if (
      pointer
        ? pointer[1] !== a.sha256 || Number(pointer[2]) !== a.size_bytes
        : bytes.length !== a.size_bytes ||
          createHash("sha256").update(bytes).digest("hex") !== a.sha256
    )
      throw new MyPubError(
        `PDF bytes do not match manifest: ${a.path}`,
        "ATTACHMENT_MISMATCH",
      );
    if (stagedSource) binary.delete(a.path);
    binary.set(target, bytes);
    removed.add(a.path);
    a.path = target;
  }
}

/** Normalize merged manifests before whole-catalog validation; bytes move in the merge worktree. */
export function rebasePaperFilePaths(state: CatalogState): void {
  const paths = paperFilePaths(state);
  for (const p of state.publications)
    for (const a of p.attachments) {
      if (a.path.startsWith(PAPER_FILES)) a.path = paths.get(p.id)!;
    }
}
