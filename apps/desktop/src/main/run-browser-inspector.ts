import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { nativeImage, type WebContents } from "electron";
import type {
  RunBrowserBounds,
  RunBrowserElementCapture,
  RunBrowserElementLocator,
  RunBrowserElementSummary,
  RunBrowserFrameworkHint,
  RunBrowserLocatorSegment,
  RunBrowserInput,
} from "@buildwarden/shared";

const INSPECTOR_PROTOCOL_VERSION = "1.3";
const CAPTURE_TTL_MS = 2 * 60_000;
const MAX_CAPTURE_COUNT = 8;
const MAX_SCREENSHOT_WIDTH = 1_600;
const MAX_SCREENSHOT_HEIGHT = 1_200;
const SENSITIVE_NAME = /token|secret|auth|key|session|password/i;

type CdpValueResult<T> = { result?: { value?: T; objectId?: string } };
type CdpAxValue = { value?: string };
type CdpAxNode = { role?: CdpAxValue; name?: CdpAxValue };

type PageElementData = {
  locatorSegments: RunBrowserLocatorSegment[];
  fallback: string;
  tagName: string;
  visibleText: string;
  sanitizedHtml: string;
  attributes: Record<string, string>;
  computedStyles: Record<string, string>;
  ancestry: string[];
  frameworkHints: RunBrowserFrameworkHint[];
  bounds: RunBrowserBounds;
  url: string;
  title: string;
};

type CachedCapture = { capture: RunBrowserElementCapture; expiresAt: number };

export interface RunBrowserInspectorOptions {
  runId: string;
  webContents: WebContents;
  onInspectingChange: (inspecting: boolean) => void;
  onSelection: (captureId: string, summary: RunBrowserElementSummary) => void;
  onError: (message: string, recoverable: boolean) => void;
}

