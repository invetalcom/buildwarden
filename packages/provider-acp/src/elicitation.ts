import type { RunUserInputAnswers, RunUserInputQuestion, RunUserInputRequest } from "@buildwarden/shared";

/**
 * ACP form elicitation (unstable in ACP): the agent asks the user to fill in a small form, given as
 * a flat JSON Schema object. BuildWarden shows it as the run's question card and returns the
 * answers typed as the schema declares them. URL elicitation is not advertised.
 */

const MAX_FIELDS = 3;
const MAX_OPTIONS = 20;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

interface Choice { value: string; label: string; description?: string }

interface Field {
  key: string;
  questionId: string;
  kind: "string" | "number" | "integer" | "boolean" | "choice" | "multi";
  required: boolean;
  choices: Choice[];
  /** Whether an answer meets the schema's limits (bounds, lengths, pattern, format, item counts). */
  accepts: (value: string | number | boolean | string[]) => boolean;
}

const FORMATS: Record<string, (value: string) => boolean> = {
  email: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  uri: (value) => URL.canParse(value),
  date: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)),
  "date-time": (value) => /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)),
};

/**
 * The limits a field's schema sets, as one check; null when the schema sets one BuildWarden cannot
 * check, so the form is not shown rather than answered with a value the agent did not allow.
 */
const readLimits = (schema: Record<string, unknown>): Field["accepts"] | null => {
  const number = (key: string) => (typeof schema[key] === "number" ? schema[key] : undefined);
  const checks: Array<(value: string | number | boolean | string[]) => boolean> = [];
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, minLength, maxLength, minItems, maxItems } = {
    minimum: number("minimum"), maximum: number("maximum"), exclusiveMinimum: number("exclusiveMinimum"), exclusiveMaximum: number("exclusiveMaximum"),
    minLength: number("minLength"), maxLength: number("maxLength"), minItems: number("minItems"), maxItems: number("maxItems"),
  };
  if (minimum !== undefined) checks.push((value) => typeof value !== "number" || value >= minimum);
  if (maximum !== undefined) checks.push((value) => typeof value !== "number" || value <= maximum);
  if (exclusiveMinimum !== undefined) checks.push((value) => typeof value !== "number" || value > exclusiveMinimum);
  if (exclusiveMaximum !== undefined) checks.push((value) => typeof value !== "number" || value < exclusiveMaximum);
  if (minLength !== undefined) checks.push((value) => typeof value !== "string" || [...value].length >= minLength);
  if (maxLength !== undefined) checks.push((value) => typeof value !== "string" || [...value].length <= maxLength);
  if (minItems !== undefined) checks.push((value) => !Array.isArray(value) || value.length >= minItems);
  if (maxItems !== undefined) checks.push((value) => !Array.isArray(value) || value.length <= maxItems);
  if (schema.pattern !== undefined) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(String(schema.pattern), "u");
    } catch {
      return null;
    }
    checks.push((value) => typeof value !== "string" || pattern.test(value));
  }
  if (schema.format !== undefined) {
    const format = typeof schema.format === "string" ? FORMATS[schema.format] : undefined;
    if (!format) return null;
    checks.push((value) => typeof value !== "string" || format(value));
  }
  return (value) => checks.every((check) => check(value));
};

/** Plain `enum` values, or titled `oneOf`/`anyOf` entries, as choices. */
const readChoices = (schema: Record<string, unknown>): Choice[] | null => {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.every((entry) => typeof entry === "string")
      ? (schema.enum as string[]).map((entry) => ({ value: entry, label: entry }))
      : null;
  }
  const titled = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null;
  if (!titled || titled.length === 0) return null;
  const choices = titled.map((entry): Choice | null => {
    if (!isRecord(entry) || typeof entry.const !== "string") return null;
    return { value: entry.const, label: text(entry.title) ?? entry.const, ...(text(entry.description) ? { description: text(entry.description)! } : {}) };
  });
  return choices.every((choice): choice is Choice => choice !== null) ? choices : null;
};

export interface ElicitationForm {
  request: RunUserInputRequest;
  /** The elicitation response for the user's answers: accepted content, or a cancel when a required field is left empty or an answer breaks the schema's limits. */
  respond: (answers: RunUserInputAnswers) => { action: "accept"; content: Record<string, string | number | boolean | string[]> } | { action: "cancel" };
}

