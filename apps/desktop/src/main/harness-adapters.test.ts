import { describe, expect, it } from "vitest";
import { createHarnessAdapter, getHarnessTypeForProvider } from "./harness-adapters";
import type { ProviderType } from "@buildwarden/shared";

const providerHarnessTypes: Array<[ProviderType, ReturnType<typeof getHarnessTypeForProvider>]> = [
  ["ai-sdk", "ai-sdk"],
  ["azure-legacy", "azure-legacy"],
  ["codex-cli", "codex-app-server"],
  ["claude-code", "claude-code"],
  ["cursor-agent", "cursor-acp"],
];

describe("harness adapter helpers", () => {
  it.each(providerHarnessTypes)("maps %s to harness type %s", (providerType, harnessType) => {
    expect(getHarnessTypeForProvider(providerType)).toBe(harnessType);
  });

  it.each(providerHarnessTypes)("creates a %s harness adapter", (providerType, harnessType) => {
    expect(createHarnessAdapter(providerType).harnessType).toBe(harnessType);
  });

  it("accepts Codex CLI shell approval as an explicit option", async () => {
    const requestShellApproval = async (command: string) => (command === "git status" ? "deny" : "allow-once");
    const adapter = createHarnessAdapter("codex-cli", { requestShellApproval });

    expect(adapter.harnessType).toBe("codex-app-server");
    expect(await requestShellApproval("git status")).toBe("deny");
  });

  it("wires shell approval and user input options through to the Cursor Agent adapter", async () => {
    const requestShellApproval = async () => "allow-once" as const;
    const requestUserInput = async () => ({});
    const adapter = createHarnessAdapter("cursor-agent", { requestShellApproval, requestUserInput });

    expect(adapter.harnessType).toBe("cursor-acp");
  });

  it("creates independent Cursor Agent adapter instances per call", () => {
    const first = createHarnessAdapter("cursor-agent");
    const second = createHarnessAdapter("cursor-agent");

    expect(first).not.toBe(second);
    expect(first.harnessType).toBe(second.harnessType);
  });
});
