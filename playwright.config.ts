import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  fullyParallel: false, // each test spawns its own MCP server on the same fixed WS_PORT
  workers: 1,
  reporter: [["list"]],
});
