const stripOuterMarkdownFence = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
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
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = match?.[1]?.trim();
  return candidate && isJsonParseable(candidate) ? candidate : null;
};

const extractBalancedJson = (raw: string): string | null => {
  const text = raw.trim();
  for (let start = 0; start < text.length; start += 1) {
    const first = text[start];
    if (first !== "{" && first !== "[") {
      continue;
    }

    const stack = [first === "{" ? "}" : "]"];
    let inString = false;
    let escaped = false;

    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{" || char === "[") {
        stack.push(char === "{" ? "}" : "]");
        continue;
      }
      if (char !== stack[stack.length - 1]) {
        continue;
      }

      stack.pop();
      if (stack.length === 0) {
        const candidate = text.slice(start, index + 1);
        if (isJsonParseable(candidate)) {
          return candidate;
        }
        break;
      }
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
