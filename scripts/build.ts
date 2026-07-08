import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { watch } from "node:fs";

const OUT_DIR = "dist";
const ENTRYPOINTS = ["src/background.ts", "src/content.ts", "src/injected.ts"];

async function build(): Promise<void> {
  const startedAt = Date.now();

  const result = await Bun.build({
    entrypoints: ENTRYPOINTS,
    outdir: OUT_DIR,
    format: "iife",
    target: "browser",
    naming: "[name].[ext]",
  });

  if (!result.success) {
    for (const message of result.logs) {
      console.error(message);
    }
    throw new Error("extension build failed");
  }

  await cp("manifest.json", `${OUT_DIR}/manifest.json`);
  if (existsSync("examples")) {
    await cp("examples", `${OUT_DIR}/examples`, { recursive: true });
  }

  console.log(`[build] wrote ${OUT_DIR}/ in ${Date.now() - startedAt}ms`);
}

async function main(): Promise<void> {
  const watchMode = process.argv.includes("--watch");

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  await build();

  if (!watchMode) return;

  console.log("[build] watching src/, manifest.json, examples/ for changes (reload the extension manually in chrome://extensions after each rebuild)");

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRebuild = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      build().catch((err) => console.error("[build] rebuild failed:", err));
    }, 150);
  };

  watch("src", { recursive: true }, scheduleRebuild);
  watch("manifest.json", scheduleRebuild);
  if (existsSync("examples")) {
    watch("examples", { recursive: true }, scheduleRebuild);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