/** The form as BuildWarden asks it, or null when it cannot be shown faithfully. */
export const readElicitationForm = (raw: unknown): ElicitationForm | null => {
  const params = isRecord(raw) ? raw : {};
  if (params.mode !== undefined && params.mode !== "form") return null;
  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : null;
  const properties = schema && isRecord(schema.properties) ? Object.entries(schema.properties) : [];
  if (properties.length === 0 || properties.length > MAX_FIELDS) return null;
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((key): key is string => typeof key === "string") : []);
  const fields: Field[] = [];
  const questions: RunUserInputQuestion[] = [];
  for (const [index, [key, value]] of properties.entries()) {
    if (!isRecord(value)) return null;
    const questionId = `field_${String(index)}`;
    const header = text(value.title) ?? key;
    const question = text(value.description) ?? header;
    const accepts = readLimits(value);
    if (!accepts) return null;
    const base = { key, questionId, required: required.has(key), accepts };
    if (value.type === "boolean") {
      fields.push({ ...base, kind: "boolean", choices: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] });
    } else if (value.type === "array") {
      const choices = isRecord(value.items) ? readChoices(value.items) : null;
      if (!choices) return null;
      fields.push({ ...base, kind: "multi", choices });
    } else if (value.type === "string" || value.type === "number" || value.type === "integer") {
      const choices = value.type === "string" ? readChoices(value) : null;
      fields.push(choices ? { ...base, kind: "choice", choices } : { ...base, kind: value.type, choices: [] });
    } else {
      return null;
    }
    const field = fields.at(-1)!;
    if (field.choices.length > MAX_OPTIONS) return null;
    // The answer names a choice by its label, so two choices with one label cannot be told apart.
    if (new Set(field.choices.map((choice) => choice.label)).size !== field.choices.length) return null;
    questions.push({
      id: questionId,
      header: header.slice(0, 80),
      question,
      options: field.choices.map((choice) => ({ label: choice.label, ...(choice.description ? { description: choice.description } : {}) })),
      ...(field.kind === "multi" ? { multiSelect: true } : {}),
      // Free values are typed; a field with fixed choices takes only those.
      ...(field.choices.length === 0 ? { allowCustomAnswer: true } : {}),
    });
  }
  return {
    request: {
      title: "The agent asks for input",
      content: text(params.message) ?? "The agent needs some information to continue.",
      questions,
      metadata: { provider: "acp", elicitation: true },
    },
    respond: (answers) => {
      // Entries, not assignments: a property named __proto__ must stay an answer, not set a prototype.
      const content: Array<[string, string | number | boolean | string[]]> = [];
      for (const field of fields) {
        const answer = answers[field.questionId];
        const values = (Array.isArray(answer) ? answer : answer === undefined ? [] : [answer]).map((entry) => entry.trim()).filter(Boolean);
        // A label wins over another choice's value: "blue" may be one choice's value and another's label.
        const byLabel = (label: string) => (field.choices.find((choice) => choice.label === label)
          ?? field.choices.find((choice) => choice.value === label))?.value;
        let typed: string | number | boolean | string[] | undefined;
        if (field.kind === "multi") {
          const selected = values.map(byLabel).filter((value): value is string => value !== undefined);
          typed = selected.length > 0 || values.length === 0 ? selected : undefined;
          if (typed !== undefined && typed.length === 0 && field.required) typed = undefined;
        } else if (values.length > 0) {
          const first = values[0]!;
          if (field.kind === "boolean") typed = byLabel(first) === undefined ? undefined : byLabel(first) === "true";
          else if (field.kind === "choice") typed = byLabel(first);
          else if (field.kind === "number") typed = Number.isFinite(Number(first)) ? Number(first) : undefined;
          else if (field.kind === "integer") typed = /^-?\d+$/.test(first) ? Number.parseInt(first, 10) : undefined;
          else typed = first;
        }
        if (typed === undefined) {
          if (field.required) return { action: "cancel" };
          continue;
        }
        // An answer outside the schema's limits is not sent as if the agent had allowed it.
        if (!field.accepts(typed)) return { action: "cancel" };
        content.push([field.key, typed]);
      }
      return { action: "accept", content: Object.fromEntries(content) };
    },
  };
};
