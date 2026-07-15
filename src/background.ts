import type {
  BackgroundToContentMessage,
  BridgeEvent,
  BridgeEventName,
  BridgeRequest,
  BridgeResponse,
  ContentToBackgroundMessage,
  TabInfo,
  WebMcpCallResponseMessage,
  WebMcpDiscoverResponseMessage,
  WebMcpToolManifest,
  WebMcpToolManifestDraft,
} from "./types.js";

// Service worker: owns the WebSocket connection to webmcp-bridge-mcp, tracks tabs,
// and routes bridge requests to the right tab's content script. Never touches the
// DOM itself - that's content.ts/injected.ts's job.

// Must match webmcp-bridge-mcp's own default WS_PORT (see that project's src/index.ts) -
// deliberately not 8787, which collides with `wrangler dev`'s default port.
const WS_URL = "ws://127.0.0.1:58787";
const RECONNECT_DELAY_MS = 3_000;

let socket: WebSocket | null = null;
const tabs = new Map<number, TabInfo>();
let activeTabId: number | undefined;

function log(...args: unknown[]): void {
  console.log("[webmcp:background]", ...args);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeOrigin(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

class BridgeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ---- WebSocket connection ----

function sendEvent(event: BridgeEventName, payload?: unknown): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const message: BridgeEvent = { kind: "event", event, payload };
  log("-> event", event, payload);
  socket.send(JSON.stringify(message));
}

// A live WebSocket keeps an MV3 service worker from being suspended for
// inactivity (Chrome resets the idle timer while a WebSocket is open), so no
// chrome.alarms keep-alive hack is needed here. If Chrome does terminate this
// worker anyway (extension reload, browser restart), the "close" handler below
// re-runs connect() the next time the worker wakes up.
function connect(): void {
  log("connecting to", WS_URL);
  const ws = new WebSocket(WS_URL);
  socket = ws;

  ws.addEventListener("open", () => {
    log("connected to webmcp-bridge-mcp");
    sendEvent("extension/hello", { version: chrome.runtime.getManifest().version });
    // The server wipes its whole TabRegistry on every disconnect (see webmcp-bridge-mcp's
    // wsServer.onDisconnect), but this service worker's own `tabs`/`activeTabId` state
    // survives across reconnects. Without an explicit resync here, a server that starts
    // (or restarts) *after* the extension already detected/installed tools on a tab would
    // stay empty until some unrelated new browser event (tab switch, navigation, ...)
    // happened to fire - which can be a long wait, and makes clicking "install" before the
    // agent/server is up look like it silently did nothing.
    void recomputeActiveTab(true);
    void resyncKnownTabs();
  });

  ws.addEventListener("message", (event) => {
    void handleServerMessage(String(event.data));
  });

  ws.addEventListener("close", () => {
    log(`disconnected, retrying in ${RECONNECT_DELAY_MS}ms`);
    socket = null;
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.addEventListener("error", (event) => {
    log("socket error", event);
  });
}

function isBridgeRequest(value: unknown): value is BridgeRequest {
  return isRecord(value) && value.kind === "request" && typeof value.id === "string" && typeof value.method === "string";
}

async function handleServerMessage(raw: string): Promise<void> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    console.error("[webmcp:background] malformed JSON from server", err);
    return;
  }

  if (!isBridgeRequest(json)) {
    console.error("[webmcp:background] unexpected frame from server", json);
    return;
  }

  log("<- request", json.method, json.id);
  const response = await routeRequest(json);
  log("-> response", response.id, "ok=" + response.ok);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(response));
  }
}

function errorResponse(id: string, code: string, message: string): BridgeResponse {
  return { kind: "response", id, ok: false, error: { code, message } };
}

function resolveTabId(explicit: unknown): number | undefined {
  return typeof explicit === "number" ? explicit : activeTabId;
}

function stampTabId(draft: WebMcpToolManifestDraft, tabId: number): WebMcpToolManifest {
  return { ...draft, tabId };
}