const PAGE_COLLECTOR_SOURCE = String.raw`function (finderSource) {
  if (!globalThis.__buildwardenFinder) {
    (0, eval)(finderSource);
  }
  const find = globalThis.__buildwardenFinder;
  const sensitive = /token|secret|auth|key|session|password/i;
  const volatile = (value) => {
    const text = String(value || "");
    return /^\d/.test(text) || /[a-f0-9]{12,}/i.test(text) || /(?:^|[-_])(?:css|sc|ng|jsx|ember|chakra|mui)[-_]?[a-z]*\d{3,}/i.test(text);
  };
  const safeUrl = (value) => {
    try {
      const parsed = new URL(value, location.href);
      parsed.username = "";
      parsed.password = "";
      for (const key of [...parsed.searchParams.keys()]) {
        if (sensitive.test(key)) parsed.searchParams.set(key, "[REDACTED]");
      }
      return parsed.toString();
    } catch {
      return String(value || "").slice(0, 2048);
    }
  };
  const options = (root) => ({
    root,
    timeoutMs: 250,
    idName: (value) => !volatile(value),
    className: (value) => !volatile(value),
    tagName: () => true,
    attr: (name, value) => !sensitive.test(name) && !/^on/i.test(name) && !volatile(value) && /^(?:role|name|aria-|data-)/i.test(name),
  });
  const structural = (element, root) => {
    const parts = [];
    let cursor = element;
    while (cursor && cursor.nodeType === Node.ELEMENT_NODE && cursor !== root) {
      const tag = cursor.tagName.toLowerCase();
      const siblings = cursor.parentElement ? [...cursor.parentElement.children].filter((item) => item.tagName === cursor.tagName) : [];
      parts.unshift(siblings.length > 1 ? tag + ":nth-of-type(" + String(siblings.indexOf(cursor) + 1) + ")" : tag);
      cursor = cursor.parentElement;
    }
    return parts.join(" > ") || element.tagName.toLowerCase();
  };
  const selectorFor = (element, root) => {
    try {
      return find(element, options(root));
    } catch {
      return structural(element, root);
    }
  };
  const locatorSegments = [];
  let current = this;
  let selected = true;
  while (current) {
    const root = current.getRootNode();
    locatorSegments.unshift({ kind: selected ? "element" : "shadow", selector: selectorFor(current, root) });
    if (!(root instanceof ShadowRoot)) break;
    current = root.host;
    selected = false;
  }
  try {
    let currentWindow = this.ownerDocument.defaultView;
    while (currentWindow && currentWindow.frameElement) {
      const frame = currentWindow.frameElement;
      locatorSegments.unshift({ kind: "frame", selector: selectorFor(frame, frame.ownerDocument) });
      currentWindow = currentWindow.parent;
    }
  } catch {
    // Cross-origin frame targets are prefixed by the host from CDP target data.
  }
  const inputType = this instanceof HTMLInputElement ? this.type.toLowerCase() : "";
  const sanitizeElement = (element, forceRedactValue) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name;
      if (/^on/i.test(name)) {
        element.removeAttribute(name);
      } else if (sensitive.test(name) || (forceRedactValue && name.toLowerCase() === "value")) {
        element.setAttribute(name, "[REDACTED]");
      } else if (/^(?:href|src|action|formaction)$/i.test(name)) {
        element.setAttribute(name, safeUrl(attribute.value));
      }
    }
  };
  const clone = this.cloneNode(true);
  const clonedElements = [clone, ...clone.querySelectorAll("*")];
  for (const element of clonedElements) {
    if (/^(?:script|style|noscript)$/i.test(element.tagName)) {
      element.remove();
      continue;
    }
    const hiddenValue = element instanceof HTMLInputElement && ["password", "hidden"].includes(element.type.toLowerCase());
    sanitizeElement(element, hiddenValue);
  }
  const attributes = {};
  for (const attribute of [...this.attributes].slice(0, 100)) {
    const name = attribute.name;
    const redactValue = sensitive.test(name) || (["password", "hidden"].includes(inputType) && name.toLowerCase() === "value");
    attributes[name] = redactValue ? "[REDACTED]" : /^(?:href|src|action|formaction)$/i.test(name) ? safeUrl(attribute.value) : attribute.value.slice(0, 1024);
  }
  const style = getComputedStyle(this);
  const styleNames = ["display", "position", "visibility", "opacity", "color", "background-color", "font-family", "font-size", "font-weight", "line-height", "width", "height", "margin", "padding", "border", "border-radius", "overflow", "z-index"];
  const computedStyles = {};
  for (const name of styleNames) computedStyles[name] = style.getPropertyValue(name);
  const ancestry = [];
  let ancestor = this.parentElement;
  while (ancestor && ancestry.length < 8) {
    const label = ancestor.tagName.toLowerCase() + (ancestor.id && !volatile(ancestor.id) ? "#" + ancestor.id : "") + [...ancestor.classList].filter((name) => !volatile(name)).slice(0, 3).map((name) => "." + name).join("");
    ancestry.unshift(label);
    ancestor = ancestor.parentElement;
  }
  const frameworkHints = [];
  const angularAttribute = [...this.attributes].find((attribute) => /^_ng(?:content|host)-|^ng-reflect-/i.test(attribute.name));
  const angularRoot = this.closest("[ng-version]");
  if (angularAttribute || angularRoot || globalThis.ng) {
    let componentName = this.tagName.includes("-") ? this.tagName.toLowerCase() : undefined;
    try {
      componentName = globalThis.ng && globalThis.ng.getComponent ? globalThis.ng.getComponent(this)?.constructor?.name || componentName : componentName;
    } catch {}
    frameworkHints.push({ framework: "angular", name: componentName, details: [angularAttribute?.name, angularRoot?.getAttribute("ng-version") ? "Angular " + angularRoot.getAttribute("ng-version") : undefined].filter(Boolean) });
  }
  const wpClass = [...this.classList].find((name) => name.startsWith("wp-block-"));
  if (wpClass || document.body?.classList.contains("wp-admin") || document.documentElement.classList.contains("wp-toolbar")) {
    frameworkHints.push({ framework: "wordpress", name: wpClass?.replace(/^wp-block-/, ""), details: [document.body?.classList.contains("wp-admin") ? "WordPress admin" : "WordPress page"].filter(Boolean) });
  }
  const rect = this.getBoundingClientRect();
  return {
    locatorSegments,
    fallback: structural(this, this.getRootNode()),
    tagName: this.tagName.toLowerCase(),
    visibleText: String(this.innerText || this.textContent || "").replace(/\s+/g, " ").trim().slice(0, 4000),
    sanitizedHtml: String(clone.outerHTML || "").slice(0, 12000),
    attributes,
    computedStyles,
    ancestry,
    frameworkHints,
    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    url: safeUrl(location.href),
    title: document.title.slice(0, 1000),
  };
}`;

let cachedFinderSource: string | null = null;

const getFinderSource = (): string => {
  if (cachedFinderSource) return cachedFinderSource;
  const modulePath = createRequire(import.meta.url).resolve("@medv/finder");
  cachedFinderSource = `${readFileSync(modulePath, "utf8").replace(/(^|\n)export\s+/g, "$1")}\nglobalThis.__buildwardenFinder = finder;`;
  return cachedFinderSource;
};

