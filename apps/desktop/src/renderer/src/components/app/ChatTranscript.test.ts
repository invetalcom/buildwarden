import { describe, expect, it } from "vitest";
import { collapseChatSubagentEntries, type ChatTranscriptItem } from "./ChatTranscript";

const entry = (id: string, metadata: Record<string, unknown>, eventType: ChatTranscriptItem["eventType"] = "tool-progress") => ({
  item: {
    id,
    eventType,
    title: id,
    content: "content",
    metadataJson: JSON.stringify(metadata),
    createdAt: "2026-07-05T12:00:00.000Z",
  },
  metadata,
});

describe("chat transcript subagent collapsing", () => {
  it("keeps one panel per subagent showing the latest lifecycle state", () => {
    const spawn = entry("spawn", {
      subagent: { id: "agent-1", source: "claude-code", status: "running", name: "general-purpose" },
    });
    const progress = entry("progress", {
      subagent: { id: "agent-1", source: "claude-code", status: "running", activity: "Reading files" },
    });
    const done = entry("done", {
      subagent: { id: "agent-1", source: "claude-code", status: "completed", summary: "All good" },
    }, "tool-result");
    const answer = entry("answer", { source: "assistant" }, "output");

    const collapsed = collapseChatSubagentEntries([spawn, progress, answer, done]);

    expect(collapsed.map(({ item }) => item.id)).toEqual(["done", "answer"]);
    const subagentEntries = collapsed.filter(({ metadata }) => metadata.subagent);
    expect(subagentEntries).toHaveLength(1);
    expect((subagentEntries[0]?.metadata.subagent as { status?: string }).status).toBe("completed");
  });

  it("keeps distinct subagents as separate panels in first-seen order", () => {
    const first = entry("first", { subagent: { id: "agent-1", source: "codex-cli", status: "running" } });
    const second = entry("second", { subagent: { id: "agent-2", source: "codex-cli", status: "running" } });
    const firstDone = entry("first-done", { subagent: { id: "agent-1", source: "codex-cli", status: "completed" } }, "tool-result");

    const collapsed = collapseChatSubagentEntries([first, second, firstDone]);

    expect(collapsed.map(({ item }) => item.id)).toEqual(["first-done", "second"]);
  });

  it("passes non-subagent entries through untouched", () => {
    const prompt = entry("prompt", { source: "user" }, "log");
    const answer = entry("answer", { source: "assistant" }, "output");

    expect(collapseChatSubagentEntries([prompt, answer]).map(({ item }) => item.id)).toEqual(["prompt", "answer"]);
  });
});
