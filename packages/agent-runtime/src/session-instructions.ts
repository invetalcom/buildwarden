import { createHash } from "node:crypto";

/** The caller must confirm resume succeeded; a saved session ID alone is not evidence. */
export const sessionInstructionPrompt = (input: {
  prompt: string;
  instructions?: string;
  resumed: boolean;
  previousHash?: unknown;
}): { prompt: string; hash?: string } => {
  if (!input.instructions?.trim()) return { prompt: input.prompt };
  const hash = createHash("sha256").update(input.instructions).digest("hex");
  return {
    hash,
    prompt: input.resumed && input.previousHash === hash ? input.prompt
      : `${input.instructions}\n\n${input.prompt}`,
  };
};
