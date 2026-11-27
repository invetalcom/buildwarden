import { APP_SETTING_KEYS, parseRemoteAccessExposure } from "@buildwarden/shared";
import { describe, expect, it, vi } from "vitest";
import {
  TailscaleServeService,
  type TailscaleCommandResult,
  type TailscaleCommandRunner,
  type TailscaleServeStateStore,
} from "./tailscale-serve-service";

const DNS_NAME = "buildwarden-host.example.ts.net";
/** No program listens on any loopback port the service asks about. */
const portFree = async (): Promise<boolean> => false;
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
  it.each([
    { sameNode: true, renamed: true, alreadyRemoved: false },
    { sameNode: false, renamed: true, alreadyRemoved: false },
    { sameNode: false, renamed: false, alreadyRemoved: false },
    { sameNode: true, renamed: true, alreadyRemoved: true },
  ])("checks stable identity during cleanup: %j", async ({ sameNode, renamed, alreadyRemoved }) => {
    const target = "http://127.0.0.1:47831";
    const storedHost = renamed ? "old-name.example.ts.net" : DNS_NAME;
    const { store, values } = createStore({
      [APP_SETTING_KEYS.remoteAccessTailscaleManagedHost]: storedHost,
      [APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget]: target,
      [APP_SETTING_KEYS.remoteAccessTailscaleManagedNodeId]: "original-node",
    });
    let configuredTarget: string | null = alreadyRemoved ? null : target;
    const runner = vi.fn<TailscaleCommandRunner>(async (_executable, args) => {
      if (args[0] === "status") return { exitCode: 0, stderr: "", stdout: JSON.stringify({
        BackendState: "Running", Self: { DNSName: DNS_NAME, ID: sameNode ? "original-node" : "different-node", Online: true },
      }) };
      if (args[1] === "status") return serveStatus(configuredTarget);
      if (args.at(-1) === "off") { configuredTarget = null; return { stdout: "", stderr: "", exitCode: 0 }; }
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    });
    const service = new TailscaleServeService(store, runner, ["tailscale-test"], portFree);
    const result = await service.disable();
    expect(runner.mock.calls.some(([, args]) => args.at(-1) === "off")).toBe(sameNode && !alreadyRemoved);
    expect(values.get(APP_SETTING_KEYS.remoteAccessTailscaleManagedHost)).toBe(sameNode ? "" : storedHost);
    if (!sameNode) expect(result.state).toBe("error");
  });

  it("reports a missing CLI without changing settings", async () => {
    const { store, values } = createStore({ [APP_SETTING_KEYS.remoteAccessTailscaleEnabled]: "true" });
    const runner = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 1, notFound: true }));
    const service = new TailscaleServeService(store, runner, ["tailscale-test"], portFree);

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
    const service = new TailscaleServeService(store, runner, ["tailscale-test"], portFree);

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
    const service = new TailscaleServeService(store, runner, ["tailscale-test"], portFree);

    await service.enable(47831);
    expect(runner.mock.calls.some(([, args]) => args.includes("--https=443") && args[1] !== "status")).toBe(false);
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
    const service = new TailscaleServeService(store, runner, ["tailscale-test"], portFree);

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
    const service = new TailscaleServeService(store, runner, ["tailscale-test"], portFree);

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
    const service = new TailscaleServeService(store, runner, ["tailscale-test"], portFree);

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
  return { values, state, runner, service: new TailscaleServeService(store, runner, ["tailscale-test"], portFree) };
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

