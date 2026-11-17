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

it("selects advertised reasoning options and refuses mode overrides", async () => {
  const settings = new AcpSessionSettings();
  const options = (value: string) => ({ configOptions: [...config("fast", "code").configOptions,
    { id: "thinking", category: "thought_level", type: "select", currentValue: value, options: [{ value: "low" }, { value: "high" }] },
  ] });
  settings.update(options("low"));
  const requests: string[] = [];
  await settings.configure({ thinking: "high" }, async (id, value) => { requests.push(`${id}:${value}`); return options(value); });
  expect(requests).toEqual(["thinking:high"]);
  await expect(settings.configure({ mode: "plan" }, async () => ({}))).rejects.toThrow("run's model and mode controls");
  await expect(settings.configure({ unknown: "high" }, async () => ({}))).rejects.toThrow("does not offer");
});
