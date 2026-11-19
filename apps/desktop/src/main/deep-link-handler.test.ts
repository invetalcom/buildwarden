import { describe, expect, it, vi } from "vitest";
import {
  buildDeepLinkUrl,
  buildWebDeepLinkUrl,
  findDeepLinkInArgv,
  parseDeepLinkHash,
  parseDeepLinkUrl,
} from "@buildwarden/shared";
import { DeepLinkHandler, deepLinkSchemeFor, registerDeepLinkProtocol } from "./deep-link-handler";

const RUN_ID = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const CHAT_ID = "0b1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e";

describe("parseDeepLinkUrl", () => {
  it("parses run, chat, and project links", () => {
    expect(parseDeepLinkUrl(`buildwarden://run/${RUN_ID}`)).toEqual({ kind: "run", runId: RUN_ID });
    expect(parseDeepLinkUrl(`buildwarden://run/${RUN_ID}/diff`)).toEqual({ kind: "run", runId: RUN_ID, segment: "diff" });
    expect(parseDeepLinkUrl(`buildwarden://chat/${CHAT_ID}`)).toEqual({ kind: "chat", chatId: CHAT_ID });
    expect(parseDeepLinkUrl(`buildwarden://project/${RUN_ID}`)).toEqual({ kind: "project", projectId: RUN_ID });
  });

  it("accepts a triple slash, an upper-case scheme or kind, and a trailing slash", () => {
    expect(parseDeepLinkUrl(`buildwarden:///run/${RUN_ID}`)).toEqual({ kind: "run", runId: RUN_ID });
    expect(parseDeepLinkUrl(`BuildWarden://RUN/${RUN_ID}/`)).toEqual({ kind: "run", runId: RUN_ID });
  });

  it("ignores unknown run panels, queries, and fragments", () => {
    expect(parseDeepLinkUrl(`buildwarden://run/${RUN_ID}/settings`)).toEqual({ kind: "run", runId: RUN_ID });
    expect(parseDeepLinkUrl(`buildwarden://run/${RUN_ID}?prompt=rm%20-rf#x`)).toEqual({ kind: "run", runId: RUN_ID });
  });

  it("rejects other schemes, unknown kinds, malformed IDs, and extra segments", () => {
    expect(parseDeepLinkUrl(`https://run/${RUN_ID}`)).toBeNull();
    expect(parseDeepLinkUrl(`buildwarden-dev://run/${RUN_ID}`)).toBeNull();
    expect(parseDeepLinkUrl(`buildwarden://delete/${RUN_ID}`)).toBeNull();
    expect(parseDeepLinkUrl("buildwarden://run/")).toBeNull();
    expect(parseDeepLinkUrl("buildwarden://run/..%2F..%2Fetc")).toBeNull();
    expect(parseDeepLinkUrl("buildwarden://run/a%20b")).toBeNull();
    expect(parseDeepLinkUrl("buildwarden://run/%E0%A4%A")).toBeNull();
    expect(parseDeepLinkUrl(`buildwarden://chat/${CHAT_ID}/diff`)).toBeNull();
    expect(parseDeepLinkUrl(`buildwarden://run/${RUN_ID}/diff/extra`)).toBeNull();
    expect(parseDeepLinkUrl(`buildwarden://run/${"a".repeat(3000)}`)).toBeNull();
    expect(parseDeepLinkUrl("not a url")).toBeNull();
  });

  it("only accepts the dev scheme when asked", () => {
    expect(parseDeepLinkUrl(`buildwarden-dev://run/${RUN_ID}`, { schemes: ["buildwarden-dev"] })).toEqual({ kind: "run", runId: RUN_ID });
  });
});

describe("web deep links", () => {
  it("round-trips through the page hash", () => {
    const url = buildWebDeepLinkUrl({ kind: "run", runId: RUN_ID, segment: "terminal" }, "https://host.example:7777/app/?x=1#/runs");
    expect(url).toBe(`https://host.example:7777/app/?x=1#/run/${RUN_ID}/terminal`);
    expect(parseDeepLinkHash(new URL(url).hash)).toEqual({ kind: "run", runId: RUN_ID, segment: "terminal" });
  });

  it("ignores pairing fragments and other hashes", () => {
    expect(parseDeepLinkHash("#pair=abc&host=https%3A%2F%2Fexample")).toBeNull();
    expect(parseDeepLinkHash("#/runs")).toBeNull();
    expect(parseDeepLinkHash("")).toBeNull();
    expect(parseDeepLinkHash(`#/chat/${CHAT_ID}`)).toEqual({ kind: "chat", chatId: CHAT_ID });
  });

  it("builds desktop links with the requested scheme", () => {
    expect(buildDeepLinkUrl({ kind: "chat", chatId: CHAT_ID })).toBe(`buildwarden://chat/${CHAT_ID}`);
    expect(buildDeepLinkUrl({ kind: "run", runId: RUN_ID }, "buildwarden-dev")).toBe(`buildwarden-dev://run/${RUN_ID}`);
  });
});

