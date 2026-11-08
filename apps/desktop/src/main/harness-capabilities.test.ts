import { describe, expect, it } from "vitest";
import {
  effectiveHarnessCapabilities,
  getHarnessCapabilities,
  parseHarnessSessionCapabilities,
  resolveHarnessDelivery,
} from "@buildwarden/shared";

describe("implemented harness capabilities", () => {
  it("advertises live steering for Codex and Claude, not for Cursor", () => {
    expect(resolveHarnessDelivery("claude-code", { running: true, resumable: true }).liveSteering)
      .toMatchObject({ supported: true, available: true });
    expect(resolveHarnessDelivery("cursor-agent", { running: true, resumable: true })).toMatchObject({
      liveSteering: { supported: false, available: false }, queuedDelivery: { available: true },
      interruptAndResume: { available: true },
    });
  });
  it("separates supported steering from availability on an idle session", () => {
    expect(resolveHarnessDelivery("codex-cli", { running: false, resumable: true }).liveSteering)
      .toMatchObject({ supported: true, available: false });
    expect(resolveHarnessDelivery("codex-cli", { running: true, resumable: false }).interruptAndResume.available).toBe(false);
  });
  it("bridges project MCP into function-calling harnesses and lets agents connect natively", () => {
    expect(getHarnessCapabilities("codex-cli").projectMcp).toBe("native-http");
    expect(getHarnessCapabilities("acp").projectMcp).toBe("native-http");
    expect(getHarnessCapabilities("ai-sdk").projectMcp).toBe("bridged");
    expect(getHarnessCapabilities("azure-legacy").projectMcp).toBe("bridged");
  });
  it("limits per-task settings to what each integration can apply", () => {
    expect(getHarnessCapabilities("azure-legacy").taskExecutionOptions).toEqual([]);
    expect(getHarnessCapabilities("codex-cli").taskExecutionOptions).toContain("reasoningEffort");
  });
});

describe("session-reported capabilities", () => {
  it("only ever narrows what the integration supports", () => {
    const reported = { reportedAt: "2026-01-01T00:00:00.000Z", liveSteering: false, mcpHttp: false, sessionResume: false };
    expect(effectiveHarnessCapabilities("claude-code", reported)).toMatchObject({
      liveSteering: false, nativeSessionResume: false, projectMcp: "unsupported",
    });
    // A report claiming more than the integration implements changes nothing.
    expect(effectiveHarnessCapabilities("cursor-agent", { reportedAt: "x", liveSteering: true }).liveSteering).toBe(false);
    expect(effectiveHarnessCapabilities("ai-sdk", { reportedAt: "x", mcpHttp: false }).projectMcp).toBe("bridged");
    expect(resolveHarnessDelivery("claude-code", { running: true, resumable: true }, reported).liveSteering.supported).toBe(false);
  });
  it("parses reports defensively", () => {
    expect(parseHarnessSessionCapabilities(null)).toBeNull();
    expect(parseHarnessSessionCapabilities({ agentVersion: 2, liveSteering: "yes", mcpServers: [{ name: "docs", status: "failed" }, { bad: true }] }))
      .toMatchObject({ mcpServers: [{ name: "docs", status: "failed" }] });
    expect(parseHarnessSessionCapabilities({ agentVersion: 2 })).not.toHaveProperty("agentVersion");
  });
});
