import { expect, it, vi } from "vitest";
import { createProviderAdapter, loadProxyAwareFetch } from "./provider-modules";
import { createHarnessAdapter, getHarnessTypeForProvider } from "./harness-adapters";
import { resolveClaudeCodeBinaryPath } from "@buildwarden/provider-claude-code/configuration";
import { resolveCodexCliExecutable } from "@buildwarden/provider-codex-cli/configuration";
import { getCursorAgentBinaryPath } from "@buildwarden/provider-cursor-agent/configuration";

const probes = vi.hoisted(() => ({ loaded: [] as string[], harnessOptions: vi.fn() }));
vi.mock("@buildwarden/provider-ai-sdk", () => { probes.loaded.push("ai-sdk"); return {}; });
vi.mock("@buildwarden/provider-azure-legacy", () => { probes.loaded.push("azure"); return {}; });
vi.mock("@buildwarden/provider-claude-code", () => { probes.loaded.push("claude"); return {}; });
vi.mock("@buildwarden/provider-cursor-agent", () => { probes.loaded.push("cursor"); return {}; });
vi.mock("@buildwarden/provider-ai-sdk/network-proxy", () => { probes.loaded.push("proxy"); return {}; });
vi.mock("@buildwarden/provider-codex-cli", () => {
  probes.loaded.push("codex");
  return {
    CodexCliProviderAdapter: class { providerType = "codex-cli"; },
    CodexCliHarnessAdapter: class {
      harnessType = "codex-app-server";
      constructor(...options: unknown[]) { probes.harnessOptions(...options); }
    },
  };
});

it("keeps startup and configuration SDK-free and loads only the selected provider", async () => {
  await import("./app-controller");
  expect(getHarnessTypeForProvider("claude-code")).toBe("claude-code");
  expect(resolveClaudeCodeBinaryPath({ claudeBinaryPath: "custom-claude" })).toBe("custom-claude");
  expect(resolveCodexCliExecutable({ codexBinaryPath: "custom-codex" }).binaryPath).toBe("custom-codex");
  expect(getCursorAgentBinaryPath({ cursorBinaryPath: "custom-cursor" })).toBe("custom-cursor");
  expect(await loadProxyAwareFetch(undefined)).toBeUndefined();
  expect(probes.loaded).toEqual([]);

  const adapters = await Promise.all([createProviderAdapter("codex-cli"), createProviderAdapter("codex-cli")]);
  expect(adapters.map((adapter) => adapter.providerType)).toEqual(["codex-cli", "codex-cli"]);
  const requestShellApproval = vi.fn();
  const requestUserInput = vi.fn();
  const harness = await createHarnessAdapter("codex-cli", { requestShellApproval, requestUserInput });
  expect(harness.harnessType).toBe("codex-app-server");
  expect(probes.harnessOptions).toHaveBeenCalledExactlyOnceWith(requestShellApproval, requestUserInput);
  expect(probes.loaded).toEqual(["codex"]);
});
