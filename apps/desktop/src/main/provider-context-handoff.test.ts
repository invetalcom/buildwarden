import { describe, expect, it } from "vitest";
import {
  CHAT_ATTACHMENT_LIMITS,
  validateChatAttachmentPayloads,
  type ChatAttachmentPayload,
  type ProviderSessionRuntimeRecord,
} from "@buildwarden/shared";
import {
  buildContextHandoffBlock,
  findLatestAccountStepMetadata,
  planContextHandoff,
  renderBudgetedConversation,
  selectHandoffAttachments,
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
    expect(block).toContain("has not seen the last 1 turn");
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
    const block = buildContextHandoffBlock(steps, tight, { budget: 8_000 });
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

describe("delivery-aware turn tracking", () => {
  const at = (entry: HandoffStep, createdAt: string): HandoffStep => ({ ...entry, createdAt });
  // Codex (seen at 10:00), Claude, then a Codex return that failed before Codex started.
  const steps = [
    at(userTurn("Redesign the cards", "codex", "initial"), "2026-11-01T10:00:00.000Z"),
    at(step("output", "Redesigned."), "2026-11-01T10:00:30.000Z"),
    at(userTurn("Install the builder", "claude"), "2026-11-01T10:05:00.000Z"),
    at(step("output", "Installed it."), "2026-11-01T10:06:00.000Z"),
    at(userTurn("Polish the shadows", "codex"), "2026-11-01T10:10:00.000Z"),
    at(step("error", "Codex CLI could not start", {}, "Run failed"), "2026-11-01T10:10:01.000Z"),
  ];

  it("does not treat a follow-up that never reached the session as seen", () => {
    expect(planContextHandoff({
      steps, targetProviderType: "codex-cli", targetProviderAccountId: "codex", resumesNativeSession: true,
      sessionSeenAt: "2026-11-01T10:01:00.000Z", resolveTurnAccount,
    })).toEqual({ strategy: "delta", fromStepIndex: 2, turnCount: 2 });
  });

  it("counts the return turn once the session confirmed it", () => {
    expect(planContextHandoff({
      steps, targetProviderType: "codex-cli", targetProviderAccountId: "codex", resumesNativeSession: true,
      sessionSeenAt: "2026-11-01T10:10:00.500Z", resolveTurnAccount,
    })).toEqual({ strategy: "none" });
  });
});

describe("selectHandoffAttachments", () => {
  const file = (fileName: string, bytes = 3, extra: Partial<ChatAttachmentPayload> = {}): ChatAttachmentPayload => ({
    fileName, mimeType: "image/png", dataBase64: Buffer.alloc(bytes, fileName).toString("base64"), ...extra,
  });
  const turnWith = (providerAccountId: string, attachments: ChatAttachmentPayload[], commandType = "follow-up") =>
    step("log", "see files", { source: "user", commandType, providerAccountId, attachments, attachmentNames: attachments.map((entry) => entry.fileName) });
  const full = (steps: HandoffStep[]) => ({ strategy: "full" as const, fromStepIndex: 0, turnCount: steps.length });

  it("re-attaches files from every handed-over turn, skipping ones already on the current message", () => {
    const spec = file("spec.png");
    const steps = [turnWith("codex", [spec], "initial"), step("output", "ok"), turnWith("claude", [file("mock.png")])];
    const selected = selectHandoffAttachments(steps, full(steps), [spec]);
    expect(selected.attachments.map((entry) => entry.fileName)).toEqual(["mock.png"]);
    expect(selected.note).toEqual({ reattachedFileNames: ["mock.png"], omittedFileNames: [] });
  });

  it("only re-attaches files from the missed turns for a delta", () => {
    const steps = [turnWith("codex", [file("old.png")], "initial"), turnWith("claude", [file("new.png")])];
    const selected = selectHandoffAttachments(steps, { strategy: "delta", fromStepIndex: 1, turnCount: 1 });
    expect(selected.attachments.map((entry) => entry.fileName)).toEqual(["new.png"]);
    expect(selectHandoffAttachments(steps, { strategy: "none" }).attachments).toEqual([]);
  });

  it("stays within the file-count limit, keeping the original request and the newest files", () => {
    const turns = Array.from({ length: 10 }, (_, index) => turnWith("codex", [file(`f${index}.png`)], index === 0 ? "initial" : "follow-up"));
    const selected = selectHandoffAttachments(turns, full(turns), [file("current.png")]);
    expect(selected.attachments).toHaveLength(CHAT_ATTACHMENT_LIMITS.maxFileCount - 1);
    expect(selected.attachments[0]!.fileName).toBe("f0.png");
    expect(selected.attachments.at(-1)!.fileName).toBe("f9.png");
    expect(selected.note.omittedFileNames).toEqual(["f1.png", "f2.png", "f3.png"]);
    expect(() => validateChatAttachmentPayloads([...selected.attachments, file("current.png")])).not.toThrow();
  });

  it("keeps browser-element captures together", () => {
    const source = (role: "context" | "screenshot") => ({
      kind: "browser-element", groupId: "g1", captureId: "c1", url: "https://example.test", selector: "#card", role,
    }) as unknown as ChatAttachmentPayload["source"];
    const pair = [
      { ...file("element.md"), mimeType: "text/markdown", source: source("context") },
      { ...file("element.jpg"), mimeType: "image/jpeg", source: source("screenshot") },
    ];
    const filled = Array.from({ length: 7 }, (_, index) => file(`c${index}.png`));
    const steps = [turnWith("codex", pair, "initial")];
    expect(selectHandoffAttachments(steps, full(steps), filled).attachments).toEqual([]);
    expect(selectHandoffAttachments(steps, full(steps), filled.slice(0, 6)).attachments).toHaveLength(2);
  });
});

describe("renderBudgetedConversation", () => {
  it("never drops the opening message or the latest exchange", () => {
    const rendered = renderBudgetedConversation([
      { role: "user", content: `OPENING ${"o".repeat(80_000)}` },
      { role: "assistant", content: "middle" },
      { role: "user", content: `LATEST ${"l".repeat(80_000)}` },
      { role: "assistant", content: `ANSWER ${"a".repeat(80_000)}` },
    ], 12_000);
    expect(rendered).toContain("user: OPENING");
    expect(rendered).toContain("user: LATEST");
    expect(rendered).toContain("assistant: ANSWER");
    expect(rendered.length).toBeLessThan(13_000);
  });
});
