import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
await mkdir("dist/desktop/renderer", { recursive: true });
await build({
  entryPoints: ["src/desktop/renderer/app.tsx"],
  bundle: true,
  outfile: "dist/desktop/renderer/app.js",
  platform: "browser",
  target: "chrome140",
  jsx: "automatic",
  sourcemap: true,
  minify: false,
});
await build({
  entryPoints: ["src/desktop/preload.ts"],
  bundle: true,
  outfile: "dist/desktop/preload.cjs",
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
await copyFile(
  "src/desktop/renderer/index.html",
  "dist/desktop/renderer/index.html",
);
