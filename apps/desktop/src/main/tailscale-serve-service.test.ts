import { APP_SETTING_KEYS } from "@buildwarden/shared";
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
});
