import { randomUUID } from "node:crypto";
import { nativeImage, type NativeImage } from "electron";
import type {
  RunBrowserBounds,
  RunBrowserElementCapture,
  RunBrowserElementLocator,
  RunBrowserLocatorSegment,
  RunBrowserInput,
} from "@buildwarden/shared";
import {
  PAGE_COLLECTOR_SOURCE,
  getFinderSource,
  renderElementMarkdown,
  sanitizeRunBrowserUrl,
  selectorFromSegments,
} from "./run-browser-capture-utils";
import type {
  AnnotationBindingPayload,
  AnnotationTarget,
  AttachedFrameTarget,
  CachedCapture,
  PageElementData,
  RunBrowserInspectorOptions,
} from "./run-browser-inspector-types";
import type {
  CdpAxNode,
  CdpAxValue,
  CdpResolveNodeResult,
  CdpValueResult,
} from "./run-browser-capture-utils";
import {
  CALL_RUN_BROWSER_ANNOTATION_MANAGER_SOURCE,
  SHOW_RUN_BROWSER_ANNOTATION_EDITOR_SOURCE,
} from "./run-browser-annotation-overlay";

export { isVolatileSelectorToken, sanitizeRunBrowserUrl } from "./run-browser-capture-utils";
export type { RunBrowserInspectorOptions } from "./run-browser-inspector-types";

const INSPECTOR_PROTOCOL_VERSION = "1.3";
const CAPTURE_TTL_MS = 2 * 60_000;
const MAX_CAPTURE_COUNT = 8;
const MAX_SCREENSHOT_WIDTH = 1_600;
const MAX_SCREENSHOT_HEIGHT = 1_200;
const SCREENSHOT_CROP_PADDING = 32;
const MAX_ANNOTATION_COMMENT_LENGTH = 1_000;

const valueFromAx = (value: CdpAxValue | undefined): string => typeof value?.value === "string" ? value.value : "";

export class RunBrowserInspector {
  private readonly captures = new Map<string, CachedCapture>();
  private readonly frameTargets = new Map<string, AttachedFrameTarget>();
  private readonly annotationTargets = new Map<string, AnnotationTarget>();
  private readonly annotationBindingName = `__buildwardenAnnotation_${randomUUID().replaceAll("-", "")}`;
  private attached = false;
  private inspecting = false;
  private captureInFlight = false;
  private openingSelection = false;
  private pendingSelection: AnnotationTarget | null = null;
  private nextAnnotationNumber = 1;
  private documentGeneration = 0;

  constructor(private readonly options: RunBrowserInspectorOptions) {
    options.webContents.debugger.on("message", this.handleDebuggerMessage);
    options.webContents.debugger.on("detach", this.handleDebuggerDetach);
  }

  async start(annotationStartNumber?: number): Promise<void> {
    if (Number.isInteger(annotationStartNumber) && Number(annotationStartNumber) > this.nextAnnotationNumber) {
      this.nextAnnotationNumber = Number(annotationStartNumber);
    }
    await this.ensureAttached();
    if (this.pendingSelection) await this.dismissPendingSelection(false);
    await this.setInspectMode("searchForNode");
    if (!this.inspecting) {
      this.inspecting = true;
      this.options.onInspectingChange(true);
    }
  }

