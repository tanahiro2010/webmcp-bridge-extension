import type {
  ContentToInjectedMessage,
  InjectedCallResultMessage,
  InjectedManifestMessage,
  ModelContext,
  ModelContextTool,
  WebMcpToolManifestDraft,
} from "./types.js";

// Runs in the page's MAIN world as a statically-declared content script (manifest.json's
// "world": "MAIN"), so unlike content.ts it can see document.modelContext directly. Talks
// to content.ts purely via window.postMessage, tagged with a channel id exchanged via a
// one-time handshake (see types.ts for why there's no script-src query string anymore).
//
// Detection/execution follows the real WebMCP spec (https://webmachinelearning.github.io/webmcp/):
// - imperative tools: document.modelContext.registerTool()
// - declarative tools: <form toolname tooldescription> annotated forms, which we synthesize
//   into document.modelContext tools ourselves (see form-to-tool section below).
// If the browser doesn't natively implement document.modelContext yet, we install a minimal
// polyfill so pages written against the real spec still work through this bridge.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// ---- document.modelContext polyfill (only installed if the browser has no native one) ----

class ModelContextPolyfill extends EventTarget implements ModelContext {
  #tools = new Map<string, ModelContextTool>();

  async registerTool(tool: ModelContextTool, options?: { signal?: AbortSignal }): Promise<undefined> {
    if (!tool || typeof tool.name !== "string" || tool.name.length === 0) {
      throw new Error("ModelContextTool.name must be a non-empty string");
    }
    if (typeof tool.description !== "string" || tool.description.length === 0) {
      throw new Error("ModelContextTool.description must be a non-empty string");
    }
    if (this.#tools.has(tool.name)) {
      throw new Error(`A tool named "${tool.name}" is already registered`);
    }
    this.#tools.set(tool.name, tool);
    this.dispatchEvent(new Event("toolchange"));

    options?.signal?.addEventListener("abort", () => {
      if (this.#tools.get(tool.name) === tool) {
        this.#tools.delete(tool.name);
        this.dispatchEvent(new Event("toolchange"));
      }
    });
    return undefined;
  }

  async getTools(): Promise<ModelContextTool[]> {
    // Single-document polyfill: no cross-origin frame aggregation (fromOrigins is ignored).
    return Array.from(this.#tools.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async executeTool(tool: ModelContextTool, jsonInput?: string): Promise<unknown> {
    const resolved = this.#tools.get(tool?.name);
    if (!resolved) throw new Error(`Unknown WebMCP tool: ${tool?.name}`);
    const input = jsonInput ? JSON.parse(jsonInput) : {};
    return resolved.execute(input);
  }
}

if (!document.modelContext) {
  document.modelContext = new ModelContextPolyfill();
  console.log("[webmcp:injected] no native document.modelContext found; installed a polyfill");
}

const modelContext: ModelContext = document.modelContext;

// ---- Declarative API: <form toolname tooldescription> -> a synthesized ModelContextTool ----
// Field-level mapping choices below follow the spec's documented parts (name -> property,
// toolparamdescription/label -> description, required -> required[], select -> enum) but the
// spec itself marks the exact algorithm for numeric constraints etc. as TBD - see README.

function findLabelText(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string | undefined {
  const label = el.labels?.[0];
  if (!label) return undefined;
  const clone = label.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("input, select, textarea, button, meter, output, progress").forEach((n) => n.remove());
  const text = clone.textContent?.trim();
  return text || undefined;
}

function describeField(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string | undefined {
  return el.getAttribute("toolparamdescription") ?? findLabelText(el);
}

function withDescription<T extends Record<string, unknown>>(schema: T, description: string | undefined): T {
  return description ? { ...schema, description } : schema;
}

function synthesizeSchemaFromForm(form: HTMLFormElement): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const handledNames = new Set<string>();

  for (const el of Array.from(form.elements)) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) continue;
    const name = el.name;
    if (!name || handledNames.has(name)) continue;

    if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
      const namedItem = form.elements.namedItem(name);
      const group = namedItem instanceof RadioNodeList ? Array.from(namedItem) : [el];
      const inputGroup = group.filter((g): g is HTMLInputElement => g instanceof HTMLInputElement);
      handledNames.add(name);

      if (el.type === "radio") {
        properties[name] = withDescription({ type: "string", enum: inputGroup.map((g) => g.value) }, describeField(el));
      } else if (inputGroup.length > 1) {
        properties[name] = withDescription(
          { type: "array", items: { type: "string", enum: inputGroup.map((g) => g.value) } },
          describeField(el),
        );
      } else {
        properties[name] = withDescription({ type: "boolean" }, describeField(el));
      }
      if (inputGroup.some((g) => g.required)) required.push(name);
      continue;
    }