describe("findDeepLinkInArgv", () => {
  it("finds the link among Chromium switches regardless of position", () => {
    const argv = ["C:\\Program Files\\BuildWarden\\BuildWarden.exe", "--allow-file-access-from-files", "--original-process-start-time=1", `buildwarden://run/${RUN_ID}`];
    expect(findDeepLinkInArgv(argv)).toEqual({ url: `buildwarden://run/${RUN_ID}`, target: { kind: "run", runId: RUN_ID } });
  });

  it("ignores switches that embed a link and plain launches", () => {
    expect(findDeepLinkInArgv(["app.exe", `--flag=buildwarden://run/${RUN_ID}`])).toBeNull();
    expect(findDeepLinkInArgv(["app.exe", "."])).toBeNull();
  });
});

describe("DeepLinkHandler", () => {
  const createHandler = () => {
    const focusWindow = vi.fn();
    const notifyRenderer = vi.fn();
    const handler = new DeepLinkHandler({ scheme: "buildwarden", focusWindow, notifyRenderer });
    return { handler, focusWindow, notifyRenderer };
  };

  it("stores the newest link, focuses the window, and pings the renderer", () => {
    const { handler, focusWindow, notifyRenderer } = createHandler();
    expect(handler.handleUrl(`buildwarden://run/${RUN_ID}`)).toBe(true);
    expect(handler.handleUrl(`buildwarden://chat/${CHAT_ID}`)).toBe(true);
    expect(focusWindow).toHaveBeenCalledTimes(2);
    expect(notifyRenderer).toHaveBeenCalledTimes(2);
    expect(handler.consumePending()).toEqual({ url: `buildwarden://chat/${CHAT_ID}`, target: { kind: "chat", chatId: CHAT_ID } });
    expect(handler.consumePending()).toBeNull();
  });

  it("leaves other URLs to the caller without side effects", () => {
    const { handler, focusWindow, notifyRenderer } = createHandler();
    expect(handler.handleUrl("https://example.com")).toBe(false);
    expect(handler.handleUrl(`buildwarden-dev://run/${RUN_ID}`)).toBe(false);
    expect(handler.handleArgv(["app.exe", "--inspect"])).toBe(false);
    expect(focusWindow).not.toHaveBeenCalled();
    expect(notifyRenderer).not.toHaveBeenCalled();
    expect(handler.consumePending()).toBeNull();
  });

  it("reads a link from second-instance arguments", () => {
    const { handler } = createHandler();
    expect(handler.handleArgv(["app.exe", `buildwarden://project/${RUN_ID}`])).toBe(true);
    expect(handler.consumePending()?.target).toEqual({ kind: "project", projectId: RUN_ID });
  });
});

describe("registerDeepLinkProtocol", () => {
  it("registers packaged builds without extra arguments", () => {
    const setAsDefaultProtocolClient = vi.fn(() => true);
    expect(registerDeepLinkProtocol({ isPackaged: true, setAsDefaultProtocolClient }, "buildwarden")).toBe(true);
    expect(setAsDefaultProtocolClient).toHaveBeenCalledWith("buildwarden");
  });

  it("registers development builds with the app path so the OS starts this checkout", () => {
    const setAsDefaultProtocolClient = vi.fn(() => true);
    registerDeepLinkProtocol({ isPackaged: false, setAsDefaultProtocolClient }, "buildwarden-dev", ["electron.exe", "--inspect=0", "."], "electron.exe");
    expect(setAsDefaultProtocolClient).toHaveBeenCalledWith("buildwarden-dev", "electron.exe", [expect.any(String)]);
  });

  it("does not register when no app path is known", () => {
    const setAsDefaultProtocolClient = vi.fn(() => true);
    expect(registerDeepLinkProtocol({ isPackaged: false, setAsDefaultProtocolClient }, "buildwarden-dev", ["electron.exe", `buildwarden-dev://run/${RUN_ID}`])).toBe(false);
    expect(setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it("uses a separate scheme for development builds", () => {
    expect(deepLinkSchemeFor(true)).toBe("buildwarden");
    expect(deepLinkSchemeFor(false)).toBe("buildwarden-dev");
  });
});