type FakeHandler = { target: string; public?: boolean; extraPath?: boolean };
const target = (port: number): string => `http://127.0.0.1:${String(port)}`;
/** A Tailscale CLI that keeps handlers on several HTTPS ports and applies serve/funnel commands to them. */
const fakeTailscale = (initial: Record<number, FakeHandler>, settings: Record<string, string>, portsInUse: number[] = []) => {
  const handlers = new Map(Object.entries(initial).map(([port, handler]) => [Number(port), handler]));
  const { store, values } = createStore(settings);
  const runner = vi.fn<TailscaleCommandRunner>(async (_executable, args) => {
    if (args[0] === "status") {
      return { exitCode: 0, stderr: "", stdout: JSON.stringify({ BackendState: "Running", Self: { ID: "node-1", DNSName: DNS_NAME, Online: true } }) };
    }
    if (args[1] === "status") {
      const config = { TCP: {} as Record<string, unknown>, Web: {} as Record<string, unknown>, AllowFunnel: {} as Record<string, boolean> };
      for (const [port, handler] of handlers) {
        config.TCP[String(port)] = { HTTPS: true };
        config.Web[`${DNS_NAME}:${String(port)}`] = { Handlers: {
          "/": { Proxy: handler.target },
          ...(handler.extraPath ? { "/other": { Proxy: "http://127.0.0.1:9000" } } : {}),
        } };
        if (handler.public) config.AllowFunnel[`${DNS_NAME}:${String(port)}`] = true;
      }
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(handlers.size ? config : {}) };
    }
    const port = Number(args.find((arg) => arg.startsWith("--https="))?.slice("--https=".length));
    if (args.at(-1) === "off") handlers.delete(port);
    else handlers.set(port, { ...handlers.get(port), target: args.at(-1) ?? "", public: args[0] === "funnel" });
    return { exitCode: 0, stderr: "", stdout: "" };
  });
  const probe = vi.fn(async (port: number) => portsInUse.includes(port));
  const changes = () => runner.mock.calls.map(([, args]) => args).filter((args) => args[0] !== "status" && args[1] !== "status");
  return { handlers, values, runner, probe, changes, service: new TailscaleServeService(store, runner, ["tailscale-test"], probe) };
};
const ownedOn = (httpsPort: number, loopbackPort: number, exposure: "local" | "tailnet" = "tailnet"): Record<string, string> => ({
  [APP_SETTING_KEYS.remoteAccessExposure]: exposure,
  [APP_SETTING_KEYS.remoteAccessTailscaleManagedHost]: DNS_NAME,
  [APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget]: target(loopbackPort),
  [APP_SETTING_KEYS.remoteAccessTailscaleManagedNodeId]: "node-1",
  [APP_SETTING_KEYS.remoteAccessTailscaleManagedHttpsPort]: String(httpsPort),
});

