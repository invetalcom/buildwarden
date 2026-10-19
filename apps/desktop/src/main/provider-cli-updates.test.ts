import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderCliUpdateSnapshot, ProviderCliUpdateStatus } from "@buildwarden/shared";
import {
  ProviderCliUpdateService,
  resolveProviderCliProcessLaunch,
  type ProviderCliProcessResult,
  type ProviderCliUpdateServiceDeps,
} from "./provider-cli-updates";

const CLAUDE = "/home/dev/.local/bin/claude";

const createHarness = (options: {
  state?: string;
  enabled?: boolean;
  notify?: boolean;
  installed?: string;
  latest?: string;
  stable?: string;
  releaseChannel?: "latest" | "stable";
} = {}) => {
  let settings = { enabled: options.enabled ?? false, notify: options.notify ?? true };
  let state: string | undefined = options.state;
  let installed = options.installed ?? "2.1.302";
  let latest = options.latest ?? "2.1.303";
  const stable = options.stable ?? "2.1.292";
  const channel = options.releaseChannel ?? "latest";
  let inUse = false;
  const fetchText = vi.fn(async (url: string) =>
    url.includes("registry.npmjs.org") ? JSON.stringify({ version: url.endsWith("/stable") ? stable : latest }) : "");
  const runProcess = vi.fn(async (command: { file: string; args: string[] }): Promise<ProviderCliProcessResult> => {
    if (command.args[0] === "--version") return { code: 0, output: `${installed} (Claude Code)`, timedOut: false };
    // Like `claude update`, the updater installs the newest build on the configured channel.
    installed = channel === "stable" ? stable : latest;
    return { code: 0, output: "Updated", timedOut: false };
  });
  const onUpdateAvailable = vi.fn<(status: ProviderCliUpdateStatus) => void>();
  const onProviderUpdated = vi.fn();
  const snapshots: ProviderCliUpdateSnapshot[] = [];
  const deps: ProviderCliUpdateServiceDeps = {
    readSettings: () => settings,
    readState: () => state,
    writeState: (value) => { state = value; },
    listTargets: () => [{ providerType: "claude-code", binaryPath: CLAUDE, ...(options.releaseChannel ? { releaseChannel: options.releaseChannel } : {}) }],
    isProviderInUse: () => inUse,
    fetchText,
    resolveUpdateEnv: async () => ({ PATH: "/usr/bin" }),
    runProcess,
    realPath: (path) => path,
    probe: { exists: (path) => path === CLAUDE, isWritable: () => true },
    platform: "linux",
    homeDir: "/home/dev",
    env: { PATH: "/usr/bin" },
    now: () => new Date("2026-10-19T08:00:00Z"),
    onChange: (snapshot) => snapshots.push(snapshot),
    onUpdateAvailable,
    onProviderUpdated,
    warn: () => undefined,
  };
  const service = new ProviderCliUpdateService(deps);
  return {
    service, fetchText, runProcess, onUpdateAvailable, onProviderUpdated, snapshots,
    setSettings: (next: Partial<typeof settings>) => { settings = { ...settings, ...next }; },
    setInUse: (value: boolean) => { inUse = value; },
    setInstalled: (value: string) => { installed = value; },
    setLatest: (value: string) => { latest = value; },
  };
};

