import { describe, expect, it } from "vitest";
import { buildActivityEntries, buildTimelineRenderItems, deriveRunSubagents, isOpenableToolPath, type RunActivityStep } from "./RunActivityTimeline";

const step = (
  id: string,
  eventType: RunActivityStep["eventType"],
  metadata: Record<string, unknown> = {},
  content = "",
): RunActivityStep => ({
  id,
  eventType,
  title: id,
  content,
  metadataJson: JSON.stringify(metadata),
  createdAt: "2026-05-30T12:00:00.000Z",
});

describe("run activity timeline shaping", () => {
  it("keeps adjacent tool calls grouped as one tool batch", () => {
    const entries = buildActivityEntries([
      step("call-1", "tool-call", { callId: "1", toolName: "read_file", path: "a.ts" }),
      step("result-1", "tool-result", { callId: "1", toolName: "read_file", path: "a.ts" }),
      step("call-2", "tool-call", { callId: "2", toolName: "read_file", path: "b.ts" }),
      step("result-2", "tool-result", { callId: "2", toolName: "read_file", path: "b.ts" }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("tool-batch");
    expect(entries[0]?.kind === "tool-batch" ? entries[0].items : []).toHaveLength(2);
  });

  it("marks only workspace-file tool paths as openable", () => {
    expect(isOpenableToolPath("read_file", "src/App.tsx")).toBe(true);
    expect(isOpenableToolPath("write_file", "src/App.tsx")).toBe(true);
    expect(isOpenableToolPath("edit_file", "src/App.tsx")).toBe(true);
    expect(isOpenableToolPath("delete_file", "src/App.tsx")).toBe(true);
    expect(isOpenableToolPath("list_files", "src")).toBe(true);
    expect(isOpenableToolPath("search_repo", "src")).toBe(true);
    expect(isOpenableToolPath("run_shell", "pnpm test")).toBe(false);
    expect(isOpenableToolPath("read_file", "  ")).toBe(false);
  });

  it("appends plan decision, loading, and end spacer rows in order", () => {
    const entries = buildActivityEntries([step("prompt", "log", { source: "user" }, "Build a feature")]);
    const items = buildTimelineRenderItems({
      entries,
      density: "comfortable",
      canShowPlanDecision: true,
      latestPlanDecisionText: "Plan text",
      showLoading: true,
    });

    expect(items.map((item) => item.kind)).toEqual(["entry", "plan-decision", "loading", "end"]);
  });

  it("omits tool rows from compact timeline items", () => {
    const entries = buildActivityEntries([
      step("call-1", "tool-call", { callId: "1", toolName: "run_shell", command: "pnpm test" }),
      step("result-1", "tool-result", { callId: "1", toolName: "run_shell", command: "pnpm test" }),
      step("answer", "output", { source: "assistant" }, "Done"),
    ]);

    const items = buildTimelineRenderItems({
      entries,
      density: "compact",
      canShowPlanDecision: false,
      latestPlanDecisionText: null,
      showLoading: false,
    });

    expect(items.map((item) => item.kind)).toEqual(["entry", "end"]);
    expect(items[0]?.kind === "entry" ? items[0].entry.kind : null).toBe("single");
  });

  it("groups consecutive diff updates into one diff batch", () => {
    const entries = buildActivityEntries([
      step("diff-1", "diff-updated", { toolName: "write_file", path: "a.ts" }, "diff --git a/a.ts b/a.ts"),
      step("diff-2", "diff-updated", { toolName: "write_file", path: "b.ts" }, "diff --git a/b.ts b/b.ts"),
      step("answer", "output", { source: "assistant" }, "Done"),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.kind).toBe("diff-batch");
    expect(entries[0]?.kind === "diff-batch" ? entries[0].items : []).toHaveLength(2);
  });

  it("shows only the latest plan progress row", () => {
    const entries = buildActivityEntries([
      step("progress-1", "plan-progress", { planProgress: { steps: [{ title: "First", status: "inProgress" }] } }, "1. [-] First"),
      step("answer", "output", { source: "assistant" }, "Working on it"),
      step("progress-2", "plan-progress", { planProgress: { steps: [{ title: "First", status: "completed" }] } }, "1. [x] First"),
    ]);

    const progressEntries = entries.filter((entry) => entry.kind === "single" && entry.step.eventType === "plan-progress");

    expect(progressEntries).toHaveLength(1);
    expect(progressEntries[0]?.kind === "single" ? progressEntries[0].step.id : null).toBe("progress-2");
  });
});

describe("run activity timeline subagents", () => {
  const subagentLifecycle = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    id,
    source: "claude-code",
    status,
    name: "general-purpose",
    description: "Count .txt files",
    ...extra,
  });

  it("groups subagent lifecycle and stamped inner steps into one subagent entry", () => {
    const entries = buildActivityEntries([
      step("prompt", "log", { source: "user" }, "Count files"),
      step("spawn", "tool-progress", {
        toolName: "subagent",
        callId: "agent-1",
        subagent: { id: "agent-1", source: "claude-code", status: "completed", name: "general-purpose", summary: "2 files" },
      }),
      step("inner-call", "tool-call", { callId: "inner-1", toolName: "search_repo", subagentId: "agent-1" }),
      step("inner-result", "tool-result", { callId: "inner-1", toolName: "search_repo", subagentId: "agent-1" }),
      step("answer", "output", { source: "assistant" }, "There are 2 files."),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(["single", "subagent", "single"]);
    const subagentEntry = entries[1];
    if (subagentEntry?.kind !== "subagent") {
      throw new Error("expected a subagent entry");
    }
    expect(subagentEntry.info).toMatchObject({ id: "agent-1", status: "completed", summary: "2 files" });
    expect(subagentEntry.entries).toHaveLength(1);
    expect(subagentEntry.entries[0]?.kind).toBe("tool-batch");
  });

  it("keeps the subagent card anchored at its first lifecycle step across updates", () => {
    const entries = buildActivityEntries([
      step("spawn", "tool-progress", {
        toolName: "subagent",
        callId: "agent-1",
        subagent: subagentLifecycle("agent-1", "running"),
      }),
      step("answer", "output", { source: "assistant" }, "Delegating."),
      step("done", "tool-result", {
        toolName: "subagent",
        callId: "agent-1",
        subagent: { ...subagentLifecycle("agent-1", "completed"), summary: "All done" },
      }),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(["subagent", "single"]);
    const subagentEntry = entries[0];
    if (subagentEntry?.kind !== "subagent") {
      throw new Error("expected a subagent entry");
    }
    expect(subagentEntry.info.status).toBe("completed");
    expect(subagentEntry.info.summary).toBe("All done");
  });

  it("derives latest subagent states for header badges", () => {
    const subagents = deriveRunSubagents([
      step("spawn-1", "tool-progress", {
        subagent: { id: "agent-1", source: "codex-cli", status: "running" },
      }),
      step("spawn-2", "tool-progress", {
        subagent: { id: "agent-2", source: "codex-cli", status: "running" },
      }),
      step("done-1", "tool-result", {
        subagent: { id: "agent-1", source: "codex-cli", status: "completed" },
      }),
    ]);

    expect(subagents).toHaveLength(2);
    expect(subagents.find((subagent) => subagent.id === "agent-1")?.status).toBe("completed");
    expect(subagents.find((subagent) => subagent.id === "agent-2")?.status).toBe("running");
  });
});

describe("run activity timeline subagent cancellation", () => {
  const runningSubagentStep = step("spawn", "tool-progress", {
    toolName: "subagent",
    callId: "agent-1",
    subagent: { id: "agent-1", source: "codex-cli", status: "running", description: "Explore" },
  });

  it("coerces non-terminal subagents to cancelled once the run has stopped", () => {
    const entries = buildActivityEntries([runningSubagentStep], { runActive: false });
    const entry = entries[0];
    if (entry?.kind !== "subagent") {
      throw new Error("expected a subagent entry");
    }
    expect(entry.info.status).toBe("cancelled");

    const subagents = deriveRunSubagents([runningSubagentStep], { runActive: false });
    expect(subagents[0]?.status).toBe("cancelled");
  });

  it("keeps live statuses while the run is active and terminal statuses always", () => {
    const activeEntries = buildActivityEntries([runningSubagentStep], { runActive: true });
    expect(activeEntries[0]?.kind === "subagent" ? activeEntries[0].info.status : null).toBe("running");

    const completedStep = step("done", "tool-result", {
      toolName: "subagent",
      callId: "agent-2",
      subagent: { id: "agent-2", source: "codex-cli", status: "completed", summary: "ok" },
    });
    const stoppedEntries = buildActivityEntries([completedStep], { runActive: false });
    expect(stoppedEntries[0]?.kind === "subagent" ? stoppedEntries[0].info.status : null).toBe("completed");
  });
});