export const isVolatileSelectorToken = (value: string): boolean =>
  /^\d/.test(value) || /[a-f0-9]{12,}/i.test(value) || /(?:^|[-_])(?:css|sc|ng|jsx|ember|chakra|mui)[-_]?[a-z]*\d{3,}/i.test(value);

export const sanitizeRunBrowserUrl = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    for (const name of [...url.searchParams.keys()]) {
      if (SENSITIVE_NAME.test(name)) url.searchParams.set(name, "[REDACTED]");
    }
    if (url.hash.includes("=")) {
      const hash = new URLSearchParams(url.hash.slice(1));
      for (const name of [...hash.keys()]) {
        if (SENSITIVE_NAME.test(name)) hash.set(name, "[REDACTED]");
      }
      url.hash = hash.toString();
    }
    return url.toString();
  } catch {
    return "about:blank";
  }
};

const renderElementMarkdown = (capture: Omit<RunBrowserElementCapture, "contextAttachment" | "screenshotAttachment">): string => {
  const lines = [
    "# Browser element",
    "",
    `- URL: ${capture.url}`,
    `- Page title: ${capture.pageTitle || "(untitled)"}`,
    `- Selector: \`${capture.locator.selector}\``,
    `- Element: \`<${capture.tagName}>\``,
    `- Accessible role: ${capture.accessibleRole || "(none)"}`,
    `- Accessible name: ${capture.accessibleName || "(none)"}`,
    `- Bounds: x=${String(Math.round(capture.bounds.x))}, y=${String(Math.round(capture.bounds.y))}, width=${String(Math.round(capture.bounds.width))}, height=${String(Math.round(capture.bounds.height))}`,
    "",
    "## Visible text",
    "",
    capture.visibleText || "(none)",
    "",
    "## Sanitized HTML",
    "",
    "```html",
    capture.sanitizedHtml,
    "```",
    "",
    "## Attributes",
    "",
    "```json",
    JSON.stringify(capture.attributes, null, 2),
    "```",
    "",
    "## Computed styles",
    "",
    "```json",
    JSON.stringify(capture.computedStyles, null, 2),
    "```",
  ];
  if (capture.ancestry.length > 0) lines.push("", "## Ancestry", "", capture.ancestry.join(" > "));
  if (capture.frameworkHints.length > 0) lines.push("", "## Framework hints", "", JSON.stringify(capture.frameworkHints, null, 2));
  return lines.join("\n");
};

const selectorFromSegments = (segments: RunBrowserLocatorSegment[]): string =>
  segments.map((segment) => segment.selector).join(" >>> ");

const valueFromAx = (value: CdpAxValue | undefined): string => typeof value?.value === "string" ? value.value : "";

export class RunBrowserInspector {
  private readonly captures = new Map<string, CachedCapture>();
  private readonly targetUrls = new Map<string, string>();
  private attached = false;
  private inspecting = false;
  private captureInFlight = false;

  constructor(private readonly options: RunBrowserInspectorOptions) {
    options.webContents.debugger.on("message", this.handleDebuggerMessage);
    options.webContents.debugger.on("detach", this.handleDebuggerDetach);
  }

  async start(): Promise<void> {
    await this.ensureAttached();
    await this.setInspectMode("searchForNode");
    this.inspecting = true;
    this.options.onInspectingChange(true);
  }

  async cancel(): Promise<void> {
    if (this.attached) await this.setInspectMode("none", true);
    if (this.inspecting) {
      this.inspecting = false;
      this.options.onInspectingChange(false);
    }
  }

