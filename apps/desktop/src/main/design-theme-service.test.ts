import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import { APP_SETTING_KEYS, DESIGN_SCHEME_PRESETS, parseDesignScheme, parseDesignSchemeJson, serializeDesignScheme, type DesignScheme, type RunToolResult } from "@buildwarden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppController } from "./app-controller";
import { DesignThemeService, THEME_TOOLS, detectDesignImageMimeType } from "./design-theme-service";
import { HostEventBus } from "./host-events";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const OTHER_PNG = Buffer.concat([PNG, Buffer.from([1])]);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const setup = (initial: DesignScheme = DESIGN_SCHEME_PRESETS[0]!) => {
  const root = mkdtempSync(join(tmpdir(), "buildwarden-theme-"));
  roots.push(root);
  const settings: Record<string, string> = { [APP_SETTING_KEYS.designScheme]: serializeDesignScheme(initial) };
  const onDesignChanged = vi.fn();
  const service = new DesignThemeService({
    dataDirPath: join(root, "data"),
    getSettings: () => settings,
    setSetting: (key, value) => { settings[key] = value; },
    onDesignChanged,
  });
  const call = (name: "buildwarden_theme_read" | "buildwarden_theme_set", args: Record<string, unknown> = {}) => {
    const result = service.executeTool("call-1", name, args);
    return { ...result, data: result.ok ? JSON.parse(result.content) as Record<string, unknown> : null };
  };
  return { root, settings, service, call, onDesignChanged, current: () => parseDesignScheme(settings) };
};

