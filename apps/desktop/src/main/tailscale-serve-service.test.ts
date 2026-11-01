import { APP_SETTING_KEYS, parseRemoteAccessExposure } from "@buildwarden/shared";
import { describe, expect, it, vi } from "vitest";
import {
  TailscaleServeService,
  type TailscaleCommandResult,
  type TailscaleCommandRunner,
  type TailscaleServeStateStore,
} from "./tailscale-serve-service";

const DNS_NAME = "buildwarden-host.example.ts.net";
const nodeStatus = (): TailscaleCommandResult => ({
  exitCode: 0,
  stderr: "",
  stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: `${DNS_NAME}.`, Online: true } }),
});

const createStore = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  const store: TailscaleServeStateStore = {
    read: (key) => values.get(key),
    write: (key, value) => values.set(key, value),
  };
  return { store, values };
};

const serveStatus = (target: string | null): TailscaleCommandResult => ({
  exitCode: 0,
  stderr: "",
  stdout: JSON.stringify(target ? {
    TCP: { 443: { HTTPS: true } },
    Web: { [`${DNS_NAME}:443`]: { Handlers: { "/": { Proxy: target } } } },
  } : {}),
});

describe("TailscaleServeService", () => {
  it("reports a missing CLI without changing settings", async () => {
    const { store, values } = createStore({ [APP_SETTING_KEYS.remoteAccessTailscaleEnabled]: "true" });
    const runner = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 1, notFound: true }));
    const service = new TailscaleServeService(store, runner, ["tailscale-test"]);

    await expect(service.getStatus(47831)).resolves.toMatchObject({
      desired: true,
      state: "not-installed",
      managed: false,
    });
    expect(values.get(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget)).toBeUndefined();
  });

  it("creates and verifies one exact background HTTPS root handler", async () => {
    const { store, values } = createStore({ [APP_SETTING_KEYS.remoteAccessTailscaleEnabled]: "true" });
    let target: string | null = null;
    const calls: string[][] = [];
    const runner: TailscaleCommandRunner = async (_executable, args) => {
      calls.push(args);
      if (args[0] === "status") return nodeStatus();
      if (args[0] === "serve" && args[1] === "status") return serveStatus(target);
      if (args.includes("--bg")) {
        target = args.at(-1) ?? null;
        return { stdout: "Serve started", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    };
    const service = new TailscaleServeService(store, runner, ["tailscale-test"]);

    await expect(service.enable(47831)).resolves.toMatchObject({
      state: "managed",
      endpoint: `https://${DNS_NAME}/`,
      managed: true,
      verified: true,
    });
    expect(calls).toContainEqual([
      "serve",
      "--bg",
      "--yes",
      "--https=443",
      "--set-path=/",
      "http://127.0.0.1:47831",
    ]);
    expect(values.get(APP_SETTING_KEYS.remoteAccessTailscaleManagedHost)).toBe(DNS_NAME);
    expect(values.get(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget)).toBe("http://127.0.0.1:47831");
  });

  it("refuses to replace another root handler", async () => {
    const { store } = createStore({ [APP_SETTING_KEYS.remoteAccessTailscaleEnabled]: "true" });
    const runner = vi.fn<TailscaleCommandRunner>(async (_executable, args) => {
      if (args[0] === "status") return nodeStatus();
      return serveStatus("http://127.0.0.1:9000");
    });
    const service = new TailscaleServeService(store, runner, ["tailscale-test"]);

    await expect(service.enable(47831)).resolves.toMatchObject({ state: "conflict", managed: false });
    expect(runner.mock.calls.some(([, args]) => args.includes("--bg"))).toBe(false);
    expect(runner.mock.calls.some(([, args]) => args.includes("reset"))).toBe(false);
  });

  it("removes only the exact handler recorded as BuildWarden-owned", async () => {
    const target = "http://127.0.0.1:47831";
    const { store, values } = createStore({
      [APP_SETTING_KEYS.remoteAccessTailscaleEnabled]: "false",
      [APP_SETTING_KEYS.remoteAccessTailscaleManagedHost]: DNS_NAME,
      [APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget]: target,
    });
    let configuredTarget: string | null = target;
    const calls: string[][] = [];
    const runner: TailscaleCommandRunner = async (_executable, args) => {
      calls.push(args);
      if (args[0] === "status") return nodeStatus();
      if (args[0] === "serve" && args[1] === "status") return serveStatus(configuredTarget);
      if (args.at(-1) === "off") {
        configuredTarget = null;
        return { stdout: "Serve disabled", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    };
    const service = new TailscaleServeService(store, runner, ["tailscale-test"]);

    await service.disable();

    expect(calls).toContainEqual(["serve", "--https=443", "--set-path=/", "off"]);
    expect(calls.flat()).not.toContain("reset");
    expect(values.get(APP_SETTING_KEYS.remoteAccessTailscaleManagedHost)).toBe("");
    expect(values.get(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget)).toBe("");
  });

  it("does not remove a tracked handler after another tool changes its target", async () => {
    const { store } = createStore({
      [APP_SETTING_KEYS.remoteAccessTailscaleManagedHost]: DNS_NAME,
      [APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget]: "http://127.0.0.1:47831",
    });
    const runner = vi.fn<TailscaleCommandRunner>(async (_executable, args) => {
      if (args[0] === "status") return nodeStatus();
      return serveStatus("http://127.0.0.1:9000");
    });
    const service = new TailscaleServeService(store, runner, ["tailscale-test"]);

    await service.disable();

    expect(runner.mock.calls.some(([, args]) => args.at(-1) === "off")).toBe(false);
    expect(runner.mock.calls.some(([, args]) => args.includes("reset"))).toBe(false);
  });

  it.each([
    { label: "the status command fails", result: { stdout: "", stderr: "daemon unavailable", exitCode: 1 } },
    { label: "the status output is invalid", result: { stdout: "not json", stderr: "", exitCode: 0 } },
  ])("preserves ownership when $label", async ({ result }) => {
    const target = "http://127.0.0.1:47831";
    const { store, values } = createStore({
      [APP_SETTING_KEYS.remoteAccessTailscaleManagedHost]: DNS_NAME,
      [APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget]: target,
    });
    const runner = vi.fn<TailscaleCommandRunner>(async (_executable, args) => {
      if (args[0] === "status") return nodeStatus();
      return result;
    });
    const service = new TailscaleServeService(store, runner, ["tailscale-test"]);

    await expect(service.disable()).resolves.toMatchObject({ state: "error", managed: true });

    expect(runner.mock.calls.some(([, args]) => args.at(-1) === "off")).toBe(false);
    expect(values.get(APP_SETTING_KEYS.remoteAccessTailscaleManagedHost)).toBe(DNS_NAME);
    expect(values.get(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget)).toBe(target);
  });
});

const TARGET = "http://127.0.0.1:47831";
const exposureFixture = (mode: "local" | "tailnet" | "internet", initial: "tailnet" | "internet" | null = null) => {
  const { store, values } = createStore({
    [APP_SETTING_KEYS.remoteAccessExposure]: mode,
    ...(initial ? {
      [APP_SETTING_KEYS.remoteAccessTailscaleManagedHost]: DNS_NAME,
      [APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget]: TARGET,
    } : {}),
  });
  const state = { target: initial ? TARGET : null as string | null, public: initial === "internet", apply: true, fail: false, extraPath: false, foreground: false };
  const runner = vi.fn<TailscaleCommandRunner>(async (_executable, args) => {
    if (args[0] === "status") return nodeStatus();
    if (args[1] === "status") return { exitCode: 0, stderr: "", stdout: JSON.stringify({
      ...(state.target ? {
        TCP: { 443: { HTTPS: true } },
        Web: { [DNS_NAME + ":443"]: { Handlers: { "/": { Proxy: state.target }, ...(state.extraPath ? { "/other": { Proxy: "http://localhost:9000" } } : {}) } } },
      } : {}),
      AllowFunnel: { [DNS_NAME + ":443"]: state.public },
      ...(state.foreground ? { Foreground: { other: { TCP: { 443: { HTTPS: true } } } } } : {}),
    }) };
    if (state.apply) {
      state.target = args.at(-1) === "off" ? null : TARGET;
      state.public = args.at(-1) !== "off" && args[0] === "funnel";
    }
    return { stdout: "", stderr: state.fail ? "Funnel approval required: https://login.tailscale.com/admin" : "", exitCode: state.fail ? 1 : 0 };
  });
  return { values, state, runner, service: new TailscaleServeService(store, runner, ["tailscale-test"]) };
};

describe("public Internet exposure", () => {
  it("migrates legacy settings only to local or private access", () => {
    expect(parseRemoteAccessExposure({})).toBe("local");
    expect(parseRemoteAccessExposure({ [APP_SETTING_KEYS.remoteAccessTailscaleEnabled]: "true" })).toBe("tailnet");
    expect(parseRemoteAccessExposure({ [APP_SETTING_KEYS.remoteAccessExposure]: "invalid", [APP_SETTING_KEYS.remoteAccessTailscaleEnabled]: "true" })).toBe("local");
    expect(parseRemoteAccessExposure({ [APP_SETTING_KEYS.remoteAccessExposure]: "local", [APP_SETTING_KEYS.remoteAccessTailscaleEnabled]: "true" })).toBe("local");
  });

  it("creates Funnel only after explicit Internet opt-in and verifies public exposure", async () => {
    const { service, runner } = exposureFixture("internet");
    await expect(service.enable(47831)).resolves.toMatchObject({ verified: true, requestedExposure: "internet", exposure: "internet" });
    expect(runner.mock.calls.map(([, args]) => args)).toContainEqual(["funnel", "--bg", "--yes", "--https=443", "--set-path=/", TARGET]);
  });

  it.each([ ["tailnet", "internet"], ["internet", "tailnet"] ] as const)("changes owned %s exposure to %s", async (initial, next) => {
    const { service, runner } = exposureFixture(next, initial);
    await expect(service.enable(47831)).resolves.toMatchObject({ verified: true, exposure: next });
    expect(runner.mock.calls.map(([, args]) => args)).toContainEqual([next === "internet" ? "funnel" : "serve", "--bg", "--yes", "--https=443", "--set-path=/", TARGET]);
    expect(runner.mock.calls.some(([, args]) => args.includes("reset"))).toBe(false);
  });

  it("keeps actual public exposure visible when a downgrade silently fails", async () => {
    const { service, state, values } = exposureFixture("tailnet", "internet");
    state.apply = false;
    await expect(service.enable(47831)).resolves.toMatchObject({ state: "error", verified: false, requestedExposure: "tailnet", exposure: "internet" });
    await expect(service.getStatus(47831)).resolves.toMatchObject({ state: "error", exposure: "internet" });
    expect(values.get(APP_SETTING_KEYS.remoteAccessTailscaleManagedHost)).toBe(DNS_NAME);
    state.apply = true;
    await expect(service.enable(47831)).resolves.toMatchObject({ verified: true, exposure: "tailnet" });
  });

  it("retains ownership if a timed-out command actually enabled Funnel", async () => {
    const { service, state, values } = exposureFixture("internet");
    state.fail = true;
    await expect(service.enable(47831)).resolves.toMatchObject({ state: "error", exposure: "internet", verified: false });
    expect(values.get(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget)).toBe(TARGET);
    state.fail = false;
    await expect(service.disable()).resolves.toMatchObject({ state: "available" });
    expect(state.public).toBe(false);
  });

  it("preserves approval instructions across status refreshes and permits retry", async () => {
    const { service, state } = exposureFixture("internet");
    state.fail = true; state.apply = false;
    await service.enable(47831);
    expect((await service.getStatus(47831)).message).toContain("https://login.tailscale.com/admin");
    state.fail = false; state.apply = true;
    await expect(service.enable(47831)).resolves.toMatchObject({ verified: true, exposure: "internet" });
  });

  it("removes and verifies public exposure with the exact Funnel command", async () => {
    const { service, runner, values } = exposureFixture("local", "internet");
    await expect(service.disable()).resolves.toMatchObject({ state: "available" });
    expect(runner.mock.calls.map(([, args]) => args)).toContainEqual(["funnel", "--https=443", "--set-path=/", "off"]);
    expect(values.get(APP_SETTING_KEYS.remoteAccessTailscaleManagedHost)).toBe("");
  });

  it("retains ownership when removal reports success but remains public", async () => {
    const { service, state, values } = exposureFixture("local", "internet");
    state.apply = false;
    await expect(service.disable()).resolves.toMatchObject({ state: "error", exposure: "internet" });
    expect(values.get(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget)).toBe(TARGET);
  });

  it.each(["extraPath", "foreground"] as const)("never exposes other handlers sharing the port: %s", async (field) => {
    const { service, state, runner } = exposureFixture("internet", "tailnet");
    state[field] = true;
    await expect(service.enable(47831)).resolves.toMatchObject({ state: "conflict", verified: false });
    await expect(service.disable()).resolves.toMatchObject({ state: "error" });
    expect(runner.mock.calls.every(([, args]) => args.includes("status"))).toBe(true);
  });
});
