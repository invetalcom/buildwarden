import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { REMOTE_ACCESS_SCOPES, type RemoteAccessStatus } from "@buildwarden/shared";
import { EXIT_FAILURE, EXIT_NOT_RUNNING, EXIT_USAGE, runCommandLine } from "./command-line";
import type { CommandLineIo } from "./command-line-shared";
import { HostNotRunningError } from "./control-protocol";

const remote = (tailscale: Partial<RemoteAccessStatus["tailscale"]> = {}): RemoteAccessStatus => ({
  enabled: true,
  loopbackUrl: "http://127.0.0.1:47831",
  tailscale: {
    desired: false, state: "available", cliPath: null, backendState: null, dnsName: null, endpoint: null,
    managed: false, verified: false, message: "Local access only.", enableCommand: null, ...tailscale,
  },
});

const proxy = { enabled: true, protocol: "http", host: "proxy.example", port: "8080", username: "", hasPassword: false };
const projectFolder = resolve("/work", "repo");
const addedProject = { id: "p", name: "repo", path: projectFolder, kind: "git" };
const provider = { id: "11111111-2222", label: "OpenAI", type: "ai-sdk", models: 2 };

const run = async (args: string[], responses: Record<string, unknown> = {}, overrides: Partial<CommandLineIo> = {}) => {
  const out: string[] = [];
  const errors: string[] = [];
  const request = vi.fn(async (...call: [method: string, input?: unknown]) => {
    const response = responses[call[0]];
    if (response instanceof Error) throw response;
    return response;
  });
  const code = await runCommandLine(args, {
    out: (text) => out.push(text),
    error: (text) => errors.push(text),
    interactive: false,
    cwd: "/work",
    version: "1.2.3",
    request: request as unknown as CommandLineIo["request"],
    promptSecret: async () => { throw new Error("unexpected prompt"); },
    promptLine: async () => { throw new Error("unexpected prompt"); },
    readStdin: async () => "from stdin\n",
    renderQr: async () => "QR",
    gitClone: async () => undefined,
    doctor: { toolVersion: async () => "git version 2", diskFreeBytes: async () => 50 * 1024 ** 3, serviceLingers: async () => null },
    service: { print: () => "unit", install: async () => "installed", uninstall: async () => "removed" },
    ...overrides,
  });
  return { code, out: out.join("\n"), errors: errors.join("\n"), request };
};

describe("general", () => {
  it.each([["statsu"], ["status", "extra"], ["status", "--nope"], ["serve", "--port", "0"], ["remote", "nope"], ["proxy", "set"]])(
    "reports wrong usage of %s %s", async (...args) => {
      const result = await run(args);
      expect(result.code).toBe(EXIT_USAGE);
      expect(result.errors).toContain("buildwarden help");
      expect(result.request).not.toHaveBeenCalled();
    });

  it("tells a stopped host apart from a failed command", async () => {
    expect((await run(["status"], { status: new HostNotRunningError("not running") })).code).toBe(EXIT_NOT_RUNNING);
    expect((await run(["status"], { status: new Error("boom") })).code).toBe(EXIT_FAILURE);
  });

  it("prints help and version without a host", async () => {
    expect((await run(["help"])).out).toContain("proxy set <url>");
    expect((await run(["proxy", "--help"])).out).toContain("proxy set <url>");
    expect((await run(["version"])).out).toBe("1.2.3");
  });
});

describe("pair", () => {
  const grant = { id: "g", code: "ABCD", scopes: ["state:read"], expiresAt: "2026-01-01T00:05:00Z", createdAt: "" };

  it("asks for full control unless told otherwise", async () => {
    const full = await run(["pair"], { pair: grant });
    expect(full.request).toHaveBeenCalledWith("pair", { scopes: [...REMOTE_ACCESS_SCOPES] });
    const readOnly = await run(["pair", "--read-only"], { pair: grant });
    expect(readOnly.request).toHaveBeenCalledWith("pair", { scopes: ["state:read"] });
    expect((await run(["pair", "--read-only", "--scopes", "admin"])).code).toBe(EXIT_USAGE);
  });

  it("explains the SSH tunnel for a loopback link, and shows a QR code for a reachable one", async () => {
    const local = await run(["pair"], { pair: { ...grant, pairingUrl: "http://127.0.0.1:5000/#pair=ABCD" } }, { interactive: true });
    expect(local.out).toContain("ssh -L 5000:127.0.0.1:5000");
    expect(local.out).not.toContain("QR");
    const tailnet = await run(["pair"], { pair: { ...grant, pairingUrl: "https://host.example.ts.net/#pair=ABCD" } }, { interactive: true });
    expect(tailnet.out).toContain("QR");
  });
});

