/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi, RunDetail, RunTerminalStartResult } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { renderWithBuildWardenClient } from "../../lib/buildwarden-client-test-utils";
import { applyLiveRunEventToDetail } from "../../lib/live-state";
import { RunWorkspaceSetupCard } from "./RunWorkspaceSetupCard";

const detail = { run: { id: "run", status: "failed", prompt: "Task" }, steps: [], workspaceSetup: {
  profile: { id: "node", name: "Node", dependencies: "isolated", submodules: "none", commands: [], environmentFiles: [], previewCommand: "pnpm dev", previewUrl: "http://localhost:3000" }, status: "failed",
} } as unknown as RunDetail;

describe("workspace setup controls", () => {
  it.each([
    { status: "exited" as const, restart: { ok: true, status: "running" } as RunTerminalStartResult, writes: 1 },
    { status: "exited" as const, restart: { ok: false, error: "Shell unavailable" } as RunTerminalStartResult, writes: 0 },
    { status: "running" as const, restart: { ok: true } as RunTerminalStartResult, writes: 0 },
  ])("handles a reused $status preview without writing into an unrelated live command (writes=$writes)", async ({ status, restart, writes }) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const start = vi.fn<DesktopApi["runTerminalStart"]>().mockResolvedValueOnce({ ok: true, reused: true, status }).mockResolvedValueOnce(restart);
    const write = vi.fn<DesktopApi["runTerminalWrite"]>().mockResolvedValue(undefined);
    const onOpenUrl = vi.fn();
    const client = createElectronBuildWardenClient({ runTerminalStart: start, runTerminalWrite: write } as unknown as DesktopApi);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      const completed = { ...detail, workspacePath: "/workspace", workspaceSetup: { ...detail.workspaceSetup!, status: "completed" as const } };
      await act(async () => root.render(<BuildWardenClientProvider client={client}><RunWorkspaceSetupCard detail={completed} onOpenUrl={onOpenUrl} /></BuildWardenClientProvider>));
      await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Start preview")!.click());
      expect(start).toHaveBeenCalledTimes(status === "exited" ? 2 : 1);
      if (status === "exited") expect(start).toHaveBeenLastCalledWith({ sessionId: "buildwarden-run-terminal:run:preview", cwd: "/workspace", restart: true });
      expect(write).toHaveBeenCalledTimes(writes);
      expect(onOpenUrl).toHaveBeenCalledTimes(writes);
      if (writes) expect(write).toHaveBeenCalledWith({ sessionId: "buildwarden-run-terminal:run:preview", data: "pnpm dev\r" });
      else expect(container.querySelector('[role="alert"]')?.textContent).toContain(status === "running" ? "already active" : "Shell unavailable");
    } finally { await act(async () => root.unmount()); }
  });

  it("offers retry for failed setup without granting it to read-only clients", () => {
    expect(renderWithBuildWardenClient(<RunWorkspaceSetupCard detail={detail} />)).toContain("Retry setup and run");
    expect(renderWithBuildWardenClient(<RunWorkspaceSetupCard detail={detail} />, undefined, { runMutations: false })).not.toContain("Retry setup and run");
  });
  it("updates setup state from live progress and offers preview only after completion", () => {
    const updated = applyLiveRunEventToDetail(detail, { runId: "run", type: "status", title: "Setup complete", content: "Node", createdAt: "2026-10-03T00:00:00Z", metadata: { workspaceSetup: true, setupStatus: "completed" } });
    expect(updated.workspaceSetup?.status).toBe("completed");
    expect(renderWithBuildWardenClient(<RunWorkspaceSetupCard detail={updated} />)).toContain("Start preview");
    const readOnly = renderWithBuildWardenClient(<RunWorkspaceSetupCard detail={updated} onOpenUrl={() => undefined} />, undefined, { runMutations: false, embeddedTerminal: true });
    expect(readOnly).not.toContain("Start preview");
    expect(readOnly).toContain("Open preview");
    expect(renderWithBuildWardenClient(<RunWorkspaceSetupCard detail={detail} />)).not.toContain("Start preview");
  });
});
