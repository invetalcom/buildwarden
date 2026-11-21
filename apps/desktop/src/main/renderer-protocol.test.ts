import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRendererRequestHandler, isRendererUrl, RENDERER_BLANK_URL, RENDERER_INDEX_URL, RENDERER_ORIGIN } from "./renderer-protocol";
import { migrateFileOriginRendererStorage } from "./renderer-storage-migration";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

describe("renderer protocol", () => {
  it("serves renderer files with their content types and nothing outside the renderer folder", async () => {
    // The renderer folder and the file it must not serve are siblings in a folder the test owns.
    const parent = await tempDir("bw-renderer-");
    const root = join(parent, "renderer");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<!doctype html><title>BuildWarden</title>");
    writeFileSync(join(root, "assets", "index-abc.js"), "export {};");
    writeFileSync(join(parent, "secret.txt"), "outside");
    const handle = createRendererRequestHandler(root);

    const index = await handle(new Request(RENDERER_INDEX_URL));
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await index.text()).toContain("BuildWarden");
    const script = await handle(new Request(`${RENDERER_ORIGIN}/assets/index-abc.js`));
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await (await handle(new Request(`${RENDERER_ORIGIN}/`))).text()).toContain("BuildWarden");
    expect((await handle(new Request(RENDERER_BLANK_URL))).status).toBe(200);

    expect((await handle(new Request(`${RENDERER_ORIGIN}/%2e%2e/secret.txt`))).status).toBe(404);
    expect((await handle(new Request(`${RENDERER_ORIGIN}/assets`))).status).toBe(404);
    expect((await handle(new Request(`${RENDERER_ORIGIN}/missing.js`))).status).toBe(404);
    expect((await handle(new Request("buildwarden-app://other/index.html"))).status).toBe(404);
    expect((await handle(new Request(RENDERER_INDEX_URL, { method: "POST", body: "x" }))).status).toBe(405);
  });

  it("recognizes only the renderer origin as the app", () => {
    expect(isRendererUrl(`${RENDERER_INDEX_URL}#/runs/r1`)).toBe(true);
    expect(isRendererUrl("buildwarden-app://elsewhere/index.html")).toBe(false);
    expect(isRendererUrl("https://bundle/index.html")).toBe(false);
  });
});

const fakeWindow = (exported: unknown, { failAttachments = false } = {}) => {
  const window = {
    loadFile: vi.fn(async () => {}),
    loadURL: vi.fn(async () => {}),
    destroy: vi.fn(),
    webContents: {
      executeJavaScript: vi.fn(async (code: string) => {
        if (code.includes("localStorage.key(")) return exported;
        if (code.includes("localStorage.setItem(")) return 1;
        if (failAttachments) throw new Error("IndexedDB is unavailable.");
        return 1;
      }),
      session: { flushStorageData: vi.fn() },
    },
  };
  return window;
};
const importScripts = (window: ReturnType<typeof fakeWindow>) =>
  window.webContents.executeJavaScript.mock.calls.map(([code]) => code).filter((code) => !code.includes("localStorage.key("));

describe("renderer storage migration", () => {
  it("copies file:// storage to the renderer origin once", async () => {
    const userDataPath = await tempDir("bw-userdata-");
    mkdirSync(join(userDataPath, "Local Storage"));
    const window = fakeWindow({ localStorage: [["draft", "text"]], attachments: [] });
    const log = vi.fn();
    const options = { userDataPath, createWindow: () => window, log, warn: vi.fn() };

    await migrateFileOriginRendererStorage(options);
    expect(window.loadFile).toHaveBeenCalledWith(join(userDataPath, "renderer-storage-export.html"));
    expect(window.loadURL).toHaveBeenCalledWith(RENDERER_BLANK_URL);
    expect(window.webContents.executeJavaScript.mock.calls[1]![0]).toContain(JSON.stringify([["draft", "text"]]));
    expect(window.webContents.session.flushStorageData).toHaveBeenCalledOnce();
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("Moved renderer storage to the renderer origin.", { keys: 1, attachments: 0 });
    expect(existsSync(join(userDataPath, "renderer-storage-export.html"))).toBe(false);

    await migrateFileOriginRendererStorage(options);
    expect(window.loadFile).toHaveBeenCalledOnce();
  });

  it("skips profiles without renderer storage and retries after a failure", async () => {
    const fresh = await tempDir("bw-userdata-");
    const createWindow = vi.fn(() => fakeWindow({ localStorage: [], attachments: [] }));
    await migrateFileOriginRendererStorage({ userDataPath: fresh, createWindow, log: vi.fn(), warn: vi.fn() });
    expect(createWindow).not.toHaveBeenCalled();

    const used = await tempDir("bw-userdata-");
    mkdirSync(join(used, "IndexedDB"));
    const broken = fakeWindow(null);
    const warn = vi.fn();
    await migrateFileOriginRendererStorage({ userDataPath: used, createWindow: () => broken, log: vi.fn(), warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(broken.destroy).toHaveBeenCalledOnce();
    const retry = fakeWindow({ localStorage: [], attachments: [] });
    await migrateFileOriginRendererStorage({ userDataPath: used, createWindow: () => retry, log: vi.fn(), warn });
    expect(retry.loadFile).toHaveBeenCalledOnce();
    // Nothing to copy: the renderer origin is left alone.
    expect(retry.loadURL).not.toHaveBeenCalled();
  });

  it("does not copy localStorage again when only the attachments need a retry", async () => {
    const userDataPath = await tempDir("bw-userdata-");
    mkdirSync(join(userDataPath, "Local Storage"));
    const exported = { localStorage: [["draft", "text"]], attachments: [{ id: "a1", type: "image/png", base64: "AA==" }] };
    const failed = fakeWindow(exported, { failAttachments: true });
    const warn = vi.fn();
    await migrateFileOriginRendererStorage({ userDataPath, createWindow: () => failed, log: vi.fn(), warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(importScripts(failed)).toHaveLength(2);

    // The renderer has run since, so a missing draft may have been submitted; it must stay gone.
    const retry = fakeWindow(exported);
    const log = vi.fn();
    await migrateFileOriginRendererStorage({ userDataPath, createWindow: () => retry, log, warn });
    expect(importScripts(retry)).toHaveLength(1);
    expect(importScripts(retry)[0]).not.toContain("localStorage.setItem(");
    expect(log).toHaveBeenCalledWith("Moved renderer storage to the renderer origin.", { keys: 0, attachments: 1 });
    expect(existsSync(join(userDataPath, "renderer-origin-migrated"))).toBe(true);
    expect(existsSync(join(userDataPath, "renderer-origin-local-storage-migrated"))).toBe(false);
  });
});
