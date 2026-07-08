import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, textOf, unwrap, waitForExtensionConnected, waitForTab } from "./fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixtureUrl = (name: string) => `file://${path.join(HERE, "fixtures", name)}`;

async function overlayText(page: import("@playwright/test").Page): Promise<string | null> {
  return page.evaluate(() => {
    const host = document.getElementById("webmcp-bridge-overlay-host");
    return host?.shadowRoot?.querySelector("button")?.textContent ?? null;
  });
}

test.describe("imperative-only page", () => {
  test("discovers and executes an imperative-only tool", async ({ context, mcpClient }) => {
    const page = await context.newPage();
    await page.goto(fixtureUrl("imperative-only.html"));

    await waitForExtensionConnected(mcpClient);
    const tab = await waitForTab(mcpClient);

    const discovered = textOf(await mcpClient.callTool({ name: "webmcp_discover_tools", arguments: { tabId: tab.tabId, forceRefresh: true } }));
    const impOnly = discovered.tools.find((t: any) => t.id === "imp_only");
    expect(impOnly?.source).toBe("imperative");

    await expect.poll(() => overlayText(page)).toBe("WebMCPをインストール");

    const resultRaw = textOf(await mcpClient.callTool({ name: "webmcp_call_tool", arguments: { tabId: tab.tabId, toolId: "imp_only", args: { n: 21 } } }));
    expect(resultRaw.ok).toBe(true);
    expect(unwrap(resultRaw.result)).toMatchObject({ ok: true, doubled: 42 });
  });
});

test.describe("declarative-only page", () => {
  test("discovers and executes a declarative-only tool (fill + submit + respondWith)", async ({ context, mcpClient }) => {
    const page = await context.newPage();
    await page.goto(fixtureUrl("declarative-only.html"));

    await waitForExtensionConnected(mcpClient);
    const tab = await waitForTab(mcpClient);

    const discovered = textOf(await mcpClient.callTool({ name: "webmcp_discover_tools", arguments: { tabId: tab.tabId, forceRefresh: true } }));
    const declOnly = discovered.tools.find((t: any) => t.id === "decl_only");
    expect(declOnly?.source).toBe("declarative");

    await expect.poll(() => overlayText(page)).toBe("WebMCPをインストール");

    const resultRaw = textOf(await mcpClient.callTool({ name: "webmcp_call_tool", arguments: { tabId: tab.tabId, toolId: "decl_only", args: { word: "hello" } } }));
    expect(resultRaw.ok).toBe(true);
    expect(unwrap(resultRaw.result)).toMatchObject({ ok: true, echo: "hello" });

    await expect(page.locator('input[name="word"]')).toHaveValue("hello");
  });
});

test.describe("mixed imperative + declarative page", () => {
  test("both coexist and are independently discoverable/callable", async ({ context, mcpClient }) => {
    const page = await context.newPage();
    await page.goto(fixtureUrl("mixed.html"));

    await waitForExtensionConnected(mcpClient);
    const tab = await waitForTab(mcpClient);

    const discovered = textOf(await mcpClient.callTool({ name: "webmcp_discover_tools", arguments: { tabId: tab.tabId, forceRefresh: true } }));
    const byId = Object.fromEntries(discovered.tools.map((t: any) => [t.id, t]));
    expect(byId.imp_tool?.source).toBe("imperative");
    expect(byId.decl_tool?.source).toBe("declarative");

    const impRaw = textOf(await mcpClient.callTool({ name: "webmcp_call_tool", arguments: { tabId: tab.tabId, toolId: "imp_tool", args: { n: 10 } } }));
    expect(unwrap(impRaw.result)).toMatchObject({ ok: true, doubled: 20 });

    const declRaw = textOf(await mcpClient.callTool({ name: "webmcp_call_tool", arguments: { tabId: tab.tabId, toolId: "decl_tool", args: { word: "mix" } } }));
    expect(unwrap(declRaw.result)).toMatchObject({ ok: true, echo: "mix" });
  });
});

test.describe("dynamic tool add/remove interaction", () => {
  test("calling one tool reveals and hides other tools", async ({ context, mcpClient }) => {
    const page = await context.newPage();
    await page.goto(fixtureUrl("dynamic-interaction.html"));

    await waitForExtensionConnected(mcpClient);
    const tab = await waitForTab(mcpClient);

    const before = textOf(await mcpClient.callTool({ name: "webmcp_discover_tools", arguments: { tabId: tab.tabId, forceRefresh: true } }));
    const beforeIds = new Set(before.tools.map((t: any) => t.id));
    expect(beforeIds.has("unlock")).toBe(true);
    expect(beforeIds.has("lock")).toBe(true);
    expect(beforeIds.has("secret_imperative")).toBe(false);
    expect(beforeIds.has("secret_form")).toBe(false);

    const unlockRaw = textOf(await mcpClient.callTool({ name: "webmcp_call_tool", arguments: { tabId: tab.tabId, toolId: "unlock" } }));
    expect(unwrap(unlockRaw.result)).toMatchObject({ ok: true, unlocked: true });

    const afterUnlock = await expect
      .poll(async () => {
        const r = textOf(await mcpClient.callTool({ name: "webmcp_discover_tools", arguments: { tabId: tab.tabId, forceRefresh: true } }));
        return r.tools.map((t: any) => t.id).sort();
      })
      .toEqual(expect.arrayContaining(["secret_imperative", "secret_form"]));
    void afterUnlock;

    const secretImpRaw = textOf(await mcpClient.callTool({ name: "webmcp_call_tool", arguments: { tabId: tab.tabId, toolId: "secret_imperative" } }));
    expect(unwrap(secretImpRaw.result)).toMatchObject({ ok: true, secret: 42 });

    const secretFormRaw = textOf(await mcpClient.callTool({ name: "webmcp_call_tool", arguments: { tabId: tab.tabId, toolId: "secret_form", args: { q: "treasure" } } }));
    expect(unwrap(secretFormRaw.result)).toMatchObject({ ok: true, secretQuery: "treasure" });

    const lockRaw = textOf(await mcpClient.callTool({ name: "webmcp_call_tool", arguments: { tabId: tab.tabId, toolId: "lock" } }));
    expect(unwrap(lockRaw.result)).toMatchObject({ ok: true, locked: true });

    await expect
      .poll(async () => {
        const r = textOf(await mcpClient.callTool({ name: "webmcp_discover_tools", arguments: { tabId: tab.tabId, forceRefresh: true } }));
        return r.tools.map((t: any) => t.id);
      })
      .not.toEqual(expect.arrayContaining(["secret_imperative", "secret_form"]));

    const callAfterLockRaw = textOf(await mcpClient.callTool({ name: "webmcp_call_tool", arguments: { tabId: tab.tabId, toolId: "secret_imperative" } }));
    expect(callAfterLockRaw.ok).toBe(false);
  });
});
