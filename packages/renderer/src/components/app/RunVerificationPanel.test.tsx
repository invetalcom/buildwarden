/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DesktopApi, RunRecord, RunVerificationState } from "@buildwarden/shared";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { RunVerificationPanel } from "./RunVerificationPanel";

let root: Root | undefined;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); });
const revision = { fingerprint: "git:abc", head: "123" };
const state: RunVerificationState = {
  status: "stale", currentRevision: { fingerprint: "git:changed", head: "123" }, commands: ["pnpm test"], requiredBeforePublish: true,
  reason: "Workspace contents changed.", record: { runId: "r", status: "passed", revision, commands: ["pnpm test"],
    results: [{ command: "pnpm test", ok: true, exitCode: 0, output: "Tests passed", durationMs: 42, timedOut: false }],
    startedAt: "2026-10-03T00:00:00Z", finishedAt: "2026-10-03T00:01:00Z", error: null },
};
const render = async (readOnly = false, active = false, response = state) => {
  const verify = vi.fn(async () => response);
  const client = createElectronBuildWardenClient({ getRunVerification: async () => response, verifyRunRevision: verify, onRunEvent: () => () => {} } as unknown as DesktopApi);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root?.render(<RunVerificationPanel client={{ ...client, capabilities: { ...client.capabilities, runMutations: !readOnly } }} run={{ id: "r", status: active ? "running" : "completed" } as RunRecord} reviewedRevision={revision} />));
  return verify;
};
describe("run verification panel", () => {
  it.each(["unconfigured", "unavailable"] as const)("hides the panel without commands even with previous evidence and status %s", async (status) => {
    await render(false, false, { ...state, commands: [], status });
    expect(container.childElementCount).toBe(0);
  });
  it("shows stale evidence, its output, and the stale review instead of a current pass", async () => {
    const verify = await render();
    expect(container.textContent).toContain("Review is stale");
    expect(container.textContent).toContain("Tests passed");
    expect(container.textContent).toContain("Required before commit or publish");
    const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Run verification")!;
    await act(async () => button.click()); expect(verify).toHaveBeenCalledWith("r");
  });
  it("prevents running commands from read-only connections", async () => {
    await render(true); expect(container.textContent).not.toContain("Run verification");
  });
  it("does not run verification concurrently with the agent", async () => {
    await render(false, true);
    expect([...container.querySelectorAll("button")].find((entry) => entry.textContent === "Run verification")?.disabled).toBe(true);
  });
});
