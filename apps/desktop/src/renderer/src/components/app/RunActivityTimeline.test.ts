import { describe, expect, it } from "vitest";
import { buildActivityEntries, buildTimelineRenderItems, isOpenableToolPath, type RunActivityStep } from "./RunActivityTimeline";

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
