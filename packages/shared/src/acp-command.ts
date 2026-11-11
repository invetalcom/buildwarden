// Pure parsing of the ACP agent launch settings, shared by the adapter and the main process.

/** Splits a command line into words, honoring single and double quotes. */
export const parseAcpCommandLine = (line: string): string[] => {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let hasWord = false;
  for (const character of line.trim()) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      hasWord = true;
    } else if (/\s/.test(character)) {
      if (hasWord) words.push(current);
      current = "";
      hasWord = false;
    } else {
      current += character;
      hasWord = true;
    }
  }
  if (quote) throw new Error("The ACP agent command has an unclosed quote.");
  if (hasWord) words.push(current);
  return words;
};

const ENV_ASSIGNMENT = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=(.*)$/s;

/** Splits on separators outside double quotes; a quote that never closes is an error. */
const splitOutsideQuotes = (line: string, separator: string): string[] => {
  const pieces: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of line) {
    if (character === '"') quoted = !quoted;
    if (character === separator && !quoted) {
      pieces.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (quoted) throw new Error("An ACP environment value has an unclosed quote.");
  pieces.push(current);
  return pieces;
};

const unquote = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
};

/**
 * Parses `KEY=VALUE` pairs separated by newlines or semicolons. A piece after a semicolon that
 * does not start a new assignment belongs to the previous value, so path lists such as
 * `PATH=C:\a;C:\b` keep their semicolons. A double-quoted value is taken literally, so
 * `TOKEN="abc;part=def"` keeps a semicolon followed by something that looks like a key.
 */
export const parseAcpEnvironment = (value: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const line of value.split("\n")) {
    let lastKey: string | null = null;
    for (const piece of splitOutsideQuotes(line, ";")) {
      const assignment = ENV_ASSIGNMENT.exec(piece);
      if (assignment) {
        lastKey = assignment[1]!;
        env[lastKey] = unquote(assignment[2]!);
      } else if (!piece.trim()) {
        continue;
      } else if (lastKey) {
        env[lastKey] = `${env[lastKey]};${piece.trim()}`;
      } else {
        throw new Error(`ACP environment entry "${piece.trim()}" must look like KEY=VALUE.`);
      }
    }
  }
  return env;
};
