import { describe, expect, it } from "vitest";
import type { ProviderSessionRuntimeRecord } from "@buildwarden/shared";
import {
  buildContextHandoffBlock,
  findLatestAccountStepMetadata,
  planContextHandoff,
  selectResumableSession,
  stepsBeforeLatestTurn,
  withContextHandoff,
  type HandoffStep,
} from "./provider-context-handoff";

const step = (eventType: string, content: string, metadata: Record<string, unknown> = {}, title = eventType): HandoffStep => ({
  eventType,
  title,
  content,
  metadataJson: JSON.stringify(metadata),
});
const userTurn = (content: string, providerAccountId: string, commandType = "follow-up") =>
  step("log", content, { source: "user", commandType, providerAccountId });
const resolveTurnAccount = (metadata: Record<string, unknown>) =>
  typeof metadata.providerAccountId === "string" ? metadata.providerAccountId : null;

// Codex ran turn 1, the AI SDK ran turn 2.
const history: HandoffStep[] = [
  userTurn("Redesign the Kanban cards", "codex", "initial"),
  step("tool-call", "npm run build", { toolName: "run_shell" }),
  step("tool-result", "build failed: missing @angular-devkit/build-angular", {}, "run_shell"),
  step("output", "Redesigned the cards; the build needs dependencies installed."),
  step("status", "Run completed"),
  userTurn("Install the missing builder", "ai-sdk"),
  step("output", "Reasoning about it", { assistantKind: "reasoning" }),
  step("output", "Installed @angular-devkit/build-angular and the build passes."),
  step("output", "subagent chatter", { subagentId: "sub-1" }),
];

const plan = (targetProviderAccountId: string, resumesNativeSession: boolean, targetProviderType: "codex-cli" | "claude-code" | "ai-sdk" | "azure-legacy" = "claude-code") =>
  planContextHandoff({ steps: history, targetProviderType, targetProviderAccountId, resumesNativeSession, resolveTurnAccount });

