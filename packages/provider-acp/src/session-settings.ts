import type { ProviderAvailableModel } from "@buildwarden/shared";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

interface Choice { value: string; name: string; description?: string }
interface Selector { id: string; category?: string; currentValue: string; options: Choice[] }

const choices = (value: unknown): Choice[] => !Array.isArray(value) ? [] : value.filter(record).flatMap((entry): Choice[] => {
  if (Array.isArray(entry.options)) return choices(entry.options);
  return typeof entry.value === "string" ? [{ value: entry.value, name: typeof entry.name === "string" ? entry.name : entry.value,
    ...(typeof entry.description === "string" ? { description: entry.description } : {}) }] : [];
});

/** Session config responses replace the entire option list, including values changed by the agent. */
export class AcpSessionSettings {
  private selectors: Selector[] | null = null;
  private revision = 0;

  reset(): void { this.selectors = null; this.revision += 1; }

  update(payload: unknown): boolean {
    if (!record(payload) || !Array.isArray(payload.configOptions)) return false;
    this.revision += 1;
    this.selectors = payload.configOptions.filter(record).flatMap((option): Selector[] =>
      option.type === "select" && typeof option.id === "string" && typeof option.currentValue === "string"
        ? [{ id: option.id, ...(typeof option.category === "string" ? { category: option.category } : {}),
          currentValue: option.currentValue, options: choices(option.options) }] : []);
    return true;
  }

  get usesConfigOptions(): boolean { return this.selectors !== null; }

  selector(kind: "model" | "mode"): Selector | undefined {
    return this.selectors?.find((option) => option.category === kind)
      ?? this.selectors?.find((option) => option.id === kind);
  }

  get currentModel(): string | undefined { return this.selector("model")?.currentValue; }

  async configure(values: unknown, request: (id: string, value: string) => Promise<unknown>): Promise<void> {
    if (values === undefined) return;
    if (!record(values)) throw new Error("ACP session options must be an object of option IDs and string values.");
    for (const [id, value] of Object.entries(values)) {
      const selector = this.selectors?.find((option) => option.id === id);
      if (!selector || typeof value !== "string" || !selector.options.some((option) => option.value === value)) {
        throw new Error(`The ACP agent does not offer option ${id} with value ${String(value)}.`);
      }
      if (["model", "mode"].includes(selector.category ?? selector.id)) {
        throw new Error(`Select ACP ${id} through the run's model and mode controls.`);
      }
      if (selector.currentValue === value) continue;
      const revision = this.revision;
      const result = await request(id, value);
      if (this.revision === revision && !this.update(result)) throw new Error(`The ACP agent did not confirm option ${id}.`);
      if (this.selectors?.find((option) => option.id === id)?.currentValue !== value) throw new Error(`The ACP agent did not confirm option ${id}.`);
    }
    for (const [id, value] of Object.entries(values)) {
      if (this.selectors?.find((option) => option.id === id)?.currentValue !== value) {
        throw new Error(`The ACP agent changed requested option ${id} before configuration finished.`);
      }
    }
  }

  models(): ProviderAvailableModel[] {
    return (this.selector("model")?.options ?? []).map((option) => ({
      modelId: option.value, displayName: option.name, source: "provider", ...(option.description ? { description: option.description } : {}),
    }));
  }

  async select(kind: "model" | "mode", value: string, request: (id: string, value: string) => Promise<unknown>): Promise<void> {
    const selector = this.selector(kind);
    if (!selector || !selector.options.some((option) => option.value === value)) {
      throw new Error(`The ACP agent does not offer ${kind} ${value}.`);
    }
    if (selector.currentValue === value) return;
    const revision = this.revision;
    const result = await request(selector.id, value);
    // Notifications processed while awaiting the response are newer authoritative state.
    const confirmed = this.revision !== revision || this.update(result);
    if (!confirmed || this.selector(kind)?.currentValue !== value) {
      throw new Error(`The ACP agent did not confirm ${kind} ${value}.`);
    }
  }
}

export const isAcpInspectMode = (id: string, name: string): boolean =>
  [id, name].some((label) => /^(?:plan|ask|read(?:[- _]?only)?)(?: mode)?$/i.test(label.trim()));
