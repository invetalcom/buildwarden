import { ACP_DEFAULT_MODEL_ID, type RunExecutionRequest } from "@buildwarden/shared";
import type { AcpConnection } from "./connection";
import { isAcpInspectMode, type AcpSessionSettings } from "./session-settings";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reconciles model and mode on both new and resumed sessions before sending the prompt.
 * Returns whether a read-only mode is now selected.
 */
export async function applyAcpSessionSettings(
  connection: Pick<AcpConnection, "request">,
  sessionId: string,
  created: unknown,
  input: Pick<RunExecutionRequest, "modelId" | "mode">,
  settings: AcpSessionSettings,
): Promise<boolean> {
  settings.update(created);
  const select = (kind: "model" | "mode", value: string) => settings.select(kind, value,
    (configId, selected) => connection.request("session/set_config_option", { sessionId, configId, value: selected }));
  if (input.modelId && input.modelId !== ACP_DEFAULT_MODEL_ID) {
    if (settings.selector("model")) await select("model", input.modelId);
    else {
      try {
        await connection.request("session/set_model", { sessionId, modelId: input.modelId });
      } catch (error) {
        throw new Error(`The ACP agent could not select model ${input.modelId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (settings.selector("mode")) {
    const mode = settings.selector("mode");
    const current = mode?.options.find((option) => option.value === mode.currentValue);
    const inspect = (option: { value: string; name: string }) => isAcpInspectMode(option.value, option.name);
    const selected = input.mode === "code"
      ? (current && !inspect(current) ? current : mode?.options.find((option) => /^(default|normal|code|build)$/i.test(option.value) && !inspect(option)))
      : mode?.options.find(inspect);
    if (!selected) {
      if (input.mode === "code" && current && inspect(current)) throw new Error("The ACP session is read-only and offers no recognized code mode.");
      return false;
    }
    await select("mode", selected.value);
    return input.mode !== "code";
  }
  if (!isRecord(created) || !isRecord(created.modes)) return false;
  const modeState = created.modes;
  const modes = Array.isArray(modeState.availableModes) ? modeState.availableModes.filter(isRecord) : [];
  const isInspectMode = (mode: Record<string, unknown>) => isAcpInspectMode(String(mode.id), String(mode.name ?? ""));
  const current = modes.find((mode) => mode.id === modeState.currentModeId);
  // A code follow-up must leave the read-only mode selected on the previous turn. Prefer
  // ordinary code modes; never select a permission-bypass mode merely because it is writable.
  const selected = input.mode === "code"
    ? (current && !isInspectMode(current) ? current : modes.find((mode) => /^(default|normal|code|build)$/i.test(String(mode.id)) && !isInspectMode(mode)))
    : modes.find(isInspectMode);
  if (typeof selected?.id !== "string") {
    if (input.mode === "code" && current && isInspectMode(current)) {
      throw new Error("The ACP session is read-only and offers no recognized code mode. Start a new session or configure the agent's mode.");
    }
    return false;
  }
  if (selected.id !== modeState.currentModeId) {
    try {
      await connection.request("session/set_mode", { sessionId, modeId: selected.id });
    } catch (error) {
      throw new Error(`The ACP agent could not select mode ${selected.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return input.mode !== "code";
}
