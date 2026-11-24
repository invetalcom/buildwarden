import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import { APP_SETTING_KEYS, DEFAULT_HOME_LAYOUT, DESIGN_SCHEME_PRESETS, parseDesignScheme, parseDesignSchemeJson, parseHomeLayout, serializeDesignScheme, serializeHomeLayout, type DesignScheme, type HomeLayout, type RunToolResult } from "@buildwarden/shared";
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

  it("keeps an image stored for a draft while an agent changes the design, until the draft is released", () => {
    const { call, service } = setup();
    const draft = service.setBackgroundImage({ mimeType: "image/png", data: OTHER_PNG.toString("base64") }) ?? undefined;
    expect(draft).toBeDefined();

    // No saved design names the draft image yet, and this change prunes unreferenced images.
    expect(call("buildwarden_theme_set", { colors: { primary: "#ff8800" } }).ok).toBe(true);
    expect(service.getBackgroundImage(draft)).toMatchObject({ token: draft });

    // The editor reports that the draft was saved or discarded.
    service.setBackgroundImage(null);
    expect(service.getBackgroundImage(draft)).toBeNull();
  });

  it("applies a design and announces it even when an old image cannot be deleted", () => {
    const { call, current, onDesignChanged, root } = setup();
    // A directory with an image's file name cannot be removed the way a file is.
    mkdirSync(join(root, "data", "design-background-bg-00000000000000ff.bin"), { recursive: true });

    expect(call("buildwarden_theme_set", { colors: { primary: "#ff8800" } }).ok).toBe(true);
    expect(current().colors.primary).toBe("#ff8800");
    expect(onDesignChanged).toHaveBeenCalledTimes(1);
  });

  it("leaves the design and its image alone when a reset names an unusable replacement", () => {
    const { call, current, root, service } = setup();
    const image = join(root, "wallpaper.png");
    writeFileSync(image, PNG);
    call("buildwarden_theme_set", { background: { imagePath: image } });
    const before = current();

    const result = call("buildwarden_theme_set", { resetCustomization: true, background: { imagePath: "relative.png" } });
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/absolute path/);
    expect(current()).toEqual(before);
    expect(service.getBackgroundImage()).toMatchObject({ token: before.customization?.background?.image });

    // A reset without a replacement still removes the image from the design.
    expect(call("buildwarden_theme_set", { resetCustomization: true }).ok).toBe(true);
    expect(current().customization).toBeUndefined();
    expect(service.getBackgroundImage()).toBeNull();
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

  it("offers the indicator looks, speed and theme images in the tool schema", () => {
    const properties = THEME_TOOLS[1]!.inputSchema.properties as Record<string, { properties?: Record<string, { enum?: unknown[] }>; items?: { properties?: Record<string, unknown> } }>;
    expect(properties.indicators!.properties!.spinner!.enum).toEqual(["circle", "ring", "dots", "bars", "pulse", "image", "shape", null]);
    expect(Object.keys(properties.motion!.properties!)).toEqual(["speed", "reduce"]);
    expect(Object.keys(properties.assets!.items!.properties!)).toEqual(["name", "svg", "path", "remove"]);
  });

  it("sets indicator looks and speed, reports an unknown look, and returns to the app's own through null", () => {
    const { call, current } = setup();
    const result = call("buildwarden_theme_set", { indicators: { spinner: "dots", runStatus: "sparkle", loadingBar: "slide" }, motion: { speed: 1.5, reduce: "system" } });
    expect(result.ok).toBe(true);
    expect(result.data!.ignored).toEqual(["indicators.runStatus"]);
    expect(current().customization).toEqual({ indicators: { spinner: "dots", loadingBar: "slide" }, motion: { speed: 1.5, reduce: "system" } });
    expect(call("buildwarden_theme_set", { indicators: { spinner: null }, motion: { speed: null } }).ok).toBe(true);
    expect(current().customization).toEqual({ indicators: { loadingBar: "slide" }, motion: { reduce: "system" } });
  });

  it("takes a theme image as SVG source or from a file, by what its bytes are", () => {
    const { call, current, root } = setup();
    const gifPath = join(root, "blink.png");
    writeFileSync(gifPath, Buffer.from("GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;", "latin1"));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"><animate attributeName="r" values="2;6;2" dur="1s" repeatCount="indefinite"/></circle></svg>';
    const result = call("buildwarden_theme_set", { assets: [{ name: "spinner", svg }, { name: "run-status-running", path: gifPath }], indicators: { spinner: "shape", runStatus: "image" } });
    expect(result.ok).toBe(true);
    const assets = current().customization!.assets!;
    expect(assets.spinner).toEqual({ type: "image/svg+xml", data: Buffer.from(svg).toString("base64") });
    // The file is named .png; its bytes are a GIF.
    expect(assets["run-status-running"]!.type).toBe("image/gif");
    expect(current().customization!.indicators).toEqual({ spinner: "shape", runStatus: "image" });

    expect(call("buildwarden_theme_set", { assets: [{ name: "spinner", remove: true }] }).ok).toBe(true);
    expect(Object.keys(current().customization!.assets!)).toEqual(["run-status-running"]);
  });

  it("refuses images that are too large, no image, badly named or missing, and changes nothing", () => {
    const { call, current, root, onDesignChanged } = setup();
    const big = join(root, "big.svg");
    writeFileSync(big, "<svg>" + "x".repeat(70 * 1024) + "</svg>");
    const text = join(root, "notes.txt");
    writeFileSync(text, "not an image");
    expect(call("buildwarden_theme_set", { assets: [{ name: "spinner", path: big }] }).content).toContain("limited to 64 KB");
    expect(call("buildwarden_theme_set", { assets: [{ name: "spinner", path: text }] }).content).toContain("SVG, GIF, PNG or WebP");
    expect(call("buildwarden_theme_set", { assets: [{ name: "spinner", path: join(root, "missing.gif") }] }).content).toContain("no image file");
    expect(call("buildwarden_theme_set", { assets: [{ name: "spinner", path: "relative.gif" }] }).content).toContain("absolute path");
    expect(call("buildwarden_theme_set", { assets: [{ name: "My Spinner", svg: "<svg/>" }] }).content).toContain("lower-case words");
    expect(call("buildwarden_theme_set", { assets: [{ name: "spinner", svg: "<p>hello</p>" }] }).content).toContain("does not match");
    expect(call("buildwarden_theme_set", { assets: [{ name: "spinner" }] }).content).toContain("needs svg, path or remove");
    // One bad entry refuses the whole call, the good one before it included.
    expect(call("buildwarden_theme_set", { colors: { primary: "#ff8800" }, assets: [{ name: "ok", svg: "<svg/>" }, { name: "bad", svg: "nope" }] }).ok).toBe(false);
    expect(current().customization).toBeUndefined();
    expect(current().colors.primary).toBe(DESIGN_SCHEME_PRESETS[0]!.colors.primary);
    expect(onDesignChanged).not.toHaveBeenCalled();
  });

  it("applies the size limit to all images of the theme together", () => {
    const { call, current } = setup();
    const svg = (size: number) => "<svg>" + "x".repeat(size) + "</svg>";
    const first = call("buildwarden_theme_set", { assets: ["a", "b", "c", "d"].map((name) => ({ name, svg: svg(60 * 1024) })) });
    expect(first.ok).toBe(true);
    expect(call("buildwarden_theme_set", { assets: [{ name: "e", svg: svg(60 * 1024) }] }).content).toContain("256 KB together");
    // Replacing one of them and removing another in the same call makes room.
    expect(call("buildwarden_theme_set", { assets: [{ name: "a", remove: true }, { name: "e", svg: svg(60 * 1024) }] }).ok).toBe(true);
    expect(Object.keys(current().customization!.assets!).sort()).toEqual(["b", "c", "d", "e"]);
  });

  it("tells the agent which images the theme has without sending their bytes", () => {
    const { call } = setup();
    const svg = "<svg>" + "y".repeat(2000) + "</svg>";
    call("buildwarden_theme_set", { assets: [{ name: "stars", svg }], indicators: { spinner: "ring" } });
    const read = call("buildwarden_theme_read");
    expect(read.data!.assets).toEqual([{ name: "stars", type: "image/svg+xml", bytes: svg.length }]);
    expect((read.data!.current as DesignScheme).customization).toEqual({ indicators: { spinner: "ring" } });
    expect(read.content).not.toContain(Buffer.from(svg).toString("base64").slice(0, 200));
    expect(read.data!.guide).toContain("indicators.<key>");
  });

  it("reads the Home layout and documents it in the guide", () => {
    const { call, settings } = setup();
    settings[APP_SETTING_KEYS.homeLayout] = serializeHomeLayout({ ...DEFAULT_HOME_LAYOUT, recentRuns: 5 });
    const { data } = call("buildwarden_theme_read");
    expect((data!.home as HomeLayout).recentRuns).toBe(5);
    expect((data!.home as HomeLayout).sections).toEqual(DEFAULT_HOME_LAYOUT.sections);
    expect(data!.guide).toContain("home.sections");
    expect(data!.guide).toContain('[data-ui="home-chart-lane"]');
  });

  it("changes only the Home page, leaves the theme alone, and can undo it", () => {
    const { call, current, settings, onDesignChanged } = setup();
    const home = () => parseHomeLayout(settings[APP_SETTING_KEYS.homeLayout]);
    const result = call("buildwarden_theme_set", { home: { sections: ["greeting", "nonsense"], chart: { metrics: ["cost"], range: 14 }, width: 250 } });
    expect(result.ok).toBe(true);
    expect(home().sections).toEqual(["greeting"]);
    expect(home().chart).toEqual({ show: true, metrics: ["cost"], range: 14 });
    expect(home().width).toBe(100);
    expect(home().stats).toEqual(DEFAULT_HOME_LAYOUT.stats);
    expect(result.data!.ignored).toEqual(["home.sections[1]"]);
    // The theme keeps its preset: a Home change must not turn it into a custom one.
    expect(current().id).toBe("midnight-blue");
    expect(settings[APP_SETTING_KEYS.designSchemeBeforeAgent]).toBeUndefined();
    expect(onDesignChanged).toHaveBeenCalledTimes(1);

    expect(call("buildwarden_theme_set", { restorePrevious: true }).data!.homeRestored).toBe(true);
    expect(home()).toEqual(DEFAULT_HOME_LAYOUT);
    expect(current().id).toBe("midnight-blue");
    // Undoing twice brings the change back, as it does for the theme.
    call("buildwarden_theme_set", { restorePrevious: true });
    expect(home().sections).toEqual(["greeting"]);
    // None of this touched the design, so there is no agent change to the design to undo.
    expect(settings[APP_SETTING_KEYS.designSchemeBeforeAgent]).toBeUndefined();
  });

  it("treats flags sent with their default value as a Home-only change", () => {
    const { call, current, settings } = setup();
    const result = call("buildwarden_theme_set", { home: { position: "top" }, restorePrevious: false, resetCustomization: false });
    expect(result.ok).toBe(true);
    expect(parseHomeLayout(settings[APP_SETTING_KEYS.homeLayout]).position).toBe("top");
    expect(current().id).toBe("midnight-blue");
    expect(current().name).toBe(DESIGN_SCHEME_PRESETS[0]!.name);
    expect(settings[APP_SETTING_KEYS.designSchemeBeforeAgent]).toBeUndefined();
  });

  it("merges into the stored Home layout and resets it with null", () => {
    const { call, settings } = setup();
    const home = () => parseHomeLayout(settings[APP_SETTING_KEYS.homeLayout]);
    call("buildwarden_theme_set", { home: { recentRuns: 6 } });
    call("buildwarden_theme_set", { home: { greetingText: "  Hello  ", stats: [] } });
    expect(home().recentRuns).toBe(6);
    expect(home().greetingText).toBe("Hello");
    // An empty list of figures is refused; the stored one stays.
    expect(home().stats).toEqual(DEFAULT_HOME_LAYOUT.stats);
    call("buildwarden_theme_set", { home: { recentRuns: null } });
    expect(home().recentRuns).toBe(DEFAULT_HOME_LAYOUT.recentRuns);
    expect(home().greetingText).toBe("Hello");
    call("buildwarden_theme_set", { home: null });
    expect(home()).toEqual(DEFAULT_HOME_LAYOUT);
    expect(call("buildwarden_theme_set", { home: "minimal" }).ok).toBe(false);
  });

  it("changes theme and Home in one call and undoes both together", () => {
    const { call, current, settings } = setup();
    const home = () => parseHomeLayout(settings[APP_SETTING_KEYS.homeLayout]);
    call("buildwarden_theme_set", { shape: { radius: 1.5 }, home: { position: "top" } });
    expect(current().customization).toEqual({ shape: { radius: 1.5 } });
    expect(home().position).toBe("top");
    call("buildwarden_theme_set", { restorePrevious: true });
    expect(current().customization).toBeUndefined();
    expect(home().position).toBe("center");
  });

  it("keeps Home through presets and resets, and does not undo what the user arranged since", () => {
    const { call, settings } = setup();
    const home = () => parseHomeLayout(settings[APP_SETTING_KEYS.homeLayout]);
    call("buildwarden_theme_set", { home: { recentRuns: 8 } });
    call("buildwarden_theme_set", { preset: DESIGN_SCHEME_PRESETS[1]!.id, resetCustomization: true });
    expect(home().recentRuns).toBe(8);
    // The user rearranges Home; undoing the theme change must leave that alone.
    settings[APP_SETTING_KEYS.homeLayout] = serializeHomeLayout({ ...home(), recentRuns: 2 });
    expect(call("buildwarden_theme_set", { restorePrevious: true }).data!.homeRestored).toBeUndefined();
    expect(home().recentRuns).toBe(2);
  });

  it("still undoes a Home change after the user saved a theme themselves", () => {
    const { call, current, settings } = setup();
    const home = () => parseHomeLayout(settings[APP_SETTING_KEYS.homeLayout]);
    call("buildwarden_theme_set", { home: { position: "top" } });
    // Saving a theme in the app clears the theme's undo snapshot and leaves the one of Home.
    settings[APP_SETTING_KEYS.designSchemePrevious] = "";
    expect(call("buildwarden_theme_read").data!.canRestorePrevious).toBe(true);

    const result = call("buildwarden_theme_set", { restorePrevious: true });
    expect(result.data).toEqual({ applied: true, homeRestored: true });
    expect(home().position).toBe("center");
    expect(current().id).toBe("midnight-blue");
    expect(settings[APP_SETTING_KEYS.designSchemeBeforeAgent]).toBeUndefined();

    // With neither snapshot there is nothing to undo.
    settings[APP_SETTING_KEYS.homeLayoutPrevious] = "";
    expect(call("buildwarden_theme_read").data!.canRestorePrevious).toBe(false);
    expect(call("buildwarden_theme_set", { restorePrevious: true }).ok).toBe(false);
  });

  it("drops indicator looks and images with the rest of the customization", () => {
    const { call, current } = setup();
    call("buildwarden_theme_set", { assets: [{ name: "stars", svg: "<svg/>" }], indicators: { spinner: "ring" }, motion: { speed: 2 } });
    expect(call("buildwarden_theme_set", { resetCustomization: true, shape: { radius: 1.2 } }).ok).toBe(true);
    expect(current().customization).toEqual({ shape: { radius: 1.2 } });
  });
});
