import { describe, expect, it } from "vitest";
import type { RunDetail } from "@buildwarden/shared";
import { renderWithBuildWardenClient } from "../../lib/buildwarden-client-test-utils";
import { applyLiveRunEventToDetail } from "../../lib/live-state";
import { RunWorkspaceSetupCard } from "./RunWorkspaceSetupCard";

const detail = { run: { id: "run", status: "failed", prompt: "Task" }, steps: [], workspaceSetup: {
  profile: { id: "node", name: "Node", dependencies: "isolated", submodules: "none", commands: [], environmentFiles: [], previewCommand: "pnpm dev", previewUrl: "http://localhost:3000" }, status: "failed",
} } as unknown as RunDetail;

describe("workspace setup controls", () => {
  it("offers retry for failed setup without granting it to read-only clients", () => {
    expect(renderWithBuildWardenClient(<RunWorkspaceSetupCard detail={detail} />)).toContain("Retry setup and run");
    expect(renderWithBuildWardenClient(<RunWorkspaceSetupCard detail={detail} />, undefined, { runMutations: false })).not.toContain("Retry setup and run");
  });
  it("updates setup state from live progress and offers preview only after completion", () => {
    const updated = applyLiveRunEventToDetail(detail, { runId: "run", type: "status", title: "Setup complete", content: "Node", createdAt: "2026-10-03T00:00:00Z", metadata: { workspaceSetup: true, setupStatus: "completed" } });
    expect(updated.workspaceSetup?.status).toBe("completed");
    expect(renderWithBuildWardenClient(<RunWorkspaceSetupCard detail={updated} />)).toContain("Start preview");
    expect(renderWithBuildWardenClient(<RunWorkspaceSetupCard detail={detail} />)).not.toContain("Start preview");
  });
});