describe("planContextHandoff", () => {
  it("hands the whole conversation to a provider starting a fresh native session", () => {
    expect(plan("claude", false)).toEqual({ strategy: "full", fromStepIndex: 0, turnCount: 2 });
  });

  it("hands only the missed turns to a provider resuming its own older session", () => {
    expect(plan("codex", true, "codex-cli")).toEqual({ strategy: "delta", fromStepIndex: 5, turnCount: 1 });
  });

  it("hands nothing over when the resumed session handled the latest turn", () => {
    expect(plan("ai-sdk", true, "codex-cli")).toEqual({ strategy: "none" });
  });

  it("hands nothing to transcript-replaying providers, which rebuild history themselves", () => {
    expect(plan("ai-sdk", false, "ai-sdk")).toEqual({ strategy: "none" });
  });

  it("always gives Azure Legacy runs the full history because they keep no session", () => {
    expect(plan("azure", false, "azure-legacy").strategy).toBe("full");
  });

  it("keeps resuming unattributable legacy sessions without a handoff", () => {
    const legacy = history.map((entry) => ({ ...entry, metadataJson: entry.metadataJson.replace(/"providerAccountId":"[^"]+",?/, "") }));
    expect(planContextHandoff({ steps: legacy, targetProviderType: "codex-cli", targetProviderAccountId: "codex", resumesNativeSession: true, resolveTurnAccount }))
      .toEqual({ strategy: "none" });
  });
});

describe("buildContextHandoffBlock", () => {
  it("renders user, assistant and tool activity while skipping reasoning, status and subagent output", () => {
    const block = buildContextHandoffBlock(history, plan("claude", false));
    expect(block).toContain('strategy="full_history"');
    expect(block).toContain("[User]\nRedesign the Kanban cards");
    expect(block).toContain("[Tool call: run_shell]\nnpm run build");
    expect(block).toContain("missing @angular-devkit/build-angular");
    expect(block).toContain("[Assistant]\nInstalled @angular-devkit/build-angular");
    expect(block).not.toContain("Reasoning about it");
    expect(block).not.toContain("subagent chatter");
    expect(block).not.toContain("Run completed");
  });

  it("renders only the delta for a resumed session", () => {
    const block = buildContextHandoffBlock(history, plan("codex", true, "codex-cli"));
    expect(block).toContain('strategy="delta_since_your_last_turn"');
    expect(block).toContain("for 1 turn");
    expect(block).toContain("Install the missing builder");
    expect(block).not.toContain("Redesign the Kanban cards");
  });

  it("returns an empty block when nothing needs handing over", () => {
    expect(buildContextHandoffBlock(history, { strategy: "none" })).toBe("");
    expect(withContextHandoff("", "next")).toBe("next");
  });

  it("keeps the original request and the latest exchange when the budget is tight", () => {
    const filler = Array.from({ length: 30 }, (_, index) => step("tool-result", `output ${index} ${"y".repeat(900)}`, {}, "run_shell"));
    const steps = [
      userTurn("ORIGINAL REQUEST", "codex", "initial"),
      ...filler,
      step("output", "LATEST ANSWER"),
      userTurn("LATEST QUESTION", "ai-sdk"),
      ...filler,
    ];
    const tight = planContextHandoff({ steps, targetProviderType: "claude-code", targetProviderAccountId: "claude", resumesNativeSession: false, resolveTurnAccount });
    const block = buildContextHandoffBlock(steps, tight, 8_000);
    expect(block).toContain("ORIGINAL REQUEST");
    expect(block).toContain("LATEST QUESTION");
    expect(block).toContain("LATEST ANSWER");
    expect(block).toMatch(/items omitted/);
    expect(block).toMatch(/omitted to stay within the context budget/);
  });

  it("prefixes the user request after the handoff block", () => {
    expect(withContextHandoff("<previous_conversation>", "Do it")).toBe("<previous_conversation>\n\nCurrent user request:\nDo it");
  });
});

describe("selectResumableSession", () => {
  const session = (overrides: Partial<ProviderSessionRuntimeRecord>): ProviderSessionRuntimeRecord => ({
    ownerId: "run-1", ownerKind: "run", providerAccountId: "codex", providerType: "codex-cli", harnessType: "codex-app-server",
    status: "ready", cwd: "/repo", modelId: "gpt", runtimeMode: "code", resumeCursor: { threadId: "t-1" }, runtimePayload: null,
    lastSeenAt: "", createdAt: "", updatedAt: "", ...overrides,
  });

  it("only lets the account that created a session resume it", () => {
    expect(selectResumableSession(session({}), { providerAccountId: "codex", providerType: "codex-cli" })).not.toBeNull();
    expect(selectResumableSession(session({}), { providerAccountId: "codex-2", providerType: "codex-cli" })).toBeNull();
    expect(selectResumableSession(session({ providerAccountId: null }), { providerAccountId: "codex", providerType: "codex-cli" })).toBeNull();
    expect(selectResumableSession(session({}), { providerAccountId: "codex", providerType: "claude-code" })).toBeNull();
    expect(selectResumableSession(null, { providerAccountId: "codex", providerType: "codex-cli" })).toBeNull();
  });
});

describe("turn helpers", () => {
  it("drops the turn that is about to run", () => {
    expect(stepsBeforeLatestTurn(history)).toEqual(history.slice(0, 5));
    expect(stepsBeforeLatestTurn([])).toEqual([]);
  });

  it("finds per-account metadata without crossing into other providers' turns", () => {
    const steps = [
      userTurn("one", "codex", "initial"),
      step("status", "", { usageTotals: { inputTokens: 10 } }),
      userTurn("two", "claude"),
      step("status", "", { usageTotals: { inputTokens: 99 } }),
    ];
    const pick = (metadata: Record<string, unknown>) => Boolean(metadata.usageTotals);
    expect(findLatestAccountStepMetadata(steps, "codex", resolveTurnAccount, pick)?.usageTotals).toEqual({ inputTokens: 10 });
    expect(findLatestAccountStepMetadata(steps, "cursor", resolveTurnAccount, pick)).toBeNull();
  });
});
