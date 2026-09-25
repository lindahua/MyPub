import type { PageSizes } from "./pagination.js";
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
  pageSizes?: PageSizes;
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
  loadPaperPdf(
    libraryId: string,
    publicationId: string,
    attachmentId: string,
  ): Promise<Uint8Array>;
  openURL(url: string): Promise<void>;
  addTodo(libraryId: string, title: string, publicationId?: string): Promise<void>;
  setTodoCompleted(libraryId: string, todoId: string, completed: boolean): Promise<void>;
  onState(callback: (state: DesktopState) => void): () => void;
}
export type WorkerCommand = {
  id: number;
  action: "citation" | "attachment" | "paper-pdf";
  libraryId: string;
  publicationId: string;
  attachmentId?: string;
} | { id: number; action: "todo-add"; libraryId: string; title: string; publicationId?: string }
  | { id: number; action: "todo-set"; libraryId: string; todoId: string; completed: boolean };
export type WorkerResponse = { id: number; result?: string; error?: string };