describe("remote", () => {
  it("fails when the exposure could not be applied", async () => {
    const pending = await run(["remote", "expose", "private"], {
      remoteExpose: remote({ desired: true, message: "Tailscale is not connected.", enableCommand: "tailscale serve" }),
    });
    expect(pending.request).toHaveBeenCalledWith("remoteExpose", { exposure: "tailnet" });
    expect(pending.code).toBe(EXIT_FAILURE);
    expect(pending.out).toContain("tailscale serve");
    const active = await run(["remote", "expose", "internet"], {
      remoteExpose: remote({ desired: true, verified: true, requestedExposure: "internet", endpoint: "https://host.ts.net/" }),
    });
    expect(active.code).toBe(0);
    expect((await run(["remote", "expose", "local"], { remoteExpose: remote() })).code).toBe(0);
    expect((await run(["remote", "expose", "local"], { remoteExpose: remote({ managed: true }) })).code).toBe(EXIT_FAILURE);
  });

  it("manages hosted website origins", async () => {
    const added = await run(["remote", "origins", "add", "https://a.example"], { remoteOrigins: ["https://a.example"] });
    expect(added.request).toHaveBeenCalledWith("remoteOrigins", { add: "https://a.example" });
    expect((await run(["remote", "origins"], { remoteOrigins: [] })).out).toBe("No hosted website origins.");
  });
});

describe("sessions", () => {
  const sessions = [{ id: "one", label: "Phone\u001b[2J", scopes: ["admin"], lastUsedAt: "2026-01-01T00:00:00Z" }, { id: "two", label: "Laptop", scopes: [], lastUsedAt: "2026-01-01T00:00:00Z" }];

  it("keeps control characters of device names out of the terminal", async () => {
    expect((await run(["sessions"], { listSessions: sessions })).out).not.toContain("\u001b");
  });

  it("revokes one or all", async () => {
    expect((await run(["sessions", "revoke", "one"], { revokeSession: false })).code).toBe(EXIT_FAILURE);
    expect((await run(["sessions", "revoke", "--all"], { listSessions: sessions, revokeSession: true })).out).toBe("Revoked 2 devices.");
  });
});

describe("proxy", () => {
  it("reads the URL, with the scheme's default port", async () => {
    const result = await run(["proxy", "set", "https://proxy.example:443"], { proxySet: proxy });
    expect(result.request).toHaveBeenCalledWith("proxySet", { protocol: "https", host: "proxy.example", port: "443", username: "" });
    expect(result.out).toBe("Network proxy: http://proxy.example:8080");
    expect((await run(["proxy", "set", "proxy.example:3128"], { proxySet: proxy })).request)
      .toHaveBeenCalledWith("proxySet", { protocol: "http", host: "proxy.example", port: "3128", username: "" });
    expect((await run(["proxy", "set", "socks5://proxy.example"])).code).toBe(EXIT_USAGE);
    expect((await run(["proxy", "set", "http://me:secret@proxy.example:1"])).code).toBe(EXIT_USAGE);
  });

  it("takes the password from standard input or a prompt and never prints it", async () => {
    const piped = await run(["proxy", "set", "http://p.example:1", "--username", "me", "--password-stdin"],
      { proxySet: { ...proxy, username: "me", hasPassword: true } });
    expect(piped.request).toHaveBeenCalledWith("proxySet", expect.objectContaining({ username: "me", password: "from stdin" }));
    expect(piped.out).toBe("Network proxy: http://me:***@proxy.example:8080");
    const prompted = await run(["proxy", "set", "http://me@p.example:1"], { proxySet: proxy },
      { interactive: true, promptSecret: async () => "typed" });
    expect(prompted.request).toHaveBeenCalledWith("proxySet", expect.objectContaining({ username: "me", password: "typed" }));
  });

  it("switches the proxy off without forgetting it", async () => {
    const result = await run(["proxy", "off"], { proxyEnable: { ...proxy, enabled: false } });
    expect(result.request).toHaveBeenCalledWith("proxyEnable", { enabled: false });
    expect(result.out).toContain("(off)");
  });
});

