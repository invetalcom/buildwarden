import { createInterface } from "node:readline";

/** Asks for one line. The end of the input counts as an empty answer. */
export const promptLine = (
  label: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<string> => new Promise((resolve) => {
  const reader = createInterface({ input, output, terminal: true });
  reader.once("close", () => resolve(""));
  reader.question(label, (answer) => {
    // Closing emits "close" right away, so the answer has to come first.
    resolve(answer.trim());
    reader.close();
  });
});