async function sendToTab<T>(tabId: number, message: BackgroundToContentMessage): Promise<T> {
  try {
    await chrome.tabs.get(tabId);
  } catch {
    throw new BridgeError("TAB_NOT_FOUND", `No such tab: ${tabId}`);
  }

  let response: T | undefined;
  try {
    response = (await chrome.tabs.sendMessage(tabId, message)) as T | undefined;
  } catch (err) {
    throw new BridgeError(
      "CONTENT_SCRIPT_UNREACHABLE",
      `Could not reach the content script on tab ${tabId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (response === undefined) {
    throw new BridgeError("CONTENT_SCRIPT_UNREACHABLE", `Content script on tab ${tabId} did not respond.`);
  }
  return response;
}

async function routeRequest(request: BridgeRequest): Promise<BridgeResponse> {
  try {
    switch (request.method) {
      case "ping": {
        return { kind: "response", id: request.id, ok: true, result: { ok: true } };
      }

      case "tabs/list": {
        return { kind: "response", id: request.id, ok: true, result: { tabs: Array.from(tabs.values()) } };
      }

      case "tab/discover_tools": {
        const params = request.params;
        const tabId = resolveTabId(isRecord(params) ? params.tabId : undefined);
        if (tabId === undefined) {
          return errorResponse(request.id, "NO_ACTIVE_TAB", "No tabId given and no active tab is known yet.");
        }
        const draftResponse = await sendToTab<WebMcpDiscoverResponseMessage>(tabId, { type: "webmcp/discover_request" });
        const tools = draftResponse.tools.map((tool) => stampTabId(tool, tabId));
        upsertTabInfo(tabId, { toolsCount: tools.length });
        return { kind: "response", id: request.id, ok: true, result: { tabId, tools } };
      }

      case "tool/call": {
        const params = request.params;
        if (!isRecord(params) || typeof params.toolId !== "string") {
          return errorResponse(request.id, "INVALID_PARAMS", "toolId is required.");
        }
        const tabId = resolveTabId(params.tabId);
        if (tabId === undefined) {
          return { kind: "response", id: request.id, ok: true, result: { ok: false, error: "No tabId given and no active tab is known yet." } };
        }
        const args = isRecord(params.args) ? (params.args as Record<string, unknown>) : undefined;
        const result = await sendToTab<WebMcpCallResponseMessage>(tabId, {
          type: "webmcp/call_request",
          toolId: params.toolId,
          args,
        });
        return { kind: "response", id: request.id, ok: true, result };
      }

      case "tool/submit": {
        const params = request.params;
        if (!isRecord(params) || typeof params.toolId !== "string") {
          return errorResponse(request.id, "INVALID_PARAMS", "toolId is required.");
        }
        const tabId = resolveTabId(params.tabId);
        if (tabId === undefined) {
          return { kind: "response", id: request.id, ok: true, result: { ok: false, error: "No tabId given and no active tab is known yet." } };
        }
        const result = await sendToTab<WebMcpCallResponseMessage>(tabId, {
          type: "webmcp/submit_request",
          toolId: params.toolId,
        });
        return { kind: "response", id: request.id, ok: true, result };
      }

      default:
        return errorResponse(request.id, "UNKNOWN_METHOD", `Unknown method: ${String(request.method)}`);
    }
  } catch (err) {
    if (err instanceof BridgeError) {
      return errorResponse(request.id, err.code, err.message);
    }
    return errorResponse(request.id, "INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
  }
}

// ---- Tab tracking ----

function upsertTabInfo(tabId: number, patch: Partial<Omit<TabInfo, "tabId">>): TabInfo {
  const existing = tabs.get(tabId);
  const merged: TabInfo = {
    tabId,
    url: patch.url ?? existing?.url ?? "",
    title: patch.title ?? existing?.title ?? "",
    origin: patch.origin ?? existing?.origin ?? "",
    active: patch.active ?? existing?.active ?? false,
    installed: patch.installed ?? existing?.installed ?? false,
    toolsCount: patch.toolsCount ?? existing?.toolsCount ?? 0,
    lastSeenAt: Date.now(),
  };
  tabs.set(tabId, merged);
  return merged;
}

// Re-announces every tab we already know about to a freshly (re)connected server - see
// the comment at the "open" handler in connect() for why this is necessary. Content
// scripts keep their own per-tab manifest cache (see content.ts), so this is a cheap,
// synchronous-on-the-page-side re-query rather than a live re-scan of the DOM.
async function resyncKnownTabs(): Promise<void> {
  for (const [tabId, info] of tabs) {
    let tools: WebMcpToolManifest[];
    try {
      const message: BackgroundToContentMessage = { type: "webmcp/discover_request" };
      const response = (await chrome.tabs.sendMessage(tabId, message)) as WebMcpDiscoverResponseMessage | undefined;
      if (!response) continue;
      tools = response.tools.map((tool) => stampTabId(tool, tabId));
    } catch {
      continue; // no content script here anymore (tab closed/navigated/chrome:// page) - drop it silently
    }

    upsertTabInfo(tabId, { toolsCount: tools.length });
    sendEvent(info.installed ? "tab/webmcp_installed" : "tab/webmcp_detected", {
      tabId,
      url: info.url,
      title: info.title,
      origin: info.origin,
      active: info.active,
      installed: info.installed,
      tools,
    });
  }
}

// "Active tab" = the active tab of the currently focused browser window.
// `force` re-announces the active tab even if it's the same tabId we already had -
// needed right after a (re)connect, since the server-side registry may have just been
// wiped clean even though our local `activeTabId` didn't change.
async function recomputeActiveTab(force = false): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || tab.id === undefined) return;
    if (!force && activeTabId === tab.id) return;

    for (const [id, info] of tabs) {
      if (id !== tab.id && info.active) tabs.set(id, { ...info, active: false });
    }

    activeTabId = tab.id;
    const info = upsertTabInfo(tab.id, {
      url: tab.url ?? "",
      title: tab.title ?? "",
      origin: safeOrigin(tab.url),
      active: true,
    });
    sendEvent("tab/active_changed", { tabId: info.tabId, url: info.url, title: info.title, origin: info.origin });
  } catch (err) {
    console.error("[webmcp:background] failed to recompute active tab", err);
  }
}

chrome.windows.onFocusChanged.addListener(() => void recomputeActiveTab());
chrome.tabs.onActivated.addListener(() => void recomputeActiveTab());

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    // Navigation: installed is session-only and resets per tab (see design review #1).
    upsertTabInfo(tabId, { url: changeInfo.url, origin: safeOrigin(changeInfo.url), installed: false, toolsCount: 0 });
  }
  if (changeInfo.status === "complete" && tab.active) {
    void recomputeActiveTab();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  if (activeTabId === tabId) activeTabId = undefined;
  sendEvent("tab/webmcp_removed", { tabId });
});

chrome.runtime.onMessage.addListener((message: ContentToBackgroundMessage, sender) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  if (message.type === "webmcp/detected") {
    const info = upsertTabInfo(tabId, {
      url: message.url,
      title: message.title,
      origin: message.origin,
      toolsCount: message.tools.length,
    });
    sendEvent("tab/webmcp_detected", {
      tabId,
      url: info.url,
      title: info.title,
      origin: info.origin,
      active: info.active,
      installed: info.installed,
      tools: message.tools.map((tool) => stampTabId(tool, tabId)),
    });
    return;
  }

  if (message.type === "webmcp/install_clicked") {
    const info = upsertTabInfo(tabId, {
      url: message.url,
      title: message.title,
      origin: message.origin,
      installed: true,
      toolsCount: message.tools.length,
    });
    sendEvent("tab/webmcp_installed", {
      tabId,
      url: info.url,
      title: info.title,
      origin: info.origin,
      active: info.active,
      installed: true,
      tools: message.tools.map((tool) => stampTabId(tool, tabId)),
    });
  }
});

connect();