describe("DesignThemeService tools", () => {
  it("offers a read tool and a set tool with a schema for every element", () => {
    expect(THEME_TOOLS.map((tool) => tool.name)).toEqual(["buildwarden_theme_read", "buildwarden_theme_set"]);
    const properties = (THEME_TOOLS[1]!.inputSchema.properties as Record<string, { properties?: Record<string, unknown> }>);
    expect(Object.keys(properties.elements!.properties!)).toContain("sidebar");
  });

  it("reads the active theme, the presets and the guide", () => {
    const { call } = setup();
    const { data } = call("buildwarden_theme_read");
    expect((data!.current as DesignScheme).id).toBe("midnight-blue");
    expect(data!.presets).toHaveLength(DESIGN_SCHEME_PRESETS.length);
    expect(data!.guide).toContain('[data-ui="sidebar"]');
    expect(data!.hasBackgroundImage).toBe(false);
  });

  it("merges a change into the active theme, keeps the rest, and can undo it", () => {
    const { call, current, onDesignChanged, settings } = setup();
    const result = call("buildwarden_theme_set", { colors: { primary: "#FF8800" }, elements: { sidebar: { background: "#101010" } }, shape: { radius: 1.6 } });
    expect(result.ok).toBe(true);
    expect(current().id).toBe("custom");
    expect(current().colors.primary).toBe("#ff8800");
    expect(current().colors.background).toBe(DESIGN_SCHEME_PRESETS[0]!.colors.background);
    expect(current().customization).toEqual({ elements: { sidebar: { background: "#101010" } }, shape: { radius: 1.6 } });
    expect(settings[APP_SETTING_KEYS.uiTheme]).toBe("dark");
    expect(onDesignChanged).toHaveBeenCalledTimes(1);

    call("buildwarden_theme_set", { elements: { sidebar: null }, shape: { borders: 0 } });
    expect(current().customization).toEqual({ shape: { radius: 1.6, borders: 0 } });

    expect(call("buildwarden_theme_set", { restorePrevious: true }).ok).toBe(true);
    expect(current().customization).toEqual({ elements: { sidebar: { background: "#101010" } }, shape: { radius: 1.6 } });
  });

  it("accepts color sets and layout options, and reports unknown keys in them", () => {
    const { call, current } = setup();
    const properties = THEME_TOOLS[1]!.inputSchema.properties as Record<string, { properties?: Record<string, unknown> }>;
    expect(Object.keys(properties.syntax!.properties!)).toContain("keyword");
    expect(Object.keys(properties.layout!.properties!)).toEqual(["scale", "density", "sidebar", "statusBar", "sidebarFullHeight", "composerWidth", "composerHeight", "runDockGap", "transcriptWidth", "scrollbar", "statusBarHeight", "runHeader", "runHeaderItems"]);

    const result = call("buildwarden_theme_set", {
      syntax: { keyword: "#FF7B72", nonsense: "#000000" },
      terminal: { red: "#ff5555" },
      layout: { density: "comfortable", sidebar: "right", scale: 1.1 },
      shape: { shadow: 0.4 },
    });
    expect(result.ok).toBe(true);
    expect(result.data!.ignored).toEqual(["syntax.nonsense"]);
    expect(current().customization).toEqual({
      syntax: { keyword: "#ff7b72" },
      terminal: { red: "#ff5555" },
      layout: { density: "comfortable", sidebar: "right", scale: 1.1 },
      shape: { shadow: 0.4 },
    });

    call("buildwarden_theme_set", { syntax: null, layout: { sidebar: null } });
    expect(current().customization).toEqual({ terminal: { red: "#ff5555" }, layout: { density: "comfortable", scale: 1.1 }, shape: { shadow: 0.4 } });
  });

  it("switches to a preset by id and keeps the id when nothing else changes", () => {
    const { call, current, settings } = setup();
    expect(call("buildwarden_theme_set", { preset: "arctic-blue" }).ok).toBe(true);
    expect(current().id).toBe("arctic-blue");
    expect(settings[APP_SETTING_KEYS.darkMode]).toBe("false");
    expect(call("buildwarden_theme_set", { preset: "nope" })).toMatchObject({ ok: false });
  });

  it("reports ignored fields and warns about unreadable text instead of failing", () => {
    const { call } = setup();
    const { data } = call("buildwarden_theme_set", { colors: { primary: "blue", text: "#101010" }, elements: { sidebar: { glow: "#ffffff" }, footer: { background: "#000000" } } });
    expect(data!.ignored).toEqual(["colors.primary", "elements.sidebar.glow", "elements.footer"]);
    expect((data!.warnings as string[])[0]).toMatch(/low contrast/);
  });

  it("refuses css that could load remote files and leaves the theme untouched", () => {
    const { call, current, onDesignChanged } = setup();
    const result = call("buildwarden_theme_set", { css: "body { background: url(https://example.com/track.png) }" });
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/cannot load files/);
    expect(current().id).toBe("midnight-blue");
    expect(onDesignChanged).not.toHaveBeenCalled();
  });

  it("stores a background image from an absolute path and removes it again", () => {
    const { call, current, root, service } = setup();
    const image = join(root, "wallpaper.png");
    writeFileSync(image, PNG);
    expect(call("buildwarden_theme_set", { background: { imagePath: image, dim: 0.6 } }).ok).toBe(true);
    const stored = service.getBackgroundImage();
    expect(stored?.mimeType).toBe("image/png");
    expect(current().customization?.background).toEqual({ image: stored?.token, dim: 0.6 });

    expect(call("buildwarden_theme_set", { background: { remove: true } }).ok).toBe(true);
    expect(service.getBackgroundImage()).toBeNull();
    expect(current().customization?.background).toEqual({ dim: 0.6 });
  });

  it("keeps the image of an earlier design, so undoing a change brings it back", () => {
    const { call, current, root, service } = setup();
    const first = join(root, "first.png");
    const second = join(root, "second.png");
    writeFileSync(first, PNG);
    writeFileSync(second, OTHER_PNG);
    call("buildwarden_theme_set", { background: { imagePath: first } });
    const firstToken = current().customization?.background?.image;
    call("buildwarden_theme_set", { background: { imagePath: second } });
    expect(current().customization?.background?.image).not.toBe(firstToken);

    expect(call("buildwarden_theme_set", { restorePrevious: true }).ok).toBe(true);
    expect(current().customization?.background?.image).toBe(firstToken);
    expect(service.getBackgroundImage()).toMatchObject({ token: firstToken, data: PNG.toString("base64") });

    // Removing the image keeps its file too, because the undo snapshot still names it.
    call("buildwarden_theme_set", { background: { remove: true } });
    expect(service.getBackgroundImage()).toBeNull();
    call("buildwarden_theme_set", { restorePrevious: true });
    expect(service.getBackgroundImage()).toMatchObject({ token: firstToken });
  });

  it("deletes stored images once no design and no undo snapshot refers to them", () => {
    const { call, root, service, settings } = setup();
    const image = join(root, "wallpaper.png");
    writeFileSync(image, PNG);
    call("buildwarden_theme_set", { background: { imagePath: image } });
    call("buildwarden_theme_set", { background: { remove: true } });
    const stored = () => readdirSync(join(root, "data")).filter((entry) => entry.startsWith("design-background-"));
    expect(stored()).toHaveLength(1);

    // Saving a design by hand clears both undo snapshots.
    settings[APP_SETTING_KEYS.designSchemePrevious] = "";
    settings[APP_SETTING_KEYS.designSchemeBeforeAgent] = "";
    service.setBackgroundImage(null);
    expect(stored()).toHaveLength(0);
  });

  it("does not replace the saved image when another one is stored for a draft", () => {
    const { call, current, root, service } = setup();
    const image = join(root, "wallpaper.png");
    writeFileSync(image, PNG);
    call("buildwarden_theme_set", { background: { imagePath: image } });
    const saved = current().customization?.background?.image;

    const draft = service.setBackgroundImage({ mimeType: "image/png", data: OTHER_PNG.toString("base64") });
    expect(draft).not.toBe(saved);
    expect(service.getBackgroundImage()).toMatchObject({ token: saved, data: PNG.toString("base64") });
    expect(service.getBackgroundImage(draft ?? undefined)).toMatchObject({ token: draft });
  });

  it("refuses files that are not images, whatever their name says", () => {
    const { call, root, service } = setup();
    const fake = join(root, "notes.png");
    writeFileSync(fake, "this is text");
    expect(call("buildwarden_theme_set", { background: { imagePath: fake } })).toMatchObject({ ok: false });
    expect(call("buildwarden_theme_set", { background: { imagePath: "relative.png" } }).content).toMatch(/absolute path/);
    expect(() => service.setBackgroundImage({ mimeType: "image/png", data: Buffer.from("plain").toString("base64") })).toThrow(/PNG, JPEG, WebP or GIF/);
  });
});