  async cancel(): Promise<void> {
    if (this.pendingSelection) await this.dismissPendingSelection(false);
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

  async removeAnnotation(captureId: string): Promise<void> {
    this.captures.delete(captureId);
    const target = this.annotationTargets.get(captureId);
    if (!target) return;
    this.annotationTargets.delete(captureId);
    await this.releaseAnnotationTarget(target, true);
  }

  async clearAnnotations(): Promise<void> {
    if (this.pendingSelection) await this.dismissPendingSelection(true);
    const targets = [...this.annotationTargets.values()];
    this.annotationTargets.clear();
    this.captures.clear();
    this.nextAnnotationNumber = 1;
    await Promise.all(targets.map((target) => this.releaseAnnotationTarget(target, true)));
  }

  handleNavigationReplacement(): void {
    this.documentGeneration += 1;
    this.captures.clear();
    this.frameTargets.clear();
    this.annotationTargets.clear();
    this.pendingSelection = null;
    if (this.inspecting) {
      this.inspecting = false;
      this.options.onInspectingChange(false);
    }
  }

  dispose(): void {
    this.documentGeneration += 1;
    this.captures.clear();
    this.frameTargets.clear();
    this.annotationTargets.clear();
    this.pendingSelection = null;
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
      void this.openSelectionEditor(params.backendNodeId, sessionId || undefined);
      return;
    }
    if (method === "Overlay.inspectModeCanceled") {
      if (this.openingSelection || this.pendingSelection || this.captureInFlight) return;
      void this.cancel();
      return;
    }
    if (method === "Runtime.bindingCalled") {
      this.handleAnnotationBinding(params, sessionId);
      return;
    }
    if (method === "Target.attachedToTarget") {
      this.handleAttachedTarget(params, sessionId);
      return;
    }
    if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
      this.frameTargets.delete(params.sessionId);
    }
  };

  private handleAnnotationBinding(params: Record<string, unknown>, sessionId?: string): void {
    if (params.name !== this.annotationBindingName || typeof params.payload !== "string") {
      return;
    }
    const payload = this.parseAnnotationBindingPayload(params.payload);
    if (!payload || !this.pendingSelection || payload.token !== this.pendingSelection.token) {
      return;
    }
    if ((sessionId || undefined) !== this.pendingSelection.sessionId) {
      return;
    }
    if (payload.type === "resume") {
      void this.dismissPendingSelection(true);
    } else {
      void this.commitPendingSelection(payload.comment ?? "");
    }
  }

  private parseAnnotationBindingPayload(rawPayload: string): AnnotationBindingPayload | null {
    try {
      const parsed = JSON.parse(rawPayload) as Partial<AnnotationBindingPayload>;
      if ((parsed.type === "commit" || parsed.type === "resume") && typeof parsed.token === "string") {
        return {
          type: parsed.type,
          token: parsed.token,
          ...(typeof parsed.comment === "string" ? { comment: parsed.comment } : {}),
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  private handleAttachedTarget(params: Record<string, unknown>, parentSessionId?: string): void {
    const childSessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const targetInfo = params.targetInfo && typeof params.targetInfo === "object"
      ? params.targetInfo as Record<string, unknown>
      : {};
    if (!childSessionId || targetInfo.type !== "iframe") {
      return;
    }
    this.frameTargets.set(childSessionId, {
      frameId: typeof targetInfo.targetId === "string" ? targetInfo.targetId : "",
      url: typeof targetInfo.url === "string" ? targetInfo.url : "",
      ...(parentSessionId ? { parentSessionId } : {}),
    });
    void this.enableDomains(childSessionId)
      .then(() => this.setAutoAttach(childSessionId))
      .then(() => this.inspecting ? this.setInspectModeForSession("searchForNode", childSessionId) : undefined)
      .catch((error) => {
        this.options.onError(error instanceof Error ? error.message : "Could not inspect a child frame.", true);
      });
  }

  private readonly handleDebuggerDetach = (_event: Electron.Event, reason: string): void => {
    this.attached = false;
    this.documentGeneration += 1;
    this.captures.clear();
    this.frameTargets.clear();
    this.annotationTargets.clear();
    this.pendingSelection = null;
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
    await this.setAutoAttach();
  }

  private setAutoAttach(sessionId?: string): Promise<unknown> {
    return this.command("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }, sessionId);
  }

  private async enableDomains(sessionId?: string): Promise<void> {
    for (const domain of ["DOM", "Runtime", "CSS", "Accessibility", "Page", "Overlay"]) {
      await this.command(`${domain}.enable`, {}, sessionId);
    }
    await this.command("Runtime.addBinding", { name: this.annotationBindingName }, sessionId);
  }

  private async setInspectMode(mode: "searchForNode" | "none", ignoreErrors = false): Promise<void> {
    const sessions = [undefined, ...this.frameTargets.keys()];
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

  private async openSelectionEditor(backendNodeId: number, sessionId?: string): Promise<void> {
    if (!this.inspecting || this.captureInFlight || this.openingSelection || this.pendingSelection) return;
    this.openingSelection = true;
    const documentGeneration = this.documentGeneration;
    let objectId = "";
    try {
      await this.setInspectMode("none", true);
      const resolved = await this.command("DOM.resolveNode", { backendNodeId }, sessionId) as CdpResolveNodeResult;
      objectId = resolved.object?.objectId ?? "";
      if (!objectId) throw new Error("The selected browser element is no longer available.");
      if (!this.inspecting || documentGeneration !== this.documentGeneration) {
        await this.command("Runtime.releaseObject", { objectId }, sessionId).catch(() => undefined);
        objectId = "";
        return;
      }
      const target: AnnotationTarget = {
        backendNodeId,
        objectId,
        token: randomUUID(),
        annotationNumber: this.nextAnnotationNumber,
        ...(sessionId ? { sessionId } : {}),
      };
      this.pendingSelection = target;
      await this.command("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: SHOW_RUN_BROWSER_ANNOTATION_EDITOR_SOURCE,
        arguments: [
          { value: this.annotationBindingName },
          { value: target.token },
          { value: target.annotationNumber },
        ],
        returnByValue: true,
        awaitPromise: false,
        userGesture: true,
      }, sessionId);
    } catch (error) {
      if (this.pendingSelection?.objectId === objectId) this.pendingSelection = null;
      if (objectId) await this.command("Runtime.releaseObject", { objectId }, sessionId).catch(() => undefined);
      this.options.onError(error instanceof Error ? error.message : "Could not open the element annotation editor.", true);
      if (this.inspecting) await this.setInspectMode("searchForNode", true);
    } finally {
      this.openingSelection = false;
    }
  }

  private async dismissPendingSelection(resumeInspecting: boolean): Promise<void> {
    const target = this.pendingSelection;
    this.pendingSelection = null;
    if (target) {
      await this.callAnnotationManager(target, "dismiss", [target.token]).catch(() => undefined);
      await this.command("Runtime.releaseObject", { objectId: target.objectId }, target.sessionId).catch(() => undefined);
    }
    if (resumeInspecting && this.inspecting) await this.setInspectMode("searchForNode", true);
  }

  private async commitPendingSelection(rawComment: string): Promise<void> {
    const target = this.pendingSelection;
    if (!target || this.captureInFlight) return;
    this.captureInFlight = true;
    const documentGeneration = this.documentGeneration;
    try {
      await this.callAnnotationManager(target, "prepare", [target.token]).catch(() => undefined);
      const capture = await this.captureSelection(target, rawComment.trim().slice(0, MAX_ANNOTATION_COMMENT_LENGTH));
      if (documentGeneration !== this.documentGeneration || this.pendingSelection !== target) return;
      await this.callAnnotationManager(target, "accept", [target.token, target.annotationNumber]).catch(() => undefined);
      this.pendingSelection = null;
      this.annotationTargets.set(capture.id, target);
      this.nextAnnotationNumber += 1;
      this.storeCapture(capture);
      this.options.onSelection(capture.id, {
        tagName: capture.tagName,
        accessibleName: capture.accessibleName,
        selector: capture.locator.selector,
        url: capture.url,
      });
      if (this.inspecting) await this.setInspectMode("searchForNode", true);
    } catch (error) {
      if (documentGeneration === this.documentGeneration && this.pendingSelection === target) {
        const message = error instanceof Error ? error.message : "Could not capture the selected browser element.";
        await this.callAnnotationManager(target, "reject", [target.token, message]).catch(() => undefined);
        this.options.onError(message, true);
      }
    } finally {
      this.captureInFlight = false;
    }
  }

  private async captureSelection(target: AnnotationTarget, comment: string): Promise<RunBrowserElementCapture> {
    const { backendNodeId, sessionId } = target;
    const pageData = await this.collectPageData(backendNodeId, sessionId);
    const segments = [...pageData.locatorSegments];
    if (sessionId && !segments.some((segment) => segment.kind === "frame")) {
      segments.unshift(...await this.resolveOwnerFrameSegments(sessionId));
    }
    const selector = selectorFromSegments(segments) || pageData.fallback;
    const locator: RunBrowserElementLocator = { selector, segments, fallback: pageData.fallback };
    const axTree = await this.command("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }, sessionId) as { nodes?: CdpAxNode[] };
    const axNode = axTree.nodes?.[0];
    const url = sanitizeRunBrowserUrl(pageData.url || this.options.webContents.getURL());
    const screenshotBase64 = await this.captureHighlightedScreenshot(backendNodeId, pageData.bounds, sessionId);
    const id = randomUUID();
    const capturedAt = new Date().toISOString();
    const captureBase = {
      id,
      runId: this.options.runId,
      capturedAt,
      annotationNumber: target.annotationNumber,
      comment,
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
    const source = {
      kind: "browser-element" as const,
      groupId: id,
      captureId: id,
      url,
      selector,
      annotationNumber: captureBase.annotationNumber,
      comment: captureBase.comment,
      tagName: captureBase.tagName,
      accessibleName: captureBase.accessibleName,
    };
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
    return capture;
  }

  private callAnnotationManager(target: AnnotationTarget, method: string, args: unknown[]): Promise<unknown> {
    return this.command("Runtime.callFunctionOn", {
      objectId: target.objectId,
      functionDeclaration: CALL_RUN_BROWSER_ANNOTATION_MANAGER_SOURCE,
      arguments: [{ value: method }, { value: args }],
      returnByValue: true,
      awaitPromise: false,
      userGesture: true,
    }, target.sessionId);
  }

  private async releaseAnnotationTarget(target: AnnotationTarget, removeVisual: boolean): Promise<void> {
    if (removeVisual) await this.callAnnotationManager(target, "remove", [target.token]).catch(() => undefined);
    await this.command("Runtime.releaseObject", { objectId: target.objectId }, target.sessionId).catch(() => undefined);
  }

  private async collectPageData(backendNodeId: number, sessionId?: string): Promise<PageElementData> {
    const resolved = await this.command("DOM.resolveNode", { backendNodeId }, sessionId) as CdpResolveNodeResult;
    const objectId = resolved.object?.objectId;
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
    return pageData;
  }

  private async resolveOwnerFrameSegments(sessionId: string): Promise<RunBrowserLocatorSegment[]> {
    const segments: RunBrowserLocatorSegment[] = [];
    let currentSessionId: string | undefined = sessionId;
    while (currentSessionId) {
      const frame = this.frameTargets.get(currentSessionId);
      if (!frame?.frameId) break;
      try {
        const owner = await this.command("DOM.getFrameOwner", { frameId: frame.frameId }, frame.parentSessionId) as {
          backendNodeId?: number;
        };
        if (typeof owner.backendNodeId !== "number") break;
        const ownerData = await this.collectPageData(owner.backendNodeId, frame.parentSessionId);
        const ownerSegments = ownerData.locatorSegments.length > 0
          ? ownerData.locatorSegments.map((segment, index) => index === ownerData.locatorSegments.length - 1
            ? { kind: "frame" as const, selector: segment.selector, frameUrl: sanitizeRunBrowserUrl(frame.url) }
            : segment)
          : [{ kind: "frame" as const, selector: ownerData.fallback, frameUrl: sanitizeRunBrowserUrl(frame.url) }];
        segments.unshift(...ownerSegments);
        currentSessionId = frame.parentSessionId;
      } catch {
        break;
      }
    }
    return segments;
  }

  private async captureHighlightedScreenshot(
    backendNodeId: number,
    bounds: RunBrowserBounds,
    sessionId?: string,
  ): Promise<string> {
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
      const cropped = sessionId ? image : await this.cropScreenshotToElement(image, bounds);
      const size = cropped.getSize();
      const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / size.width, MAX_SCREENSHOT_HEIGHT / size.height);
      const output = scale < 1
        ? cropped.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: "best" })
        : cropped;
      return output.toJPEG(85).toString("base64");
    } finally {
      await this.command("Overlay.hideHighlight", {}, sessionId).catch(() => undefined);
    }
  }

  private async cropScreenshotToElement(image: NativeImage, bounds: RunBrowserBounds): Promise<NativeImage> {
    const metrics = await this.command("Page.getLayoutMetrics") as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
    };
    const viewportWidth = Number(metrics.cssVisualViewport?.clientWidth);
    const viewportHeight = Number(metrics.cssVisualViewport?.clientHeight);
    if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) || viewportWidth <= 0 || viewportHeight <= 0) {
      return image;
    }
    const left = Math.max(0, bounds.x - SCREENSHOT_CROP_PADDING);
    const top = Math.max(0, bounds.y - SCREENSHOT_CROP_PADDING);
    const right = Math.min(viewportWidth, bounds.x + bounds.width + SCREENSHOT_CROP_PADDING);
    const bottom = Math.min(viewportHeight, bounds.y + bounds.height + SCREENSHOT_CROP_PADDING);
    if (right <= left || bottom <= top) return image;
    const size = image.getSize();
    const scaleX = size.width / viewportWidth;
    const scaleY = size.height / viewportHeight;
    const x = Math.max(0, Math.min(size.width - 1, Math.floor(left * scaleX)));
    const y = Math.max(0, Math.min(size.height - 1, Math.floor(top * scaleY)));
    const width = Math.max(1, Math.min(size.width - x, Math.ceil((right - left) * scaleX)));
    const height = Math.max(1, Math.min(size.height - y, Math.ceil((bottom - top) * scaleY)));
    return image.crop({ x, y, width, height });
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
    return sessionId
      ? this.options.webContents.debugger.sendCommand(method, params, sessionId)
      : this.options.webContents.debugger.sendCommand(method, params);
  }
}
