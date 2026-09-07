import type { CatalogState } from "../core/types.js";

export type Page =
  "overview" | "publications" | "authors" | "venues" | "scholar";
export type Collection = Exclude<Page, "overview">;
export type Availability = "local" | "not-downloaded" | "missing" | "error";
export interface Snapshot {
  state: CatalogState;
  paths: Record<string, string>;
  availability: Record<string, Availability>;
  root: string;
  generation: string;
  loadedAt: string;
}
export interface DesktopState {
  status: "empty" | "loading" | "current" | "updating" | "waiting" | "stale";
  root: string | null;
  snapshot: Snapshot | null;
  error: string | null;
}
export interface DesktopAPI {
  state(): Promise<DesktopState>;
  chooseLibrary(): Promise<void>;
  retry(): Promise<void>;
  copyCitation(libraryId: string, publicationId: string): Promise<void>;
  openAttachment(
    libraryId: string,
    publicationId: string,
    attachmentId: string,
  ): Promise<void>;
  openURL(url: string): Promise<void>;
  onState(callback: (state: DesktopState) => void): () => void;
}
export type WorkerCommand = {
  id: number;
  action: "citation" | "attachment";
  libraryId: string;
  publicationId: string;
  attachmentId?: string;
};
export type WorkerResponse = { id: number; result?: string; error?: string };
