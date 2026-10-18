import { describe, expect, it } from "vitest";
import { buildVisibleConversationHistory, estimateContextWindow } from "./context-window-estimate";

describe("estimateContextWindow", () => {
  it("keeps display-only image bytes and image-view events out of context estimates", () => {
    const image = `data:image/png;base64,${"a".repeat(1_000_000)}`;
    const output = (content: string, metadata: Record<string, unknown> = {}) => ({
      eventType: "output", title: "Response", content, metadataJson: JSON.stringify(metadata),
    });
    const history = buildVisibleConversationHistory([
      { eventType: "log", title: "Prompt", content: "Show ideas", metadataJson: '{"source":"user"}' },
      output(`![Preview](${image})`, { assistantKind: "image" }),
      output(`Idea ![Preview](${image})`, { responseSourceText: "Idea [Screenshot](preview.png)" }),
      output(`Legacy ![Preview](${image})`),
      output("Thinking", { assistantKind: "reasoning" }),
    ]);
    expect(history).toBe("Show ideas\n\nIdea [Screenshot](preview.png)\n\nLegacy ![Preview]([image])");
    expect(estimateContextWindow({ modelIds: ["gpt-5"], prompt: "", historyText: history })?.usedTokens).toBeLessThan(400);
  });
  it("renders a cheap heuristic before exact tokenizer counts arrive", () => {
    const estimate = estimateContextWindow({
      modelIds: ["gpt-5"],
      prompt: "12345678",
      historyText: "1234",
    });

    expect(estimate?.usedTokens).toBe(303);
  });

  it("replaces only text estimates with exact worker counts", () => {
    const estimate = estimateContextWindow({
      modelIds: ["gpt-5"],
      prompt: "ignored by exact count",
      historyText: "also ignored",
      isRun: true,
      textTokenCounts: { prompt: 19, history: 31 },
    });

    expect(estimate?.usedTokens).toBe(1_450);
  });
});
