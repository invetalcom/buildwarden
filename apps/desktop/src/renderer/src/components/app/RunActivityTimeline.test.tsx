import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunActivityTimeline } from "./RunActivityTimeline";
import { buildActivityEntries, buildTimelineRenderItems, deriveRunSubagents, type RunActivityStep } from "./run-activity-model";
import { isOpenableToolPath } from "./run-activity-tool-model";

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
  it("renders the major workflow event families", () => {
    const steps = [
      step("prompt", "log", { source: "user", mode: "code", attachmentNames: ["spec.md"] }, "Implement the plan"),
      step("status", "status", {}, "Run completed successfully"),
      step("reason", "output", { assistantKind: "reasoning" }, "Reasoning\n".repeat(10)),
      step("answer", "output", {}, "Implemented the change"),
      step("plan-progress", "plan-progress", { planProgress: { steps: [{ title: "Inspect", status: "completed" }] } }, "Inspect"),
      step("plan", "plan", {}, "1. [x] Inspect\n2. [ ] Implement"),
      step("approval", "approval-requested", { requestKind: "approval", approvalRequestId: "approval-1" }, "pnpm test"),
      step("input", "user-input-requested", {
        requestKind: "user-input",
        userInputRequestId: "request-1",
        userInputQuestions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [{ label: "All", description: "Everything" }] }],
      }, "Choose scope"),
      step("diff", "diff-updated", { toolName: "write_file", path: "src/App.tsx" }, "diff --git a/src/App.tsx b/src/App.tsx\n+change"),
      step("tool-call", "tool-call", { callId: "call-1", toolName: "run_shell", command: "pnpm test" }, "pnpm test"),
      step("tool-result", "tool-result", { callId: "call-1", toolName: "run_shell", command: "pnpm test", ok: true }, "passed"),
      step("error", "error", {}, "Failure detail"),
    ];

    const markup = renderToStaticMarkup(
      <RunActivityTimeline
        steps={steps}
        run={{ id: "run-1", status: "completed", mode: "code" }}
        density="detailed"
        runDurationLabel="2m 3s"
        restorablePromptStepId="prompt"
        onCopyStepContent={async () => undefined}
        onUndoRunToLastPrompt={() => undefined}
        onCancelRunShell={() => undefined}
        onPreparePlanContinuation={() => undefined}
        onSubmitPlanFeedback={async () => undefined}
        onSubmitUserInputAnswers={async () => undefined}
        onOpenWorkspaceFile={() => undefined}
      />,
    );

    expect(markup).toContain("Implemented the change");
    expect(markup).toContain("Which scope?");
    expect(markup).toContain("pnpm test");
    expect(markup).toContain("Failure detail");
  });

  it("renders active, compact, and empty timeline states", () => {
    const active = renderToStaticMarkup(
      <RunActivityTimeline
        steps={[step("prompt", "log", { source: "user" }, "Continue"), step("answer", "output", {}, "Working")]}
        run={{ id: "run-active", status: "running", mode: "plan" }}
        density="compact"
        showLoading
      />,
    );
    expect(active).toContain("Agent is working");
    expect(renderToStaticMarkup(<RunActivityTimeline steps={[]} run={{ id: "empty", status: "completed", mode: "code" }} />)).toContain("No activity recorded");
  });

  it("renders the virtualized timeline shell without crashing", () => {
    const virtualized = renderToStaticMarkup(
      <RunActivityTimeline
        steps={[step("prompt", "log", { source: "user" }, "Continue"), step("answer", "output", {}, "Working")]}
        run={{ id: "run-virtual", status: "running", mode: "code" }}
        virtualized
        showBoundaryControls
        showLoading
      />,
    );
    expect(virtualized).toContain("agent-virtual-spacer");
    expect(virtualized).toContain('aria-label="Scroll to top"');
    expect(virtualized).toContain('aria-label="Scroll to bottom"');
    expect(virtualized.indexOf('aria-label="Scroll controls"')).toBeLessThan(virtualized.indexOf('class="agent-worklog'));
  });

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