describe("provider CLI update service", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("makes no requests and spawns nothing while disabled", async () => {
    const harness = createHarness();
    harness.service.start();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    await expect(harness.service.check()).rejects.toThrow("turned off");
    await expect(harness.service.update("claude-code")).rejects.toThrow("turned off");
    expect(harness.fetchText).not.toHaveBeenCalled();
    expect(harness.runProcess).not.toHaveBeenCalled();
    expect(harness.service.getSnapshot()).toMatchObject({ enabled: false, providers: [] });
    expect(harness.service.attentionItems()).toEqual([]);
  });

  it("waits after startup, then reports an update, notifies once, and adds an inbox notice", async () => {
    const harness = createHarness({ enabled: true });
    harness.service.start();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(harness.fetchText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);

    const [status] = harness.service.getSnapshot().providers;
    expect(status).toMatchObject({ state: "update-available", installedVersion: "2.1.302", latestVersion: "2.1.303", installMethod: "native", canAutoUpdate: true });
    expect(harness.fetchText).toHaveBeenCalledWith("https://registry.npmjs.org/@anthropic-ai/claude-code/latest", expect.any(AbortSignal));
    expect(harness.onUpdateAvailable).toHaveBeenCalledTimes(1);
    expect(harness.service.attentionItems()).toMatchObject([{
      id: "provider-update:claude-code:2.1.303", kind: "update", projectId: null, runId: null, dismissible: true,
      providerUpdate: { providerType: "claude-code", latestVersion: "2.1.303", canAutoUpdate: true },
    }]);

    await harness.service.check();
    expect(harness.onUpdateAvailable).toHaveBeenCalledTimes(1);
  });

  it("respects the notification toggle without losing the inbox notice", async () => {
    const harness = createHarness({ enabled: true, notify: false });
    await harness.service.check("background");
    expect(harness.onUpdateAvailable).not.toHaveBeenCalled();
    expect(harness.service.getSnapshot().providers[0].announced).toBe(false);
    expect(harness.service.attentionItems()).toHaveLength(1);
  });

  it("announces a version found while notifications were off once they are turned on", async () => {
    const harness = createHarness({ enabled: true, notify: false });
    await harness.service.check("background");
    harness.setSettings({ notify: true });
    await harness.service.check("background");
    expect(harness.onUpdateAvailable).toHaveBeenCalledTimes(1);
    expect(harness.service.getSnapshot().providers[0].announced).toBe(true);
  });

  it("does not notify for manual checks, but the next background check still announces the version", async () => {
    const harness = createHarness({ enabled: true });
    await harness.service.check();
    expect(harness.onUpdateAvailable).not.toHaveBeenCalled();
    expect(harness.service.getSnapshot().providers[0].announced).toBe(false);
    expect(harness.service.attentionItems()).toHaveLength(1);
    await harness.service.check("background");
    expect(harness.onUpdateAvailable).toHaveBeenCalledTimes(1);
    expect(harness.service.getSnapshot().providers[0].announced).toBe(true);
    await harness.service.check("background");
    expect(harness.onUpdateAvailable).toHaveBeenCalledTimes(1);
  });

  it("ignores the notified list stored by older builds", async () => {
    const harness = createHarness({ enabled: true, state: JSON.stringify({ dismissed: [], notified: ["provider-update:claude-code:2.1.303"] }) });
    await harness.service.check("background");
    expect(harness.onUpdateAvailable).toHaveBeenCalledTimes(1);
  });

  it("treats a manual request that joins a running background check as manual", async () => {
    const harness = createHarness({ enabled: true });
    const background = harness.service.check("background");
    const manual = harness.service.check();
    await Promise.all([background, manual]);
    expect(harness.onUpdateAvailable).not.toHaveBeenCalled();
  });

  it("does not notify for the check that runs right after turning the feature on", async () => {
    const harness = createHarness();
    harness.service.start();
    harness.setSettings({ enabled: true });
    harness.service.applySettings();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.service.getSnapshot().providers[0].state).toBe("update-available");
    expect(harness.onUpdateAvailable).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000);
    expect(harness.onUpdateAvailable).toHaveBeenCalledTimes(1);
  });

  it("hides a dismissed version but shows the next release", async () => {
    const harness = createHarness({ enabled: true });
    await harness.service.check("background");
    expect(harness.service.dismiss(["provider-update:claude-code:2.1.303", "run:abc"])).toEqual(["run:abc"]);
    expect(harness.service.attentionItems()).toEqual([]);
    expect(harness.service.getSnapshot().providers[0].dismissed).toBe(true);
    await harness.service.check("background");
    expect(harness.service.attentionItems()).toEqual([]);
    harness.setLatest("2.1.304");
    await harness.service.check("background");
    expect(harness.service.attentionItems().map((item) => item.id)).toEqual(["provider-update:claude-code:2.1.304"]);
    expect(harness.onUpdateAvailable).toHaveBeenCalledTimes(2);
  });

  it("checks soon after being turned on and clears statuses when turned off", async () => {
    const harness = createHarness();
    harness.service.start();
    harness.setSettings({ enabled: true });
    harness.service.applySettings();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.service.getSnapshot().providers).toHaveLength(1);

    harness.setSettings({ enabled: false });
    harness.service.applySettings();
    expect(harness.service.getSnapshot()).toMatchObject({ enabled: false, providers: [] });
    harness.fetchText.mockClear();
    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1_000);
    expect(harness.fetchText).not.toHaveBeenCalled();
  });

  it("refuses to update while a run or chat uses the CLI", async () => {
    const harness = createHarness({ enabled: true });
    await harness.service.check();
    harness.setInUse(true);
    expect(harness.service.getSnapshot().providers[0].inUse).toBe(true);
    await expect(harness.service.update("claude-code")).rejects.toThrow("in use");
    expect(harness.runProcess).not.toHaveBeenCalledWith(expect.objectContaining({ args: ["update"] }), expect.anything());
  });

  it("publishes usage changes once per change and marks busy CLIs on inbox notices", async () => {
    const harness = createHarness({ enabled: true });
    await harness.service.check();
    const published = harness.snapshots.length;
    harness.service.refreshUsage();
    expect(harness.snapshots).toHaveLength(published + 1);
    harness.service.refreshUsage();
    expect(harness.snapshots).toHaveLength(published + 1);
    harness.setInUse(true);
    harness.service.refreshUsage();
    expect(harness.snapshots).toHaveLength(published + 2);
    expect(harness.snapshots.at(-1)?.providers[0].inUse).toBe(true);
    expect(harness.service.attentionItems()[0].providerUpdate?.inUse).toBe(true);
  });

  it("stays silent about usage while checks are off", () => {
    const harness = createHarness();
    harness.service.refreshUsage();
    expect(harness.snapshots).toHaveLength(0);
  });

  it("reports the CLI as updating until the updater finishes", async () => {
    const harness = createHarness({ enabled: true });
    await harness.service.check();
    let finish: (result: ProviderCliProcessResult) => void = () => undefined;
    harness.runProcess.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = harness.service.update("claude-code");
    await vi.waitFor(() => expect(harness.service.isUpdating("claude-code")).toBe(true));
    expect(harness.service.isUpdating("codex-cli")).toBe(false);
    harness.setInstalled("2.1.303");
    finish({ code: 0, output: "Updated", timedOut: false });
    await pending;
    expect(harness.service.isUpdating("claude-code")).toBe(false);
  });

  it("compares stable-channel installs against the stable release and updates to it", async () => {
    const harness = createHarness({ enabled: true, releaseChannel: "stable", installed: "2.1.290" });
    await harness.service.check();
    expect(harness.fetchText).toHaveBeenCalledWith("https://registry.npmjs.org/@anthropic-ai/claude-code/stable", expect.any(AbortSignal));
    expect(harness.service.getSnapshot().providers[0]).toMatchObject({ state: "update-available", latestVersion: "2.1.292", releaseChannel: "stable" });
    const snapshot = await harness.service.update("claude-code");
    expect(snapshot.providers[0]).toMatchObject({ state: "current", installedVersion: "2.1.292", message: "Updated to v2.1.292." });
  });

  it("treats a stable-channel install as current even when latest is newer", async () => {
    const harness = createHarness({ enabled: true, releaseChannel: "stable", installed: "2.1.292" });
    await harness.service.check();
    expect(harness.service.getSnapshot().providers[0]).toMatchObject({ state: "current", latestVersion: "2.1.292" });
    expect(harness.service.attentionItems()).toEqual([]);
  });

  it("puts the CLI folder on PATH for the version check so npm-style CLIs find their Node", async () => {
    const harness = createHarness({ enabled: true });
    await harness.service.check();
    expect(harness.runProcess).toHaveBeenCalledWith(
      { file: CLAUDE, args: ["--version"] },
      expect.objectContaining({ env: expect.objectContaining({ PATH: "/home/dev/.local/bin:/usr/bin" }) }),
    );
  });

  it("runs the owning updater, verifies the new version, and clears the notice", async () => {
    const harness = createHarness({ enabled: true });
    await harness.service.check();
    const snapshot = await harness.service.update("claude-code");
    expect(harness.runProcess).toHaveBeenCalledWith(
      { file: CLAUDE, args: ["update"] },
      expect.objectContaining({ env: expect.objectContaining({ PATH: "/home/dev/.local/bin:/usr/bin" }) }),
    );
    expect(snapshot.providers[0]).toMatchObject({ state: "current", installedVersion: "2.1.303", message: "Updated to v2.1.303." });
    expect(harness.onProviderUpdated).toHaveBeenCalledWith("claude-code");
    expect(harness.service.attentionItems()).toEqual([]);
  });

  it("reports an updater that exits cleanly without changing the version", async () => {
    const harness = createHarness({ enabled: true });
    await harness.service.check();
    harness.runProcess.mockImplementation(async (command) => ({
      code: 0, output: command.args[0] === "--version" ? "2.1.302" : "ok", timedOut: false,
    }));
    const snapshot = await harness.service.update("claude-code");
    expect(snapshot.providers[0]).toMatchObject({ state: "update-available", message: expect.stringContaining("still reports v2.1.302") });
    expect(harness.onProviderUpdated).not.toHaveBeenCalled();
  });

  it("surfaces updater failures and keeps the update available", async () => {
    const harness = createHarness({ enabled: true });
    await harness.service.check();
    harness.runProcess.mockImplementation(async (command) =>
      command.args[0] === "--version"
        ? { code: 0, output: "2.1.302", timedOut: false }
        : { code: 1, output: "npm ERR! EACCES: permission denied", timedOut: false });
    await expect(harness.service.update("claude-code")).rejects.toThrow("EACCES");
    expect(harness.service.getSnapshot().providers[0]).toMatchObject({ state: "update-available", message: expect.stringContaining("EACCES") });
  });

  it("reports an unreachable release feed as a failed check", async () => {
    const harness = createHarness({ enabled: true });
    harness.fetchText.mockRejectedValue(new Error("getaddrinfo ENOTFOUND registry.npmjs.org"));
    await harness.service.check();
    expect(harness.service.getSnapshot().providers[0]).toMatchObject({ state: "error", message: expect.stringContaining("ENOTFOUND") });
    expect(harness.service.attentionItems()).toEqual([]);
  });
});

describe("provider CLI process launch", () => {
  it("runs Windows command shims through cmd.exe with quoted arguments", () => {
    expect(resolveProviderCliProcessLaunch({ file: "C:\\nodejs\\npm.cmd", args: ["install", "--prefix", "C:\\Program Files\\nodejs"] }, "win32"))
      .toEqual({
        file: "cmd.exe",
        args: ["/d", "/c", 'call "C:\\nodejs\\npm.cmd" "install" "--prefix" "C:\\Program Files\\nodejs"'],
        windowsVerbatimArguments: true,
      });
    expect(() => resolveProviderCliProcessLaunch({ file: "C:\\npm.cmd", args: ["a&b"] }, "win32")).toThrow("metacharacters");
    expect(resolveProviderCliProcessLaunch({ file: "C:\\claude.exe", args: ["update"] }, "win32")).toEqual({ file: "C:\\claude.exe", args: ["update"] });
  });
});
