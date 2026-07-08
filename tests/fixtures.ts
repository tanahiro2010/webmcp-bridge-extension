import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, chromium, type BrowserContext } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXTENSION_PATH = path.resolve(HERE, "..", "dist");
const MCP_PROJECT_DIR = path.resolve(HERE, "..", "..", "webmcp-bridge-mcp");

type Fixtures = {
  mcpClient: Client;
  context: BrowserContext;
};

/**
 * "Mocks the agent": a real @modelcontextprotocol/sdk Client, scripted instead of
 * driven by an LLM, talking to a real spawned webmcp-bridge-mcp server over real
 * stdio - exactly what Antigravity CLI (or any MCP client) would do.
 *
 * `context` explicitly depends on `mcpClient` so the WebSocket server is guaranteed
 * up *before* the extension-loaded browser launches - otherwise background.ts's very
 * first connection attempt could race the server's own startup.
 */
export const test = base.extend<Fixtures>({
  mcpClient: async ({}, use) => {
    const transport = new StdioClientTransport({ command: "bun", args: ["run", "src/index.ts"], cwd: MCP_PROJECT_DIR });
    const client = new Client({ name: "playwright-test", version: "0.0.1" });
    await client.connect(transport);
    await use(client);
    await client.close();
  },

  context: async ({ mcpClient }, use) => {
    void mcpClient; // ordering dependency only - see comment above
    const context = await chromium.launchPersistentContext("", {
      headless: false, // MV3 extensions are unreliable (or unsupported) in headless Chromium
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    await use(context);
    await context.close();
  },
});

export { expect } from "@playwright/test";

export function textOf(result: any): any {
  const item = result?.content?.[0];
  return item && item.type === "text" && item.text ? JSON.parse(item.text) : undefined;
}

export function unwrap(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function waitForExtensionConnected(mcpClient: Client, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = textOf(await mcpClient.callTool({ name: "webmcp_get_status", arguments: {} }));
    if (status.extensionConnected) return;
    if (Date.now() > deadline) throw new Error("extension never connected to the MCP server within " + timeoutMs + "ms");
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function waitForTab(mcpClient: Client, timeoutMs = 10_000): Promise<{ tabId: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tabsList = textOf(await mcpClient.callTool({ name: "webmcp_list_tabs", arguments: {} }));
    const tab = tabsList.tabs?.[0];
    if (tab) return tab;
    if (Date.now() > deadline) throw new Error("no tab reported within " + timeoutMs + "ms");
    await new Promise((r) => setTimeout(r, 200));
  }
}
