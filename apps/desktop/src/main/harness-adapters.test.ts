import { describe, expect, it } from "vitest";
import { createHarnessAdapter, getHarnessTypeForProvider } from "./harness-adapters";
import type { ProviderType } from "@buildwarden/shared";

const providerHarnessTypes: Array<[ProviderType, ReturnType<typeof getHarnessTypeForProvider>]> = [
  ["ai-sdk", "ai-sdk"],
  ["azure-legacy", "azure-legacy"],
  ["codex-cli", "codex-app-server"],
  ["claude-code", "claude-code"],
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
});