    handledNames.add(name);
    if (el instanceof HTMLSelectElement) {
      const options = Array.from(el.options).map((o) => o.value);
      properties[name] = el.multiple
        ? withDescription({ type: "array", items: { type: "string", enum: options } }, describeField(el))
        : withDescription({ type: "string", enum: options }, describeField(el));
    } else if (el instanceof HTMLTextAreaElement) {
      properties[name] = withDescription({ type: "string" }, describeField(el));
    } else if (el.type === "number" || el.type === "range") {
      const schema: Record<string, unknown> = { type: "number" };
      if (el.min !== "") schema.minimum = Number(el.min);
      if (el.max !== "") schema.maximum = Number(el.max);
      if (el.step && el.step !== "any") schema.multipleOf = Number(el.step);
      properties[name] = withDescription(schema, describeField(el));
    } else {
      properties[name] = withDescription({ type: "string" }, describeField(el));
    }
    if (el.required) required.push(name);
  }

  return { type: "object", properties, required };
}

function findSubmitter(form: HTMLFormElement): HTMLButtonElement | HTMLInputElement | undefined {
  return (
    form.querySelector<HTMLButtonElement | HTMLInputElement>('button[type="submit"], input[type="submit"], button:not([type])') ??
    undefined
  );
}

function fillFormFields(form: HTMLFormElement, input: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(input)) {
    const namedItem = form.elements.namedItem(key);
    if (!namedItem) continue;

    const targets = namedItem instanceof RadioNodeList ? Array.from(namedItem) : [namedItem];
    for (const target of targets) {
      if (target instanceof HTMLInputElement && (target.type === "radio" || target.type === "checkbox")) {
        target.checked =
          target.type === "checkbox"
            ? Array.isArray(value)
              ? value.map(String).includes(target.value)
              : Boolean(value)
            : String(value) === target.value;
      } else if (target instanceof HTMLSelectElement) {
        if (target.multiple && Array.isArray(value)) {
          const values = value.map(String);
          for (const opt of Array.from(target.options)) opt.selected = values.includes(opt.value);
        } else {
          target.value = String(value);
        }
      } else if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        target.value = String(value);
      } else {
        continue;
      }
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
}

/**
 * Dispatches the form's own "submit" event ourselves (via requestSubmit) so we can tag that
 * specific SubmitEvent instance as agentInvoked and capture whatever the page passes to
 * SubmitEvent#respondWith(), per https://webmachinelearning.github.io/webmcp/declarative-api-explainer.md.
 * A capture-phase listener guarantees our tagging runs before the page's own (typically
 * bubble-phase) submit handler.
 */
