/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildVisualReplyDocument, VISUAL_REPLY_MESSAGES, type VisualReplyFrame } from "@buildwarden/shared";
import { buildActivityEntries, findFinalAnswerEntries, type RunActivityStep } from "./run-activity-model";
import { VisualReplyView } from "./visual-reply-frame";

const client = {
  getVisualReplyFrame: vi.fn<(runId: string, stepId: string) => Promise<VisualReplyFrame>>(),
  openExternalUrl: vi.fn(async () => ({ ok: true })),
};
vi.mock("../../lib/buildwarden-client", () => ({ useBuildWardenClient: () => client, useOptionalBuildWardenClient: () => client }));

const step = (id: string, eventType: RunActivityStep["eventType"], metadata: Record<string, unknown>, content: string): RunActivityStep => ({
  id, eventType, title: id, content, metadataJson: JSON.stringify(metadata), createdAt: "2026-11-26T12:00:00.000Z",
});
const visual = { title: "Sales by month", blobId: "a".repeat(64), byteLength: 100 };

let root: Root;
let container: HTMLDivElement;
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const renderView = async (frame: VisualReplyFrame) => {
  client.getVisualReplyFrame.mockResolvedValue(frame);
  await act(async () => {
    root.render(<VisualReplyView runId="run-1" stepId="visual" visual={visual} />);
    await Promise.resolve();
  });
  const iframe = container.querySelector("iframe");
  if (!iframe) throw new Error("no frame");
  return iframe;
};

describe("visual replies in the run timeline", () => {
  it("keeps a page apart from the answer text and never takes it for the final answer", () => {
    const entries = buildActivityEntries([
      step("prompt", "log", { source: "user" }, "Show the sales"),
      step("text", "output", {}, "Here they are."),
      step("visual", "output", { assistantKind: "visual", visualReply: visual }, "[Visual reply shown to the user: Sales by month]"),
    ]);
    const visualEntry = entries.find((entry) => entry.kind === "single" && entry.step.id === "visual");
    expect(visualEntry).toBeDefined();
    const finals = [...findFinalAnswerEntries(entries, false)];
    expect(finals).toHaveLength(1);
    expect(finals[0]).not.toBe(visualEntry);
  });
});

describe("VisualReplyView", () => {
  it("shows the page in a frame that may run scripts but has no origin of its own", async () => {
    const iframe = await renderView({ kind: "document", document: buildVisualReplyDocument("<p>hello</p>") });
    expect(client.getVisualReplyFrame).toHaveBeenCalledWith("run-1", "visual");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("srcdoc")).toContain("<p>hello</p>");
    expect(container.textContent).toContain("Sales by month");
  });

  it("loads a host page by address in the browser version", async () => {
    const iframe = await renderView({ kind: "url", url: "https://host.example.ts.net/visual/abc.def" });
    expect(iframe.getAttribute("src")).toBe("https://host.example.ts.net/visual/abc.def");
    expect(iframe.hasAttribute("srcdoc")).toBe(false);
  });

  it("asks for a new host address when full screen opens, since the first one expires", async () => {
    await renderView({ kind: "url", url: "https://host.example.ts.net/visual/first.sig" });
    client.getVisualReplyFrame.mockResolvedValueOnce({ kind: "url", url: "https://host.example.ts.net/visual/fresh.sig" });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Open full screen"]')!.click();
      await Promise.resolve();
    });
    expect(client.getVisualReplyFrame).toHaveBeenCalledTimes(2);
    const sources = [...document.querySelectorAll("iframe")].map((frame) => frame.getAttribute("src"));
    expect(sources).toEqual(["https://host.example.ts.net/visual/first.sig", "https://host.example.ts.net/visual/fresh.sig"]);
  });

  it("follows the page height and opens web links only for messages from its own frame", async () => {
    const iframe = await renderView({ kind: "document", document: "<p>x</p>" });
    const open = client.openExternalUrl;
    const activation = { isActive: true };
    Object.defineProperty(navigator, "userActivation", { value: activation, configurable: true });
    const post = (data: unknown, source: unknown) => act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, source: source as MessageEventSource }));
    });

    post({ type: VISUAL_REPLY_MESSAGES.size, height: 420 }, iframe.contentWindow);
    expect(iframe.style.height).toBe("420px");
    post({ type: VISUAL_REPLY_MESSAGES.size, height: 99_999 }, iframe.contentWindow);
    expect(iframe.style.height).toBe("1600px");
    post({ type: VISUAL_REPLY_MESSAGES.size, height: 300 }, window);
    expect(iframe.style.height).toBe("1600px");

    post({ type: VISUAL_REPLY_MESSAGES.openLink, url: "javascript:alert(1)" }, iframe.contentWindow);
    post({ type: VISUAL_REPLY_MESSAGES.openLink, url: "https://example.com/a" }, window);
    expect(open).not.toHaveBeenCalled();
    post({ type: VISUAL_REPLY_MESSAGES.openLink, url: "https://example.com/a" }, iframe.contentWindow);
    expect(open).toHaveBeenCalledWith("https://example.com/a");

    // A script asking without a click is ignored.
    open.mockClear();
    activation.isActive = false;
    post({ type: VISUAL_REPLY_MESSAGES.openLink, url: "https://example.com/b" }, iframe.contentWindow);
    expect(open).not.toHaveBeenCalled();
    Reflect.deleteProperty(navigator, "userActivation");
  });

});
