import type {
  BackgroundToContentMessage,
  ContentCallMessage,
  ContentToBackgroundMessage,
  HandshakeMessage,
  InjectedToContentMessage,
  WebMcpCallResponseMessage,
  WebMcpDiscoverResponseMessage,
  WebMcpToolManifestDraft,
} from "./types.js";

// Runs in the page's ISOLATED world: shares the DOM with the page but not its JS
// globals, so it cannot see document.modelContext directly. injected.ts runs
// alongside it in the "MAIN" world (declared statically in manifest.json) and the
// two talk purely over window.postMessage, guarded by a channel id exchanged via
// a one-time handshake (see types.ts for why - there's no shared script-src anymore).

const CHANNEL = crypto.randomUUID();

let cachedTools: WebMcpToolManifestDraft[] = [];
let overlayRoot: HTMLElement | null = null;
let overlayButton: HTMLButtonElement | null = null;
let handshakeAcked = false;

type PendingCall = {
  resolve: (value: WebMcpCallResponseMessage) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pendingCalls = new Map<string, PendingCall>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function log(...args: unknown[]): void {
  console.log("[webmcp:content]", ...args);
}

function sendHandshake(): void {
  if (handshakeAcked) return;
  const message: HandshakeMessage = { channel: CHANNEL, source: "webmcp-content", type: "webmcp/handshake" };
  log("-> handshake", CHANNEL);
  window.postMessage(message, "*");
}

function ensureOverlay(): void {
  if (overlayRoot) return;

  const host = document.createElement("div");
  host.id = "webmcp-bridge-overlay-host";
  host.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });

  const button = document.createElement("button");
  button.textContent = "WebMCPをインストール";
  button.style.cssText = [
    "font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    "padding: 8px 14px",
    "border-radius: 999px",
    "border: 1px solid rgba(0,0,0,0.15)",
    "background: #111827",
    "color: #fff",
    "box-shadow: 0 2px 10px rgba(0,0,0,0.2)",
    "cursor: pointer",
  ].join(";");
  button.addEventListener("click", onInstallClick);

  shadow.appendChild(button);
  document.documentElement.appendChild(host);

  overlayRoot = host;
  overlayButton = button;
}

function onInstallClick(): void {
  if (!overlayButton) return;
  overlayButton.textContent = "WebMCP installed";
  overlayButton.disabled = true;
  overlayButton.style.cursor = "default";
  overlayButton.style.opacity = "0.8";

  const message: ContentToBackgroundMessage = {
    type: "webmcp/install_clicked",
    url: window.location.href,
    title: document.title,
    origin: window.location.origin,
    tools: cachedTools,
  };
  chrome.runtime.sendMessage(message);
}

function handleInjectedMessage(event: MessageEvent): void {
  if (event.source !== window) return;
  const data = event.data as InjectedToContentMessage | undefined;
  if (!isRecord(data) || data.source !== "webmcp-injected") return;
  if (data.channel !== CHANNEL) {
    log("ignoring message on a different channel (not from our injected.ts instance)", data.type);
    return;
  }

  handshakeAcked = true;
  log("<-", data.type, data.type === "webmcp/manifest" ? data.tools.map((t) => t.id) : data.requestId);

  if (data.type === "webmcp/manifest") {
    cachedTools = data.tools;
    if (data.tools.length > 0) {
      ensureOverlay();
    }
    const message: ContentToBackgroundMessage = {
      type: "webmcp/detected",
      url: window.location.href,
      title: document.title,
      origin: window.location.origin,
      tools: data.tools,
    };
    chrome.runtime.sendMessage(message);
    return;
  }

  if (data.type === "webmcp/call_result") {
    const pending = pendingCalls.get(data.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingCalls.delete(data.requestId);
    pending.resolve({ ok: data.ok, result: data.result, error: data.error });
  }
}

function callInjectedTool(toolId: string, args: Record<string, unknown> | undefined): Promise<WebMcpCallResponseMessage> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(requestId);
      resolve({ ok: false, error: "TOOL_CALL_TIMEOUT" });
    }, 15_000);
    pendingCalls.set(requestId, { resolve, timer });

    const message: ContentCallMessage = {
      channel: CHANNEL,
      source: "webmcp-content",
      type: "webmcp/call",
      requestId,
      toolId,
      args,
    };
    // "*" rather than window.location.origin: main<->isolated world messaging is not
    // cross-origin (both worlds see the same document), and file:// pages have an opaque
    // ("null") origin that would otherwise make origin-targeted postMessage brittle here.
    // The channel id is what actually guards against unrelated page scripts.
    window.postMessage(message, "*");
  });
}

chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage, _sender, sendResponse) => {
  if (message.type === "webmcp/discover_request") {
    const response: WebMcpDiscoverResponseMessage = { tools: cachedTools };
    sendResponse(response);
    return false;
  }
  if (message.type === "webmcp/call_request") {
    callInjectedTool(message.toolId, message.args).then(sendResponse);
    return true; // keep the message channel open for the async sendResponse
  }
  return false;
});

window.addEventListener("message", handleInjectedMessage);

// injected.ts (MAIN world) may start before or after this script depending on the
// browser's internal scheduling, so retry the handshake a few times rather than
// assuming a single postMessage arrives after its listener is attached.
sendHandshake();
for (const delay of [50, 150, 400, 1000]) {
  setTimeout(sendHandshake, delay);
}
