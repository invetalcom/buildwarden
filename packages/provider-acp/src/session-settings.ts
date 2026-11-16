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

  reset(): void { this.selectors = null; }

  update(payload: unknown): boolean {
    if (!record(payload) || !Array.isArray(payload.configOptions)) return false;
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
    const result = await request(selector.id, value);
    if (!this.update(result) || this.selector(kind)?.currentValue !== value) {
      throw new Error(`The ACP agent did not confirm ${kind} ${value}.`);
    }
  }
}

export const isAcpInspectMode = (id: string, name: string): boolean =>
  [id, name].some((label) => /^(?:plan|ask|read(?:[- _]?only)?)(?: mode)?$/i.test(label.trim()));
