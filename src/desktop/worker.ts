import { parentPort, workerData } from "node:worker_threads";
import { LibraryService } from "./service.js";
import type { WorkerCommand } from "./types.js";
if (!parentPort) throw new Error("Desktop worker requires a parent port");
const port = parentPort;
const service = new LibraryService(String(workerData.root), (state) =>
  port.postMessage({ state }),
);
port.on(
  "message",
  (
    message: WorkerCommand | { action: "refresh" | "active"; active?: boolean },
  ) => {
    if (message.action === "refresh") {
      void service.refresh();
      return;
    }
    if (message.action === "active") {
      service.setActive(message.active === true);
      if (message.active) void service.refresh();
      return;
    }
    if (!("id" in message)) return;
    void service
      .action(
        message.action,
        message.libraryId,
        message.publicationId,
        message.attachmentId,
      )
      .then((result) => port.postMessage({ id: message.id, result }))
      .catch((error) =>
        port.postMessage({ id: message.id, error: String(error) }),
      );
  },
);
void service.start();
