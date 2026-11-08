import { describe, expect, it } from "vitest";
import { getHarnessCapabilities, resolveHarnessDelivery } from "@buildwarden/shared";

describe("implemented harness capabilities", () => {
  it("does not advertise Claude streaming input as native live steering", () => {
    expect(resolveHarnessDelivery("claude-code", { running: true, resumable: true })).toMatchObject({
      liveSteering: { supported: false, available: false }, queuedDelivery: { available: true },
      interruptAndResume: { available: true },
    });
  });
  it("separates supported steering from availability on an idle session", () => {
    expect(resolveHarnessDelivery("codex-cli", { running: false, resumable: true }).liveSteering)
      .toMatchObject({ supported: true, available: false });
    expect(resolveHarnessDelivery("codex-cli", { running: true, resumable: false }).interruptAndResume.available).toBe(false);
  });
  it("advertises project MCP only for integrated transports", () => {
    expect(getHarnessCapabilities("codex-cli").projectMcp).toBe("native-http");
    expect(getHarnessCapabilities("ai-sdk").projectMcp).toBe("unsupported");
  });
});
