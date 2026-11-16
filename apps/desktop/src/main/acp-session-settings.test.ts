import { expect, it } from "vitest";
import { AcpSessionSettings } from "../../../../packages/provider-acp/src/session-settings";

const config = (model: string, mode: string) => ({ configOptions: [
  { id: "model", type: "select", currentValue: model, options: [{ value: "fast" }, { value: "careful" }] },
  { id: "mode", type: "select", currentValue: mode, options: [{ value: "code" }, { value: "plan" }] },
] });

it("preserves a newer notification received before the response continuation", async () => {
  const settings = new AcpSessionSettings();
  settings.update(config("fast", "code"));
  await settings.select("model", "careful", async () => {
    settings.update(config("careful", "plan"));
    return config("careful", "code");
  });
  expect(settings.selector("mode")?.currentValue).toBe("plan");
});

it("rejects selection superseded by an agent update", async () => {
  const settings = new AcpSessionSettings();
  settings.update(config("fast", "code"));
  await expect(settings.select("model", "careful", async () => {
    settings.update(config("fast", "plan"));
    return config("careful", "code");
  })).rejects.toThrow("did not confirm");
  expect(settings.currentModel).toBe("fast");
});