describe("detectDesignImageMimeType", () => {
  it("recognizes supported formats by their first bytes", () => {
    expect(detectDesignImageMimeType(PNG)).toBe("image/png");
    expect(detectDesignImageMimeType(Buffer.from("ffd8ffe000104a46", "hex"))).toBe("image/jpeg");
    expect(detectDesignImageMimeType(Buffer.from("47494638396101000100", "hex"))).toBe("image/gif");
    expect(detectDesignImageMimeType(Buffer.from("524946462400000057454250", "hex"))).toBe("image/webp");
    expect(detectDesignImageMimeType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });
});

describe("theme tools in an agent run", () => {
  it("routes a run's theme tool call to the theme service and changes the stored design", async () => {
    const root = mkdtempSync(join(tmpdir(), "buildwarden-theme-run-"));
    roots.push(root);
    const db = new BuildWardenDatabase(join(root, "state.sqlite"));
    await db.init();
    try {
      const project = db.addProject({ repoPath: root, baseBranch: "project-folder", resolvedName: "Project", kind: "folder" });
      const provider = db.addProviderAccount({ providerType: "codex-cli", label: "Codex", apiBaseUrl: null, apiKeyRef: "", configJson: "{}" });
      const model = db.addModel({ providerAccountId: provider.id, modelId: "test", displayName: "Test", config: {}, capabilities: {}, enabled: true });
      const run = db.createRun({
        projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server", mode: "ask",
        workspaceType: "local", workspaceVcs: "folder", prompt: "Make BuildWarden warmer", branchName: "project-folder", worktreePath: root,
      });
      const onDesignChanged = vi.fn();
      const theme = new DesignThemeService({
        dataDirPath: join(root, "data"),
        getSettings: () => db.getSettings(),
        setSetting: (key, value) => db.setSetting(key, value),
        onDesignChanged,
      });
      const controller = new AppController(db, { readSecret: async () => null, saveSecret: async () => undefined, deleteSecret: async () => undefined }, join(root, "logs"),
        { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
        { killForRunId: () => {} }, new HostEventBus(),
        { executeThemeTool: (callId, toolName, args) => theme.executeTool(callId, toolName, args) });
      const internals = controller as unknown as {
        runWorkers: Map<string, { worker: unknown }>;
        handleRunWorkerHostToolRequest(runId: string, worker: unknown, payload: unknown): Promise<void>;
      };
      const worker = { postMessage: vi.fn<(message: { type: string; callId: string; result: RunToolResult }) => void>() };
      internals.runWorkers.set(run.id, { worker });

      await internals.handleRunWorkerHostToolRequest(run.id, worker, {
        type: "host-tool-request", callId: "call-7", toolName: "buildwarden_theme_set",
        arguments: { name: "Warm", colors: { primary: "#e0a458" }, shape: { radius: 1.4 } },
      });

      const response = worker.postMessage.mock.calls[0]![0];
      expect(response).toMatchObject({ type: "host-tool-response", callId: "call-7", result: { name: "buildwarden_theme_set", ok: true } });
      const stored = parseDesignScheme(db.getSettings());
      expect(stored).toMatchObject({ id: "custom", name: "Warm", customization: { shape: { radius: 1.4 } } });
      expect(stored.colors.primary).toBe("#e0a458");
      expect(onDesignChanged).toHaveBeenCalledTimes(1);

      // A second agent change keeps the user's own design as the one to go back to.
      await internals.handleRunWorkerHostToolRequest(run.id, worker, {
        type: "host-tool-request", callId: "call-8", toolName: "buildwarden_theme_set", arguments: { name: "Warmer", colors: { primary: "#ff8800" } },
      });
      expect(parseDesignSchemeJson(db.getSettings()[APP_SETTING_KEYS.designSchemeBeforeAgent])?.id).toBe("midnight-blue");
      expect(parseDesignSchemeJson(db.getSettings()[APP_SETTING_KEYS.designSchemePrevious])?.name).toBe("Warm");

      // Once the user saves a design themselves, nothing is left to undo.
      await controller.setAppSetting(APP_SETTING_KEYS.designScheme, serializeDesignScheme(DESIGN_SCHEME_PRESETS[0]!));
      expect(db.getSettings()[APP_SETTING_KEYS.designSchemeBeforeAgent]).toBe("");
      expect(db.getSettings()[APP_SETTING_KEYS.designSchemePrevious]).toBe("");
      expect(parseDesignScheme(db.getSettings()).id).toBe("midnight-blue");
    } finally {
      await db.close();
    }
  });
});
