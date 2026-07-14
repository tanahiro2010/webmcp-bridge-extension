import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EXTENSION_PATH, textOf, waitForExtensionConnected, waitForTab } from "./fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_PROJECT_DIR = path.resolve(HERE, "..", "..", "webmcp-bridge-mcp");
const fixtureUrl = (name: string) => `file://${path.join(HERE, "fixtures", name)}`;

/**
 * Reproduces the real-world sequencing that tests/fixtures.ts deliberately avoids (see its
 * `context` fixture comment): the browser/extension is used *before* the MCP server (the
 * "agent") exists at all, then the server starts afterwards. Without background.ts's
 * reconnect resync (recomputeActiveTab(true) + resyncKnownTabs() on WS "open"), the
 * just-started server's registry would stay empty forever - clicking "install" on the
 * overlay before the agent is up would look like it silently did nothing.
 */
test("a tab detected before the MCP server exists is still discoverable once the server starts", async () => {
  const context = await chromium.launchPersistentContext("", {
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  try {
    const page = await context.newPage();
    await page.goto(fixtureUrl("imperative-only.html"));

    // Give the extension's first (doomed) connection attempt a moment to fail, so this
    // genuinely exercises the *reconnect* path rather than the initial connect.
    await page.waitForTimeout(500);

    const transport = new StdioClientTransport({ command: "bun", args: ["run", "src/index.ts"], cwd: MCP_PROJECT_DIR });
    const mcpClient = new Client({ name: "playwright-reconnect-test", version: "0.0.1" });
    await mcpClient.connect(transport);

    try {
      await waitForExtensionConnected(mcpClient);
      const tab = await waitForTab(mcpClient); // fails (times out) without the resync fix

      const discovered = textOf(
        await mcpClient.callTool({ name: "webmcp_discover_tools", arguments: { tabId: tab.tabId, forceRefresh: true } }),
      );
      const tool = discovered.tools.find((t: any) => t.id === "imp_only");
      expect(tool?.source).toBe("imperative");
    } finally {
      await mcpClient.close();
    }
  } finally {
    await context.close();
  }
});