function submitFormAsAgent(form: HTMLFormElement): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let capturedEvent: SubmitEvent | null = null;
    let capturedResponse: Promise<unknown> | null = null;

    const tagger = (event: Event) => {
      capturedEvent = event as SubmitEvent;
      try {
        Object.defineProperty(event, "agentInvoked", { value: true, configurable: true });
        Object.defineProperty(event, "respondWith", {
          configurable: true,
          value: (response: Promise<unknown> | unknown) => {
            capturedResponse = Promise.resolve(response);
          },
        });
      } catch (err) {
        console.error("[webmcp:injected] failed to tag SubmitEvent as agent-invoked", err);
      }
    };

    form.addEventListener("submit", tagger, { capture: true, once: true });
    try {
      form.requestSubmit(findSubmitter(form));
    } catch (err) {
      form.removeEventListener("submit", tagger, { capture: true });
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (!capturedEvent || !(capturedEvent as SubmitEvent).defaultPrevented) {
      resolve({ pending: true, message: "Form submitted natively; the page did not call preventDefault(), so no in-page result is available." });
      return;
    }
    if (!capturedResponse) {
      resolve({ pending: true, message: "The page intercepted the submission but never called SubmitEvent#respondWith()." });
      return;
    }
    // TS can't narrow a `let` that's only ever reassigned inside a nested closure (the
    // tagger above), even after the null-check just above - hence the explicit cast.
    (capturedResponse as Promise<unknown>).then(resolve, (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

async function executeFormTool(form: HTMLFormElement, input: Record<string, unknown>): Promise<unknown> {
  fillFormFields(form, input);
  window.dispatchEvent(new CustomEvent("toolactivated", { detail: { toolname: form.getAttribute("toolname") } }));

  if (!form.hasAttribute("toolautosubmit")) {
    findSubmitter(form)?.focus();
    return { pending: true, message: "Form filled; toolautosubmit is absent, so a human must review and submit it manually." };
  }
  return submitFormAsAgent(form);
}

type FormToolEntry = { name: string; controller: AbortController };
const formTools = new Map<HTMLFormElement, FormToolEntry>();

function isAnnotatedForm(form: HTMLFormElement): boolean {
  return form.hasAttribute("toolname") && form.hasAttribute("tooldescription");
}

/**
 * Looks up a live annotated form by tool name via a plain DOM query (no dependency on
 * whether *we* registered it). Some browsers (confirmed: Chrome for Testing 150) natively
 * auto-register annotated forms as tools themselves, in which case our own registerTool
 * call below is expected to fail as a duplicate - this lookup is what lets currentManifest()
 * still correctly report such tools as "declarative" even though we never registered them.
 */
function findAnnotatedFormByName(name: string): HTMLFormElement | undefined {
  for (const form of document.querySelectorAll<HTMLFormElement>("form[toolname][tooldescription]")) {
    if (form.getAttribute("toolname") === name) return form;
  }
  return undefined;
}

async function registerForm(form: HTMLFormElement): Promise<void> {
  const name = form.getAttribute("toolname");
  const description = form.getAttribute("tooldescription");
  if (!name || !description) return;

  const existing = await modelContext.getTools();
  if (existing.some((t) => t.name === name)) {
    // Expected on browsers with native declarative-form support: the browser already
    // registered this form itself. Not an error - just don't double-register.
    console.log(`[webmcp:injected] form tool "${name}" is already registered (likely by the browser natively); skipping our own registration`);
    return;
  }

  const controller = new AbortController();
  try {
    await modelContext.registerTool(
      {
        name,
        description,
        inputSchema: synthesizeSchemaFromForm(form),
        execute: (input) => executeFormTool(form, input),
      },
      { signal: controller.signal },
    );
    formTools.set(form, { name, controller });
  } catch (err) {
    // Benign race: the browser's own native form-registration can slip in between our
    // duplicate-check above and this call. Anything else is a real registration failure.
    const isDuplicate = err instanceof Error && /duplicate|already registered/i.test(err.message);
    if (isDuplicate) {
      console.log(`[webmcp:injected] form tool "${name}" was registered natively just before we could; skipping`);
    } else {
      console.error(`[webmcp:injected] failed to register form tool "${name}"`, err);
    }
  }
}

function unregisterForm(form: HTMLFormElement): void {
  const entry = formTools.get(form);
  if (!entry) return;
  entry.controller.abort();
  formTools.delete(form);
}

function rescanForms(): void {
  const currentForms = new Set(document.querySelectorAll<HTMLFormElement>("form[toolname][tooldescription]"));

  for (const form of Array.from(formTools.keys())) {
    if (!currentForms.has(form) || !isAnnotatedForm(form)) unregisterForm(form);
  }
  for (const form of currentForms) {
    const entry = formTools.get(form);
    if (entry && entry.name === form.getAttribute("toolname")) continue;
    if (entry) unregisterForm(form); // toolname changed since we registered it
    void registerForm(form);
  }
}

new MutationObserver(() => rescanForms()).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["toolname", "tooldescription"],
});
document.addEventListener("visibilitychange", rescanForms);
window.addEventListener("pageshow", rescanForms);
rescanForms();

// ---- Reporting the current tool manifest to content.ts, and executing calls ----

let CHANNEL: string | null = null;

type OutgoingMessage = Omit<InjectedManifestMessage, "channel"> | Omit<InjectedCallResultMessage, "channel">;

function postToContent(message: OutgoingMessage): void {
  if (!CHANNEL) return;
  console.log("[webmcp:injected] ->", message.type);
  // "*" rather than window.location.origin: see the matching comment in content.ts -
  // this is same-window main<->isolated world messaging, not cross-origin, and file://
  // pages have an opaque ("null") origin that makes origin-targeted postMessage brittle.
  window.postMessage({ ...message, channel: CHANNEL }, "*");
}

async function currentManifest(): Promise<WebMcpToolManifestDraft[]> {
  const origin = window.location.origin;
  const tools = await modelContext.getTools();
  return tools.map((tool) => {
    const form = findAnnotatedFormByName(tool.name);
    return {
      id: tool.name,
      name: tool.name,
      title: tool.title,
      description: tool.description,
      source: form ? "declarative" : "imperative",
      inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} },
      dangerous: tool.annotations?.readOnlyHint === false ? true : undefined,
      requiresUserGesture: form ? !form.hasAttribute("toolautosubmit") : undefined,
      origin,
    };
  });
}