describe("data", () => {
  it("needs a confirmation before it replaces data", async () => {
    const refused = await run(["backup", "restore", "file", "--password-stdin"]);
    expect(refused.code).toBe(EXIT_USAGE);
    const declined = await run(["backup", "restore", "file"], {}, { interactive: true, promptLine: async () => "no" });
    expect(declined.request).not.toHaveBeenCalled();
    const confirmed = await run(["backup", "restore", "file", "--yes", "--password-stdin"], { backupRestore: { createdAt: "2026-01-01T00:00:00Z" } });
    expect(confirmed.request).toHaveBeenCalledWith("backupRestore", { filePath: resolve("/work", "file"), password: "from stdin" });
  });
});

describe("projects", () => {
  it("resolves paths against the caller's folder", async () => {
    const result = await run(["project", "add", "repo"], { addProject: addedProject });
    expect(result.request).toHaveBeenCalledWith("addProject", { path: projectFolder });
  });

  it.each([
    ["git@github.com:me/repo.git"], ["https://github.com/me/repo.git/"], ["ssh://git@host:22/me/repo"], ["host:repo.git"],
  ])("clones %s into the folder Git would choose", async (url) => {
    const gitClone = vi.fn(async () => undefined);
    const result = await run(["project", "clone", url], { listProjects: [], addProject: addedProject }, { gitClone });
    expect(gitClone).toHaveBeenCalledWith(url, projectFolder);
    expect(result.request).toHaveBeenLastCalledWith("addProject", { path: projectFolder });
  });

  it("does not clone for a host that is not running", async () => {
    const gitClone = vi.fn(async () => undefined);
    const result = await run(["project", "clone", "https://x.example/repo"], { listProjects: new HostNotRunningError("no") }, { gitClone });
    expect(result.code).toBe(EXIT_NOT_RUNNING);
    expect(gitClone).not.toHaveBeenCalled();
  });

  it("removes only after a confirmation that names what is deleted", async () => {
    const responses = { projectImpact: { project: addedProject, runs: 3, activeRuns: 1 }, removeProject: null };
    const refused = await run(["project", "remove", "repo"], responses);
    expect(refused.code).toBe(EXIT_USAGE);
    expect(refused.errors).toContain("3 runs, 1 of them active");
    expect(refused.request).not.toHaveBeenCalledWith("removeProject", expect.anything());
    const confirmed = await run(["project", "remove", "repo", "--yes"], responses);
    expect(confirmed.request).toHaveBeenLastCalledWith("removeProject", { projectId: "p" });
  });

  it("reads an access token from standard input and never prints it", async () => {
    const status = { provider: "github", webBaseUrl: "https://github.com", repoLabel: "me/repo", hasToken: true };
    const result = await run(["project", "token", "repo", "set", "--stdin"], { setProjectToken: status });
    expect(result.request).toHaveBeenCalledWith("setProjectToken", { project: "repo", token: "from stdin" });
    expect(result.out).not.toContain("from stdin");
  });
});

