import { watch, type FSWatcher } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Catalog } from "../core/catalog.js";
import { fingerprint, safePath } from "../core/utils.js";
import { MyPubError } from "../core/errors.js";
import { toBibtex } from "../core/exports.js";
import type { Attachment } from "../core/types.js";
import type { Availability, DesktopState } from "./types.js";

export function relevantChange(filename: string | null): boolean {
  if (filename === null) return true;
  const path = filename.replaceAll("\\", "/");
  return (
    path === "catalog" ||
    path.startsWith("catalog/") ||
    path === "attachments" ||
    path.startsWith("attachments/") ||
    path === "local" ||
    /^local\/index\.sqlite(?:-(?:wal|shm|journal))?$/.test(path)
  );
}
export async function attachmentLocation(
  root: string,
  attachment: Attachment,
): Promise<string> {
  const path = safePath(root, attachment.path);
  const actual = await realpath(path);
  const base = await realpath(root);
  const rel = relative(base, actual);
  if (
    rel.startsWith(`..${sep}`) ||
    rel === ".." ||
    !actual.startsWith(base + sep)
  )
    throw new MyPubError(
      "Attachment resolves outside the catalog",
      "UNSAFE_PATH",
    );
  return actual;
}
export async function attachmentAvailability(
  root: string,
  a: Attachment,
): Promise<Availability> {
  try {
    const path = await attachmentLocation(root, a);
    const info = await stat(path);
    if (!info.isFile()) return "error";
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(128);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (
        buffer
          .subarray(0, bytesRead)
          .toString()
          .startsWith("version https://git-lfs.github.com/spec/v1")
      )
        return "not-downloaded";
    } finally {
      await handle.close();
    }
    return info.size === a.size_bytes ? "local" : "error";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "error";
  }
}

/** Serializes bursts of changes; all SQLite work runs in the desktop worker. */
export class LibraryService {
  readonly catalog: Catalog;
  state: DesktopState;
  private watcher: FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private queued = false;
  private stopped = false;
  private lastFingerprint = "";
  constructor(
    root: string,
    private readonly emit: (state: DesktopState) => void,
    private readonly interval = 5000,
  ) {
    this.catalog = new Catalog({ root });
    this.state = {
      root: this.catalog.root,
      status: "loading",
      snapshot: null,
      error: null,
    };
  }
  async start(): Promise<void> {
    this.setActive(true);
    await this.refresh();
  }
  setActive(active: boolean): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = active
      ? setInterval(() => void this.refresh(), this.interval)
      : undefined;
  }
  schedule(): void {
    if (this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), 300);
  }
  private notify(patch: Partial<DesktopState>): void {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch };
    this.emit(this.state);
  }
  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    try {
      // Never initialize a catalog merely because a folder was selected.
      await access(join(this.catalog.root, "catalog/library.json"));
      if (!this.watcher) {
        try {
          this.watcher = watch(
            this.catalog.root,
            { recursive: true },
            (_event, name) => {
              if (relevantChange(name)) this.schedule();
            },
          );
          this.watcher.on("error", () => {
            this.watcher?.close();
            this.watcher = undefined;
          });
        } catch {
          /* Foreground polling and focus/resume checks are the backstop. */
        }
      }
      const loaded = await this.catalog.snapshot();
      const availability: Record<string, Availability> = {};
      const attachments = loaded.state.publications.flatMap(
        (p) => p.attachments,
      );
      for (let i = 0; i < attachments.length; i += 16) {
        await Promise.all(
          attachments.slice(i, i + 16).map(async (a) => {
            availability[a.id] = await attachmentAvailability(
              this.catalog.root,
              a,
            );
          }),
        );
      }
      const key = fingerprint([loaded.source, availability]);
      if (key !== this.lastFingerprint) {
        this.lastFingerprint = key;
        // Large immutable import payloads stay in the catalog; retain review provenance and decisions.
        for (const r of loaded.state.reviews)
          if (r.evidence) r.evidence = { ...r.evidence, payload: null };
        this.notify({
          status: "current",
          error: null,
          snapshot: {
            ...loaded,
            availability,
            root: this.catalog.root,
            generation: key,
            loadedAt: new Date().toISOString(),
          },
        });
      } else if (this.state.status !== "current")
        this.notify({ status: "current", error: null });
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
      }
    } catch (error) {
      const locked =
        error instanceof MyPubError && error.code === "CATALOG_LOCKED";
      const message =
        error instanceof MyPubError
          ? `${error.code}: ${error.message}${error.details ? "\n" + JSON.stringify(error.details, null, 2) : ""}`
          : String(error);
      this.notify({ status: locked ? "waiting" : "stale", error: message });
      if (locked && !this.stopped) {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => void this.refresh(), 1000);
      }
    } finally {
      this.running = false;
      if (this.queued && !this.stopped) {
        this.queued = false;
        this.schedule();
      }
    }
  }
  async action(
    action: "citation" | "attachment",
    libraryId: string,
    publicationId: string,
    attachmentId?: string,
  ): Promise<string> {
    // Resolve against fresh canonical data, not a stale renderer-supplied path.
    const state = await this.catalog.read();
    if (state.library.id !== libraryId)
      throw new Error("The selected library changed. Please try again.");
    const publication = state.publications.find((p) => p.id === publicationId);
    if (!publication) throw new Error("Publication is no longer available.");
    if (action === "citation") return toBibtex([publication]);
    const attachment = publication.attachments.find(
      (a) => a.id === attachmentId,
    );
    if (
      !attachment ||
      (await attachmentAvailability(this.catalog.root, attachment)) !== "local"
    )
      throw new Error(
        "Attachment is not available locally. Use mypub attachment fetch to download it.",
      );
    if (
      !/^(application\/pdf|image\/(png|jpeg|webp)|video\/(mp4|quicktime)|text\/plain)$/.test(
        attachment.media_type,
      ) ||
      !/\.(pdf|png|jpe?g|webp|mp4|mov|txt)$/i.test(attachment.original_filename)
    )
      throw new Error(
        "This attachment type cannot be opened by the viewer. Open it manually from the catalog.",
      );
    return attachmentLocation(this.catalog.root, attachment);
  }
  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    if (this.debounce) clearTimeout(this.debounce);
    if (this.poll) clearInterval(this.poll);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }
}
