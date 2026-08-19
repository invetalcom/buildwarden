import { describe, expect, it } from "vitest";
import { buildModelExecutionProfile } from "./app-model";
import {
  automationEffortControl,
  automationExecutionOptions,
  normalizeAutomationEffort,
  type AutomationModelOption,
} from "./automation-model-effort";

const modelOption = (
  overrides: Partial<AutomationModelOption> = {},
): AutomationModelOption => ({
  id: "configured-model",
  label: "Configured model",
  modelId: "gpt-5.6-sol",
  providerType: "codex-cli",
  providerFamily: null,
  executionProfile: buildModelExecutionProfile("codex-cli", null, "gpt-5.6-sol"),
  ...overrides,
});

describe("automation model effort", () => {
  it("uses the selected model's exact effort options", () => {
    const codex = modelOption();
    expect(automationEffortControl(codex)?.options.map((option) => option.value)).toEqual([
      "auto", "low", "medium", "high", "xhigh", "max", "ultra",
    ]);

    const cursor = modelOption({
      providerType: "cursor-agent",
      modelId: "composer-2.5",
      executionProfile: {
        source: "provider",
        controls: [{
          id: "reasoningEffort",
          label: "Reasoning",
          defaultValue: "balanced",
          options: [
            { value: "balanced", label: "Balanced" },
            { value: "deep", label: "Deep" },
          ],
        }],
      },
    });
    expect(automationEffortControl(cursor)?.options.map((option) => option.value)).toEqual(["balanced", "deep"]);
    expect(normalizeAutomationEffort(cursor, "ultra")).toBe("balanced");
  });

  it("omits the effort setting for a model that exposes no effort control", () => {
    const model = modelOption({ executionProfile: { controls: [] } });
    expect(automationEffortControl(model)).toBeUndefined();
    expect(normalizeAutomationEffort(model, "high")).toBe("auto");
    expect(automationExecutionOptions(model, "high")).toEqual({});
  });

  it("maps a provider-specific thinking level to its runtime option", () => {
    const google = modelOption({
      providerType: "ai-sdk",
      providerFamily: "google",
      modelId: "gemini-3.1-pro-preview",
      executionProfile: buildModelExecutionProfile("ai-sdk", "google", "gemini-3.1-pro-preview"),
    });
    expect(automationEffortControl(google)?.label).toBe("Thinking");
    expect(automationExecutionOptions(google, "high")).toEqual({ thinkingLevel: "high" });
  });
});