  async dispatchInput(input: RunBrowserInput): Promise<void> {
    await this.ensureAttached();
    if (input.type === "mouse") {
      await this.command("Input.dispatchMouseEvent", {
        type: input.eventType,
        x: input.x,
        y: input.y,
        button: input.button ?? "none",
        clickCount: input.clickCount ?? 0,
        modifiers: input.modifiers ?? 0,
      });
      return;
    }
    if (input.type === "wheel") {
      await this.command("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: input.x,
        y: input.y,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
        modifiers: input.modifiers ?? 0,
      });
      return;
    }
    if (input.type === "key") {
      await this.command("Input.dispatchKeyEvent", {
        type: input.eventType,
        key: input.key,
        code: input.code ?? "",
        text: input.text ?? "",
        modifiers: input.modifiers ?? 0,
      });
      return;
    }
    await this.command("Input.insertText", { text: input.text });
  }

  getCapture(captureId: string): RunBrowserElementCapture | null {
    this.purgeExpiredCaptures();
    return this.captures.get(captureId)?.capture ?? null;
  }

  dispose(): void {
    this.captures.clear();
    this.targetUrls.clear();
    this.options.webContents.debugger.removeListener("message", this.handleDebuggerMessage);
    this.options.webContents.debugger.removeListener("detach", this.handleDebuggerDetach);
    if (this.attached && this.options.webContents.debugger.isAttached()) {
      this.options.webContents.debugger.detach();
    }
    this.attached = false;
    this.inspecting = false;
  }

  private readonly handleDebuggerMessage = (
    _event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): void => {
    if (method === "Overlay.inspectNodeRequested" && typeof params.backendNodeId === "number") {
      void this.captureSelection(params.backendNodeId, sessionId);
      return;
    }
    if (method === "Overlay.inspectModeCanceled") {
      void this.cancel();
      return;
    }
    if (method === "Target.attachedToTarget") {
      const childSessionId = typeof params.sessionId === "string" ? params.sessionId : "";
      const targetInfo = params.targetInfo && typeof params.targetInfo === "object" ? params.targetInfo as Record<string, unknown> : {};
      if (childSessionId) {
        this.targetUrls.set(childSessionId, typeof targetInfo.url === "string" ? targetInfo.url : "");
        void this.enableDomains(childSessionId).then(() => this.inspecting ? this.setInspectModeForSession("searchForNode", childSessionId) : undefined).catch((error) => {
          this.options.onError(error instanceof Error ? error.message : "Could not inspect a child frame.", true);
        });
      }
      return;
    }
    if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
      this.targetUrls.delete(params.sessionId);
    }
  };

  private readonly handleDebuggerDetach = (_event: Electron.Event, reason: string): void => {
    this.attached = false;
    this.targetUrls.clear();
    if (this.inspecting) {
      this.inspecting = false;
      this.options.onInspectingChange(false);
    }
    this.options.onError(`Browser inspection stopped (${reason}).`, true);
  };

  private async ensureAttached(): Promise<void> {
    if (this.attached && this.options.webContents.debugger.isAttached()) return;
    if (!this.options.webContents.debugger.isAttached()) {
      this.options.webContents.debugger.attach(INSPECTOR_PROTOCOL_VERSION);
    }
    this.attached = true;
    await this.enableDomains();
    await this.command("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  }

  private async enableDomains(sessionId?: string): Promise<void> {
    for (const domain of ["DOM", "Runtime", "CSS", "Accessibility", "Page", "Overlay"]) {
      await this.command(`${domain}.enable`, {}, sessionId);
    }
  }

  private async setInspectMode(mode: "searchForNode" | "none", ignoreErrors = false): Promise<void> {
    const sessions = [undefined, ...this.targetUrls.keys()];
    await Promise.all(sessions.map(async (sessionId) => {
      try {
        await this.setInspectModeForSession(mode, sessionId);
      } catch (error) {
        if (!ignoreErrors) throw error;
      }
    }));
  }

  private setInspectModeForSession(mode: "searchForNode" | "none", sessionId?: string): Promise<unknown> {
    return this.command("Overlay.setInspectMode", {
      mode,
      highlightConfig: {
        showInfo: true,
        showStyles: false,
        contentColor: { r: 59, g: 130, b: 246, a: 0.18 },
        paddingColor: { r: 34, g: 197, b: 94, a: 0.18 },
        borderColor: { r: 37, g: 99, b: 235, a: 0.9 },
        marginColor: { r: 251, g: 191, b: 36, a: 0.12 },
      },
    }, sessionId);
  }

  private async captureSelection(backendNodeId: number, sessionId?: string): Promise<void> {
    if (this.captureInFlight) return;
    this.captureInFlight = true;
    try {
      await this.cancel();
      const resolved = await this.command("DOM.resolveNode", { backendNodeId }, sessionId) as CdpValueResult<never>;
      const objectId = resolved.result?.objectId;
      if (!objectId) throw new Error("The selected browser element is no longer available.");
      const collected = await this.command("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: PAGE_COLLECTOR_SOURCE,
        arguments: [{ value: getFinderSource() }],
        returnByValue: true,
        awaitPromise: true,
        userGesture: false,
      }, sessionId) as CdpValueResult<PageElementData>;
      const pageData = collected.result?.value;
      if (!pageData) throw new Error("Could not collect context for the selected browser element.");
      const segments = [...pageData.locatorSegments];
      const targetUrl = sessionId ? this.targetUrls.get(sessionId) : undefined;
      if (targetUrl && !segments.some((segment) => segment.kind === "frame")) {
        const sanitizedTargetUrl = sanitizeRunBrowserUrl(targetUrl);
        segments.unshift({ kind: "frame", selector: `iframe[src=${JSON.stringify(sanitizedTargetUrl)}]`, frameUrl: sanitizedTargetUrl });
      }
      const selector = selectorFromSegments(segments) || pageData.fallback;
      const locator: RunBrowserElementLocator = { selector, segments, fallback: pageData.fallback };
      const axTree = await this.command("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }, sessionId) as { nodes?: CdpAxNode[] };
      const axNode = axTree.nodes?.[0];
      const url = sanitizeRunBrowserUrl(pageData.url || this.options.webContents.getURL());
      const screenshotBase64 = await this.captureHighlightedScreenshot(backendNodeId, sessionId);
      const id = randomUUID();
      const capturedAt = new Date().toISOString();
      const captureBase = {
        id,
        runId: this.options.runId,
        capturedAt,
        url,
        pageTitle: pageData.title,
        locator,
        tagName: pageData.tagName,
        accessibleRole: valueFromAx(axNode?.role),
        accessibleName: valueFromAx(axNode?.name),
        visibleText: pageData.visibleText,
        sanitizedHtml: pageData.sanitizedHtml,
        attributes: pageData.attributes,
        computedStyles: pageData.computedStyles,
        ancestry: pageData.ancestry,
        frameworkHints: pageData.frameworkHints,
        bounds: pageData.bounds,
      } satisfies Omit<RunBrowserElementCapture, "contextAttachment" | "screenshotAttachment">;
      const source = { kind: "browser-element" as const, groupId: id, captureId: id, url, selector };
      const capture: RunBrowserElementCapture = {
        ...captureBase,
        contextAttachment: {
          fileName: `browser-element-${id}.md`,
          mimeType: "text/markdown",
          dataBase64: Buffer.from(renderElementMarkdown(captureBase), "utf8").toString("base64"),
          source: { ...source, role: "context" },
        },
        screenshotAttachment: {
          fileName: `browser-element-${id}.jpg`,
          mimeType: "image/jpeg",
          dataBase64: screenshotBase64,
          source: { ...source, role: "screenshot" },
        },
      };
      this.storeCapture(capture);
      this.options.onSelection(id, {
        tagName: capture.tagName,
        accessibleName: capture.accessibleName,
        selector,
        url,
      });
    } catch (error) {
      this.options.onError(error instanceof Error ? error.message : "Could not capture the selected browser element.", true);
    } finally {
      this.captureInFlight = false;
    }
  }

  private async captureHighlightedScreenshot(backendNodeId: number, sessionId?: string): Promise<string> {
    await this.command("Overlay.highlightNode", {
      backendNodeId,
      highlightConfig: {
        showInfo: true,
        contentColor: { r: 59, g: 130, b: 246, a: 0.24 },
        paddingColor: { r: 34, g: 197, b: 94, a: 0.2 },
        borderColor: { r: 37, g: 99, b: 235, a: 1 },
        marginColor: { r: 251, g: 191, b: 36, a: 0.15 },
      },
    }, sessionId);
    try {
      const screenshot = await this.command("Page.captureScreenshot", {
        format: "jpeg",
        quality: 85,
        fromSurface: true,
        captureBeyondViewport: false,
      }) as { data?: string };
      if (!screenshot.data) throw new Error("The browser did not return a screenshot.");
      const image = nativeImage.createFromBuffer(Buffer.from(screenshot.data, "base64"));
      const size = image.getSize();
      const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / size.width, MAX_SCREENSHOT_HEIGHT / size.height);
      const output = scale < 1
        ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: "best" })
        : image;
      return output.toJPEG(85).toString("base64");
    } finally {
      await this.command("Overlay.hideHighlight", {}, sessionId).catch(() => undefined);
    }
  }

  private storeCapture(capture: RunBrowserElementCapture): void {
    this.purgeExpiredCaptures();
    this.captures.set(capture.id, { capture, expiresAt: Date.now() + CAPTURE_TTL_MS });
    while (this.captures.size > MAX_CAPTURE_COUNT) {
      const oldest = this.captures.keys().next().value as string | undefined;
      if (!oldest) break;
      this.captures.delete(oldest);
    }
  }

  private purgeExpiredCaptures(): void {
    const now = Date.now();
    for (const [captureId, cached] of this.captures) {
      if (cached.expiresAt <= now) this.captures.delete(captureId);
    }
  }

  private command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    return this.options.webContents.debugger.sendCommand(method, params, sessionId);
  }
}
