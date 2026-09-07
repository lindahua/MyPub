import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  powerMonitor,
  protocol,
  shell,
} from "electron";
import { Worker } from "node:worker_threads";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readUserConfig,
  expandHome,
  type UserConfig,
} from "../adapters/config.js";
import { DEFAULT_PAGE_SIZES } from "./pagination.js";
import type { PageSizes } from "./pagination.js";
import type { DesktopState, WorkerResponse } from "./types.js";

const directory = dirname(fileURLToPath(import.meta.url));
const rendererURL = "mypub://app/index.html";
protocol.registerSchemesAsPrivileged([
  {
    scheme: "mypub",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
let window: BrowserWindow | undefined;
let worker: Worker | undefined;
let current: DesktopState = {
  status: "empty",
  root: null,
  snapshot: null,
  error: null,
};
let pageSizes: PageSizes = { ...DEFAULT_PAGE_SIZES };
let sequence = 0;
const pending = new Map<
  number,
  {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function publish(state: DesktopState): void {
  current = { ...state, pageSizes };
  if (window && !window.isDestroyed())
    window.webContents.send("mypub:state", current);
}
function stopWorker(): void {
  const old = worker;
  worker = undefined;
  void old?.terminate();
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error("Library changed or closed"));
  }
  pending.clear();
}
function openLibrary(root: string): void {
  stopWorker();
  publish({ status: "loading", root, snapshot: null, error: null });
  const next = new Worker(new URL("./worker.js", import.meta.url), {
    workerData: { root },
  });
  worker = next;
  next.on("message", (message: { state?: DesktopState } & WorkerResponse) => {
    if (worker !== next) return;
    if (message.state) {
      publish(message.state);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result ?? "");
  });
  const failed = (error: Error) => {
    if (worker === next) {
      stopWorker();
      publish({ ...current, status: "stale", error: error.message });
    }
  };
  next.on("error", failed);
  next.on("exit", (code) => {
    if (worker === next)
      failed(
        new Error(`Library worker stopped (${code}). Use Retry to reopen it.`),
      );
  });
}
async function chooseLibrary(): Promise<void> {
  if (!window) return;
  const result = await dialog.showOpenDialog(window, {
    title: "Open a MyPub catalog",
    properties: ["openDirectory"],
    ...(current.root ? { defaultPath: current.root } : {}),
  });
  if (!result.canceled && result.filePaths[0]) openLibrary(result.filePaths[0]);
}
function stringArg(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 8192 ||
    value.includes("\0")
  )
    throw new Error("Invalid request");
  return value;
}
function action(
  action: "citation" | "attachment",
  libraryId: unknown,
  publicationId: unknown,
  attachmentId?: unknown,
): Promise<string> {
  const library = stringArg(libraryId),
    publication = stringArg(publicationId);
  if (!worker || current.snapshot?.state.library.id !== library)
    return Promise.reject(new Error("Library is not ready or changed"));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Catalog operation timed out. Try again."));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    worker!.postMessage({
      id,
      action,
      libraryId: library,
      publicationId: publication,
      ...(attachmentId ? { attachmentId: stringArg(attachmentId) } : {}),
    });
  });
}
function setupIPC(): void {
  const handle = (channel: string, callback: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame?.url !== rendererURL
      )
        throw new Error("Untrusted desktop request");
      return callback(...args);
    });
  handle("mypub:get", () => current);
  handle("mypub:choose", chooseLibrary);
  handle("mypub:retry", () => {
    if (worker) worker.postMessage({ action: "refresh" });
    else if (current.root) openLibrary(current.root);
  });
  handle("mypub:citation", async (library, publication) => {
    const text = await action("citation", library, publication);
    clipboard.writeText(text);
  });
  handle("mypub:attachment", async (library, publication, attachment) => {
    const path = await action("attachment", library, publication, attachment);
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  handle("mypub:url", async (value) => {
    const url = new URL(stringArg(value));
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Only HTTP(S) links are supported");
    await shell.openExternal(url.href);
  });
}
void app
  .whenReady()
  .then(async () => {
    nativeTheme.themeSource = "light";
    app.setName("MyPub");
    protocol.handle("mypub", (request) => {
      const url = new URL(request.url);
      const files: Record<string, string> = {
        "/index.html": "index.html",
        "/app.js": "app.js",
        "/app.css": "app.css",
      };
      const file = url.hostname === "app" ? files[url.pathname] : undefined;
      if (!file) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(join(directory, "renderer", file)).href);
    });
    setupIPC();
    const createWindow = async () => {
      window = new BrowserWindow({
        width: 1380,
        height: 930,
        minWidth: 760,
        minHeight: 550,
        title: "MyPub",
        backgroundColor: "#f7f8fa",
        show: false,
        webPreferences: {
          preload: join(directory, "preload.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      window.webContents.session.setPermissionCheckHandler(() => false);
      window.on("focus", () =>
        worker?.postMessage({ action: "active", active: true }),
      );
      window.on("blur", () =>
        worker?.postMessage({ action: "active", active: false }),
      );
      window.on("closed", () => {
        window = undefined;
        worker?.postMessage({ action: "active", active: false });
      });
      await window.loadURL(rendererURL);
      window.show();
    };
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === "darwin"
          ? [
              {
                label: "MyPub",
                submenu: [
                  { role: "about" as const },
                  { type: "separator" as const },
                  { role: "quit" as const },
                ],
              },
            ]
          : []),
        {
          label: "File",
          submenu: [
            {
              label: "Open library…",
              accelerator: "CmdOrCtrl+O",
              click: () => void chooseLibrary(),
            },
            { role: "close" },
          ],
        },
        { role: "editMenu" },
        {
          label: "View",
          submenu: [
            { role: "reload" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { role: "togglefullscreen" },
          ],
        },
      ]),
    );
    await createWindow();
    const rootIndex = process.argv.indexOf("--root");
    try {
      // Explicit --root remains usable if user configuration is malformed.
      const config: UserConfig = await readUserConfig().catch((error) => {
        if (rootIndex >= 0) return {};
        throw error;
      });
      pageSizes = {
        max_pagesize_main:
          config.max_pagesize_main ?? DEFAULT_PAGE_SIZES.max_pagesize_main,
        max_pagesize_dropdown:
          config.max_pagesize_dropdown ??
          DEFAULT_PAGE_SIZES.max_pagesize_dropdown,
      };
      publish(current);
      const configured =
        rootIndex >= 0 ? process.argv[rootIndex + 1] : config.repo_path;
      if (rootIndex >= 0 && (!configured || configured.startsWith("--")))
        throw new Error("--root requires a catalog folder");
      if (configured) openLibrary(resolve(expandHome(configured)));
    } catch (error) {
      publish({ ...current, status: "stale", error: String(error) });
    }
    powerMonitor.on("resume", () => worker?.postMessage({ action: "refresh" }));
    app.on("activate", () => {
      if (!window) void createWindow();
    });
    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") app.quit();
    });
    app.on("before-quit", stopWorker);
  })
  .catch((error) => {
    console.error(error);
    app.quit();
  });