let lastReportedIds = "";
async function reportManifestIfChanged(): Promise<void> {
  const tools = await currentManifest();
  const idsKey = tools
    .map((t) => t.id)
    .sort()
    .join(",");
  if (idsKey === lastReportedIds) return;
  lastReportedIds = idsKey;
  postToContent({ source: "webmcp-injected", type: "webmcp/manifest", tools });
}

modelContext.addEventListener("toolchange", () => void reportManifestIfChanged());

async function handleCall(requestId: string, toolId: string, args: Record<string, unknown> | undefined): Promise<void> {
  let ok = false;
  let result: unknown;
  let error: string | undefined;

  try {
    const tools = await modelContext.getTools();
    const tool = tools.find((t) => t.name === toolId);
    if (!tool) throw new Error(`Unknown WebMCP tool: ${toolId}`);
    result = await modelContext.executeTool(tool, JSON.stringify(args ?? {}));
    ok = true;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  postToContent({ source: "webmcp-injected", type: "webmcp/call_result", requestId, ok, result, error });
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data as ContentToInjectedMessage | undefined;
  if (!isRecord(data) || data.source !== "webmcp-content") return;

  if (data.type === "webmcp/handshake") {
    if (CHANNEL === null) {
      CHANNEL = data.channel;
      console.log("[webmcp:injected] <- handshake, channel locked");
      void reportManifestIfChanged();
    }
    return;
  }

  if (CHANNEL === null || data.channel !== CHANNEL) return;
  if (data.type === "webmcp/call") {
    console.log("[webmcp:injected] <- webmcp/call", data.toolId);
    void handleCall(data.requestId, data.toolId, data.args);
  }
});