describe("several BuildWarden instances on one host", () => {
  it("takes over a handler an earlier install left pointing at this server", async () => {
    const { service, values, changes } = fakeTailscale({ 443: { target: target(47831) } }, { [APP_SETTING_KEYS.remoteAccessExposure]: "tailnet" });

    await expect(service.getStatus(47831)).resolves.toMatchObject({ state: "available", httpsPort: 443, message: expect.stringContaining("earlier install") });
    await expect(service.enable(47831)).resolves.toMatchObject({ state: "managed", verified: true, httpsPort: 443, endpoint: `https://${DNS_NAME}/` });
    expect(values.get(APP_SETTING_KEYS.remoteAccessTailscaleManagedHost)).toBe(DNS_NAME);
    expect(values.get(APP_SETTING_KEYS.remoteAccessTailscaleManagedHttpsPort)).toBe("443");
    expect(service.getTrustedProxyAuthority()).toBe(DNS_NAME);
    expect(changes().every((args) => args.includes("--https=443"))).toBe(true);
  });

  it("uses HTTPS port 8443 when another program holds 443", async () => {
    const { service, handlers } = fakeTailscale({ 443: { target: "http://127.0.0.1:9000" } }, { [APP_SETTING_KEYS.remoteAccessExposure]: "tailnet" });

    const before = await service.getStatus(47832);
    expect(before.message).toContain("443 → http://127.0.0.1:9000");
    await expect(service.enable(47832)).resolves.toMatchObject({ verified: true, httpsPort: 8443, endpoint: `https://${DNS_NAME}:8443/` });
    expect(handlers.get(443)?.target).toBe("http://127.0.0.1:9000");
    expect(handlers.get(8443)?.target).toBe(target(47832));
    expect(service.getTrustedProxyAuthority()).toBe(`${DNS_NAME}:8443`);
  });

  it("publishes on a later port through Funnel too", async () => {
    const { service, changes } = fakeTailscale(
      { 443: { target: "http://127.0.0.1:9000" }, 8443: { target: "http://127.0.0.1:9001" } },
      { [APP_SETTING_KEYS.remoteAccessExposure]: "internet" },
    );

    await expect(service.enable(47832)).resolves.toMatchObject({ verified: true, exposure: "internet", httpsPort: 10000 });
    expect(changes()).toEqual([["funnel", "--bg", "--yes", "--https=10000", "--set-path=/", target(47832)]]);
  });

  it("names what holds every port when none is free", async () => {
    const { service, changes } = fakeTailscale(
      { 443: { target: "http://127.0.0.1:9000" }, 8443: { target: target(47831) }, 10000: { target: "http://127.0.0.1:9002" } },
      { [APP_SETTING_KEYS.remoteAccessExposure]: "tailnet" },
    );

    const status = await service.enable(47833);
    expect(status).toMatchObject({ state: "conflict", verified: false });
    expect(status.message).toContain("443 → http://127.0.0.1:9000");
    expect(status.message).toContain("8443 → http://127.0.0.1:47831");
    expect(status.message).toContain("tailscale serve --https=<port> off");
    expect(changes()).toEqual([]);
  });

  it("points its own handler at its new loopback port when the old one is free", async () => {
    const { service, handlers, probe } = fakeTailscale({ 443: { target: target(47831) } }, ownedOn(443, 47831));

    await expect(service.enable(47832)).resolves.toMatchObject({ verified: true, httpsPort: 443 });
    expect(probe).toHaveBeenCalledWith(47831);
    expect(handlers.get(443)?.target).toBe(target(47832));
  });

  it("leaves its old handler to the program that now holds its old loopback port", async () => {
    const { service, handlers, values } = fakeTailscale({ 443: { target: target(47831) } }, ownedOn(443, 47831), [47831]);

    await expect(service.enable(47832)).resolves.toMatchObject({ verified: true, httpsPort: 8443 });
    expect(handlers.get(443)?.target).toBe(target(47831));
    expect(handlers.get(8443)?.target).toBe(target(47832));
    expect(values.get(APP_SETTING_KEYS.remoteAccessTailscaleManagedTarget)).toBe(target(47832));
  });

  it("never retargets a shared port, so Funnel cannot publish the other handlers on it", async () => {
    const owned = { ...ownedOn(443, 47831), [APP_SETTING_KEYS.remoteAccessExposure]: "internet" };
    const { service, handlers, changes } = fakeTailscale({ 443: { target: target(47831), extraPath: true } }, owned);

    await expect(service.enable(47832)).resolves.toMatchObject({ verified: true, exposure: "internet", httpsPort: 8443 });
    expect(handlers.get(443)).toEqual({ target: target(47831), extraPath: true });
    expect(changes().some((args) => args.includes("--https=443"))).toBe(false);
  });

  it("restores its handler on the same HTTPS port after someone removed it", async () => {
    const { service, handlers } = fakeTailscale({}, ownedOn(8443, 47832));

    await expect(service.enable(47832)).resolves.toMatchObject({ verified: true, httpsPort: 8443 });
    expect(handlers.has(443)).toBe(false);
  });

  it("removes its handler on a port other than 443", async () => {
    const { service, handlers, values } = fakeTailscale({ 8443: { target: target(47832), public: true } }, ownedOn(8443, 47832, "local"));

    await expect(service.disable(47832)).resolves.toMatchObject({ state: "available" });
    expect(handlers.size).toBe(0);
    expect(values.get(APP_SETTING_KEYS.remoteAccessTailscaleManagedHttpsPort)).toBe("");
  });

  it("releases a handler whose loopback port another program now holds, without removing it", async () => {
    const { service, handlers, values, changes } = fakeTailscale({ 443: { target: target(47831) } }, ownedOn(443, 47831, "local"), [47831]);

    await expect(service.disable(47832)).resolves.toMatchObject({ state: "available", message: expect.stringContaining("left in place") });
    expect(changes()).toEqual([]);
    expect(handlers.get(443)?.target).toBe(target(47831));
    expect(values.get(APP_SETTING_KEYS.remoteAccessTailscaleManagedHost)).toBe("");
  });

  it("does not remove the handler of a server that failed to start because another program holds its port", async () => {
    const { service, changes } = fakeTailscale({ 443: { target: target(47831) } }, ownedOn(443, 47831, "tailnet"), [47831]);

    await service.disable(null);
    expect(changes()).toEqual([]);
  });

  it("Local only removes a leftover handler that forwards to this server and nothing else", async () => {
    const { service, handlers } = fakeTailscale(
      { 443: { target: target(47831), public: true }, 8443: { target: "http://127.0.0.1:9000" } },
      { [APP_SETTING_KEYS.remoteAccessExposure]: "local" },
    );

    await expect(service.disable(47831)).resolves.toMatchObject({ state: "available", message: expect.stringContaining("Removed") });
    expect(handlers.has(443)).toBe(false);
    expect(handlers.get(8443)?.target).toBe("http://127.0.0.1:9000");
  });

  it("Local only keeps a handler that forwards to another loopback port", async () => {
    const { service, changes } = fakeTailscale({ 443: { target: target(47831) } }, { [APP_SETTING_KEYS.remoteAccessExposure]: "local" });

    await service.disable(47832);
    await service.disable(null);
    expect(changes()).toEqual([]);
  });
});
