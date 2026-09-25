import assert from "node:assert/strict";
import test from "node:test";
import { ProgressPrinter } from "./progress.js";

test("interactive sync progress redraws one line and closes it before the next message", () => {
  let output = "";
  const printer = new ProgressPrinter(text => { output += text; }, true);
  for (const percent of [1, 2, 100]) {
    printer.report({ phase: "upload-attachments", message: `Uploading attachments: ${percent}%`, percent });
  }
  printer.report({ phase: "upload-attachments", message: "LFS uploads complete: 2/2." });
  printer.finish();
  assert.equal(output, "\r\x1b[2KUploading attachments: 1%\r\x1b[2KUploading attachments: 2%\r\x1b[2KUploading attachments: 100%\nLFS uploads complete: 2/2.\n");
});

test("redirected sync progress emits milestones and keeps the final percentage", () => {
  let output = "";
  const printer = new ProgressPrinter(text => { output += text; }, false);
  for (let percent = 1; percent <= 100; percent++) {
    printer.report({ phase: "upload-attachments", message: `Uploading attachments: ${percent}%`, percent });
  }
  printer.finish();
  const lines = output.trim().split("\n");
  assert.equal(lines.length, 11);
  assert.equal(lines[0], "Uploading attachments: 1%");
  assert.equal(lines[1], "Uploading attachments: 10%");
  assert.equal(lines.at(-1), "Uploading attachments: 100%");
});

test("an interrupted interactive transfer leaves the terminal on a fresh line", () => {
  let output = "";
  const printer = new ProgressPrinter(text => { output += text; }, true);
  printer.report({ phase: "download-papers", message: "Downloading papers: 37%", percent: 37 });
  printer.finish();
  assert.equal(output, "\r\x1b[2KDownloading papers: 37%\n");
});
