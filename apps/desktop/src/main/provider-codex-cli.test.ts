import { describe, expect, it } from "vitest";
import {
  buildCodexPlanProgressChunk,
  parseCodexModelListPage,
  requestCodexAvailableModels,
} from "../../../../packages/provider-codex-cli/src";

describe("Codex CLI plan progress", () => {
  it("maps turn plan updates to replaceable plan-progress chunks", () => {
    const chunk = buildCodexPlanProgressChunk({
      explanation: "Implementing the approved plan.",
      plan: [
        { step: "Update shared contracts", status: "completed" },
        { step: "Render progress pill", status: "inProgress" },
        { step: "Run validation", status: "pending" },
      ],
    });

    expect(chunk).toEqual({
      type: "plan-progress",
      title: "Plan progress",
      value: "Implementing the approved plan.\n\n1. [x] Update shared contracts\n2. [-] Render progress pill\n3. [ ] Run validation",
      metadata: {
        provider: "codex-cli",
        planProgress: {
          explanation: "Implementing the approved plan.",
          source: "codex",
          steps: [
            { title: "Update shared contracts", status: "completed" },
            { title: "Render progress pill", status: "inProgress" },
            { title: "Run validation", status: "pending" },
          ],
        },
        streamId: "codex-plan-progress",
        replace: true,
        rawPlanUpdate: {
          explanation: "Implementing the approved plan.",
          plan: [
            { step: "Update shared contracts", status: "completed" },
            { step: "Render progress pill", status: "inProgress" },
            { step: "Run validation", status: "pending" },
          ],
        },
      },
    });
  });

  it("parses model/list pages from Codex app-server responses", () => {
    expect(
      parseCodexModelListPage({
        data: [
          { model: "gpt-5.3-codex", displayName: "GPT-5.3 Codex" },
          { model: "gpt-5", name: "GPT-5" },
          { id: "legacy-id-model" },
          { displayName: "Missing ID" },
        ],
        nextCursor: "page-2",
      }),
    ).toEqual({
      models: [
        { modelId: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", source: "provider" },
        { modelId: "gpt-5", displayName: "GPT-5", source: "provider" },
        { modelId: "legacy-id-model", displayName: "legacy-id-model", source: "provider" },
      ],
      nextCursor: "page-2",
    });
  });

  it("pages through Codex model/list cursors and deduplicates model ids", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const responses = [
      {
        data: [
          { model: "gpt-5.3-codex", displayName: "GPT-5.3 Codex" },
          { model: "gpt-5", displayName: "GPT-5" },
        ],
        nextCursor: "page-2",
      },
      {
        models: [
          { model: "GPT-5", displayName: "Duplicate casing" },
          { model: "gpt-5-mini", display_name: "GPT-5 mini" },
        ],
      },
    ];

    const models = await requestCodexAvailableModels({
      request: async <T = unknown>(method: string, params: unknown): Promise<T> => {
        requests.push({ method, params });
        return responses.shift() as T;
      },
    });

    expect(requests).toEqual([
      { method: "model/list", params: {} },
      { method: "model/list", params: { cursor: "page-2" } },
    ]);
    expect(models).toEqual([
      { modelId: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", source: "provider" },
      { modelId: "gpt-5", displayName: "GPT-5", source: "provider" },
      { modelId: "gpt-5-mini", displayName: "GPT-5 mini", source: "provider" },
    ]);
  });

  it("propagates Codex model/list failures so the controller can fall back", async () => {
    await expect(
      requestCodexAvailableModels({
        request: async () => {
          throw new Error("model/list failed");
        },
      }),
    ).rejects.toThrow("model/list failed");
  });
});
