const stripOuterMarkdownFence = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  let body = trimmed.replace(/^```(?:json)?/i, "").trim();
  if (body.endsWith("```")) {
    body = body.slice(0, -3).trimEnd();
  }
  return body;
};

const isJsonParseable = (value: string): boolean => {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};

const extractFencedJson = (raw: string): string | null => {
  const openIndex = raw.indexOf("```");
  if (openIndex === -1) {
    return null;
  }
  let contentStart = openIndex + 3;
  if (raw.slice(contentStart, contentStart + 4).toLowerCase() === "json") {
    contentStart += 4;
  }
  const closeIndex = raw.indexOf("```", contentStart);
  if (closeIndex === -1) {
    return null;
  }
  const candidate = raw.slice(contentStart, closeIndex).trim();
  return candidate && isJsonParseable(candidate) ? candidate : null;
};

/** Advances the in-string scanner state for one character. */
const nextStringState = (char: string | undefined, escaped: boolean): { inString: boolean; escaped: boolean } => {
  if (escaped) {
    return { inString: true, escaped: false };
  }
  if (char === "\\") {
    return { inString: true, escaped: true };
  }
  return { inString: char !== '"', escaped: false };
};

const CLOSER_BY_OPENER: Record<string, string> = { "{": "}", "[": "]" };

/** Scans from an opening brace/bracket and returns the balanced slice, or null when unbalanced. */
const scanBalancedJsonCandidate = (text: string, start: number): string | null => {
  const stack = [CLOSER_BY_OPENER[text[start] ?? ""] ?? ""];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      ({ inString, escaped } = nextStringState(char, escaped));
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(CLOSER_BY_OPENER[char]!);
      continue;
    }
    if (char !== stack[stack.length - 1]) {
      continue;
    }

    stack.pop();
    if (stack.length === 0) {
      return text.slice(start, index + 1);
    }
  }
  return null;
};

const extractBalancedJson = (raw: string): string | null => {
  const text = raw.trim();
  for (let start = 0; start < text.length; start += 1) {
    const first = text[start];
    if (first !== "{" && first !== "[") {
      continue;
    }
    const candidate = scanBalancedJsonCandidate(text, start);
    if (candidate && isJsonParseable(candidate)) {
      return candidate;
    }
  }
  return null;
};

export const normalizeJsonResponse = (raw: string): string => {
  const trimmed = raw.trim();
  const outerUnfenced = stripOuterMarkdownFence(trimmed);
  if (isJsonParseable(outerUnfenced)) {
    return outerUnfenced;
  }

  return extractFencedJson(trimmed) ?? extractBalancedJson(outerUnfenced) ?? extractBalancedJson(trimmed) ?? outerUnfenced;
};
