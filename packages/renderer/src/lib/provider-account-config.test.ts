import { describe, expect, it } from "vitest";
import type { ProviderType } from "@buildwarden/shared";
import { buildProviderAccountConfig, type ProviderAccountConfigDraft } from "./provider-account-config";

const draft = (providerType: ProviderType, claudeAutoCompactWindow?: string): ProviderAccountConfigDraft => ({
  providerType,
  providerFamily: "openai",
  providerConfigJson: "{}",
  providerAzureApiVersion: "",
  codexBinaryPath: "",
  codexHomePath: "",
  detectedCodexBinaryPath: null,
  claudeBinaryPath: "",
  claudeLaunchArgs: "",
  claudeAutoCompactWindow,
  detectedClaudeBinaryPath: null,
  cursorBinaryPath: "",
  cursorApiEndpoint: "",
  detectedCursorBinaryPath: null,
});

describe("Claude auto-compact window in provider config", () => {
  it("stores a typed window as a number", () => {
    expect(buildProviderAccountConfig(draft("claude-code", "250000")).claudeAutoCompactWindow).toBe(250_000);
    expect(buildProviderAccountConfig(draft("claude-code", " 300,000 ")).claudeAutoCompactWindow).toBe(300_000);
    expect(buildProviderAccountConfig(draft("claude-code", "400k")).claudeAutoCompactWindow).toBe(400_000);
  });

  it("leaves the window out when blank or for another provider type", () => {
    expect(buildProviderAccountConfig(draft("claude-code", "")).claudeAutoCompactWindow).toBeUndefined();
    expect(buildProviderAccountConfig(draft("claude-code")).claudeAutoCompactWindow).toBeUndefined();
    expect(buildProviderAccountConfig(draft("codex-cli", "250000")).claudeAutoCompactWindow).toBeUndefined();
  });

  it("rejects a window that is too small or not a number", () => {
    expect(() => buildProviderAccountConfig(draft("claude-code", "100000"))).toThrow("at least 150,000 tokens");
    expect(() => buildProviderAccountConfig(draft("claude-code", "big"))).toThrow("at least 150,000 tokens");
  });
});
