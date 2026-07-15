// ---- WebMCP spec types (https://webmachinelearning.github.io/webmcp/) ----
//
// document.modelContext is a brand-new, still-draft browser API (W3C Web Machine
// Learning CG, draft as of Feb 2026) not yet in TypeScript's lib.dom.d.ts, so we
// declare the shapes we rely on ourselves, verified against the spec and Chrome's
// developer docs (developer.chrome.com/docs/ai/webmcp) rather than guessed.

export type ModelContextToolAnnotations = {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
};

export type ModelContextTool = {
  name: string;
  description: string;
  title?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: ModelContextToolAnnotations;
  execute: (input: Record<string, unknown>) => unknown;
};

export type ModelContextRegisterToolOptions = {
  signal?: AbortSignal;
  exposedTo?: string[];
};

export type ModelContextGetToolsOptions = {
  fromOrigins?: string[];
};

export interface ModelContext extends EventTarget {
  registerTool(tool: ModelContextTool, options?: ModelContextRegisterToolOptions): Promise<undefined>;
  /**
   * Confirmed async (returns Promise<ModelContextTool[]>) against a real native
   * implementation (Chrome for Testing 150) - NOT synchronous as an earlier read of
   * Chrome's docs summary suggested. Also confirmed executeTool() requires the actual
   * tool object from getTools(), not a bare name string (throws otherwise).
   */
  getTools(options?: ModelContextGetToolsOptions): Promise<ModelContextTool[]>;
  executeTool(tool: ModelContextTool, jsonInput?: string, options?: { signal?: AbortSignal }): Promise<unknown>;
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }

  interface SubmitEvent {
    agentInvoked?: boolean;
    respondWith?: (response: Promise<unknown> | unknown) => void;
  }
}

// ---- Shared WebMCP domain types (mirrors webmcp-bridge-mcp/src/types.ts) ----

export type WebMcpToolManifest = {
  id: string;
  name: string;
  title?: string;
  description?: string;
  /**
   * "imperative" = registered via document.modelContext.registerTool().
   * "declarative" = synthesized by us from an annotated <form toolname tooldescription>,
   * per https://webmachinelearning.github.io/webmcp/ - NOT the old (wrong) application/webmcp+json
   * convention this project used before verifying the real spec.
   */
  source: "imperative" | "declarative";
  inputSchema: Record<string, unknown>;
  /**
   * Our own bridge-level heuristics, not 1:1 WebMCP spec fields:
   * - dangerous: derived from annotations.readOnlyHint === false (imperative tools only; unset if unknown).
   * - requiresUserGesture: for declarative tools, this is exactly `!form.hasAttribute("toolautosubmit")`
   *   (the spec has no imperative-side equivalent, so it's left unset there).
   */
  dangerous?: boolean;
  requiresUserGesture?: boolean;
  origin: string;
  tabId: number;
};

/**
 * Neither injected.ts (page main world) nor content.ts (isolated world) know
 * their own chrome.tabs id - only background.ts does, via chrome.runtime.onMessage's
 * `sender.tab.id`. So tools are carried without `tabId` until background stamps it
 * on right before forwarding to the MCP server.
 */
export type WebMcpToolManifestDraft = Omit<WebMcpToolManifest, "tabId">;

export type TabInfo = {
  tabId: number;
  url: string;
  title: string;
  origin: string;
  active: boolean;
  installed: boolean;
  toolsCount: number;
  lastSeenAt: number;
};

// ---- Bridge wire protocol (background.ts <-> webmcp-bridge-mcp over WebSocket) ----

export type BridgeRequestMethod = "tabs/list" | "tab/discover_tools" | "tool/call" | "tool/submit" | "ping";

export type BridgeEventName =
  | "extension/hello"
  | "tab/active_changed"
  | "tab/webmcp_detected"
  | "tab/webmcp_installed"
  | "tab/webmcp_removed";

export type BridgeRequest = {
  kind: "request";
  id: string;
  method: BridgeRequestMethod;
  params?: unknown;
};

export type BridgeResponse = {
  kind: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
};

export type BridgeEvent = {
  kind: "event";
  event: BridgeEventName;
  payload?: unknown;
};

// ---- chrome.runtime messages (content.ts <-> background.ts) ----

export type WebMcpDetectedMessage = {
  type: "webmcp/detected";
  url: string;
  title: string;
  origin: string;
  tools: WebMcpToolManifestDraft[];
};

export type WebMcpInstallClickedMessage = {
  type: "webmcp/install_clicked";
  url: string;
  title: string;
  origin: string;
  tools: WebMcpToolManifestDraft[];
};

export type WebMcpDiscoverRequestMessage = {
  type: "webmcp/discover_request";
};

export type WebMcpDiscoverResponseMessage = {
  tools: WebMcpToolManifestDraft[];
};

export type WebMcpCallRequestMessage = {
  type: "webmcp/call_request";
  toolId: string;
  args?: Record<string, unknown>;
};

export type WebMcpCallResponseMessage = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

/**
 * Confirms submission of a declarative tool that was previously filled via
 * "webmcp/call_request" and came back pending (no toolautosubmit, so the spec requires an
 * actual human click before it submits). This lets an MCP client explicitly override that
 * wait instead of a human clicking the button - see the "webmcp_submit_tool" MCP tool.
 * Has no effect on imperative tools or on toolautosubmit forms (those already submitted as
 * part of the original call).
 */
export type WebMcpSubmitRequestMessage = {
  type: "webmcp/submit_request";
  toolId: string;
};

export type ContentToBackgroundMessage = WebMcpDetectedMessage | WebMcpInstallClickedMessage;
export type BackgroundToContentMessage = WebMcpDiscoverRequestMessage | WebMcpCallRequestMessage | WebMcpSubmitRequestMessage;

// ---- window.postMessage protocol (content.ts <-> injected.ts, main<->isolated world) ----
//
// Both scripts are now declared statically in manifest.json (content.ts in the isolated
// world, injected.ts in the "MAIN" world) rather than one dynamically injecting the other,
// so there's no script-src query string to carry a channel id anymore. Instead content.ts
// sends a one-time handshake carrying a random channel id, and injected.ts locks onto the
// first one it sees. Low-stakes for a personal-use prototype (see root READMEs).

export type HandshakeMessage = {
  channel: string;
  source: "webmcp-content";
  type: "webmcp/handshake";
};

export type InjectedManifestMessage = {
  channel: string;
  source: "webmcp-injected";
  type: "webmcp/manifest";
  tools: WebMcpToolManifestDraft[];
};

export type InjectedCallResultMessage = {
  channel: string;
  source: "webmcp-injected";
  type: "webmcp/call_result";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type ContentCallMessage = {
  channel: string;
  source: "webmcp-content";
  type: "webmcp/call";
  requestId: string;
  toolId: string;
  args?: Record<string, unknown>;
};

export type ContentSubmitMessage = {
  channel: string;
  source: "webmcp-content";
  type: "webmcp/submit";
  requestId: string;
  toolId: string;
};

export type InjectedSubmitResultMessage = {
  channel: string;
  source: "webmcp-injected";
  type: "webmcp/submit_result";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type InjectedToContentMessage = InjectedManifestMessage | InjectedCallResultMessage | InjectedSubmitResultMessage;
export type ContentToInjectedMessage = HandshakeMessage | ContentCallMessage | ContentSubmitMessage;