describe("providers and models", () => {
  it("maps friendly types and passes only the given options", async () => {
    const codex = await run(["provider", "add", "codex", "--binary", "/usr/bin/codex"], { addProvider: provider });
    expect(codex.request).toHaveBeenCalledWith("addProvider",
      { providerType: "codex-cli", label: "Codex", options: { binary: "/usr/bin/codex" }, apiKey: "" });
    const acp = await run(["provider", "add", "acp", "--command", "agent --acp", "--env", "A=1", "--env", "B=2"], { addProvider: provider });
    expect(acp.request).toHaveBeenCalledWith("addProvider", expect.objectContaining({ options: { command: "agent --acp", env: "A=1\nB=2" } }));
  });

  it("takes an API key from standard input or a prompt only", async () => {
    const piped = await run(["provider", "add", "openai", "--key-stdin"], { addProvider: provider });
    expect(piped.request).toHaveBeenCalledWith("addProvider", expect.objectContaining({ providerType: "ai-sdk", family: "openai", apiKey: "from stdin" }));
    expect(piped.out).not.toContain("from stdin");
    expect((await run(["provider", "add", "openai"])).code).toBe(EXIT_USAGE);
    expect((await run(["provider", "add", "openai", "--key", "sk-1"])).code).toBe(EXIT_USAGE);
    expect((await run(["provider", "add", "claude", "--key-stdin"])).code).toBe(EXIT_USAGE);
    const keyless = await run(["provider", "add", "openai-compatible", "--base-url", "http://localhost:1"], { addProvider: provider });
    expect(keyless.request).toHaveBeenCalledWith("addProvider", expect.objectContaining({ apiKey: "", apiBaseUrl: "http://localhost:1" }));
  });

  it("rejects unknown provider types, including inherited property names", async () => {
    expect((await run(["provider", "add", "nope"])).code).toBe(EXIT_USAGE);
    expect((await run(["provider", "add", "constructor"])).code).toBe(EXIT_USAGE);
  });

  it("adds several models", async () => {
    const result = await run(["model", "add", "OpenAI", "a", "b"], { addModel: { id: "m", modelId: "a", name: "A", provider: "OpenAI" } });
    expect(result.request).toHaveBeenCalledWith("addModel", { provider: "OpenAI", modelId: "a" });
    expect(result.request).toHaveBeenCalledWith("addModel", { provider: "OpenAI", modelId: "b" });
    expect((await run(["model", "add", "OpenAI", "a", "b", "--name", "x"])).code).toBe(EXIT_USAGE);
  });

  it("names everything a model removal deletes", async () => {
    const impact = { modelId: "m", modelDisplayName: "A", runCount: 2, chatCount: 1, automationCount: 0, projectLoopCount: 0, projectLabThreadCount: 0, projectInsightCount: 0, orchestrationCount: 0 };
    const refused = await run(["model", "remove", "a"], { modelImpact: impact });
    expect(refused.errors).toContain("deletes 2 runs, 1 chat.");
    const confirmed = await run(["model", "remove", "a", "-y"], { modelImpact: impact, removeModel: null });
    expect(confirmed.request).toHaveBeenLastCalledWith("removeModel", { modelId: "m" });
  });
});

describe("maintenance", () => {
  it("deletes exactly the reviewed old data", async () => {
    const impact = { runCount: 4, chatCount: 0, projectLabThreadCount: 0, projectLoopCount: 0, cutoffAt: "2026-01-01T00:00:00Z" };
    const result = await run(["storage", "cleanup", "--days", "30", "--yes"], { cleanupImpact: impact, cleanup: impact });
    expect(result.request).toHaveBeenLastCalledWith("cleanup", { days: 30, cutoffAt: impact.cutoffAt });
    expect((await run(["storage", "cleanup", "--days", "0"])).code).toBe(EXIT_USAGE);
    expect((await run(["storage", "cleanup"])).code).toBe(EXIT_USAGE);
    const nothing = await run(["storage", "cleanup", "--days", "30"], { cleanupImpact: { ...impact, runCount: 0 } });
    expect(nothing.code).toBe(0);
  });

  it("explains that update checks are off", async () => {
    expect((await run(["cli"], { providerClis: { enabled: false, providers: [] } })).out).toContain("buildwarden cli on");
    expect((await run(["cli", "update", "vim"])).code).toBe(EXIT_USAGE);
  });
});

describe("doctor", () => {
  const status = { version: "1", pid: 1, remote: remote(), secretStorage: "encrypted", projects: 1 };
  const clis = [{ type: "codex-cli", label: "Codex", path: null }];

  it("works without a running host and fails then", async () => {
    const result = await run(["doctor"], { status: new HostNotRunningError("no") });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.out).toContain("not running");
    expect(result.out).toContain("git version 2");
  });

  it("fails for a missing agent tool only when a provider needs it", async () => {
    const unused = await run(["doctor"], { status, detectProviders: clis, listProviders: [], listModels: [] });
    expect(unused.code).toBe(0);
    const used = await run(["doctor"], { status, detectProviders: clis, listProviders: [{ ...provider, type: "codex-cli" }], listModels: [] });
    expect(used.code).toBe(EXIT_FAILURE);
  });
});
