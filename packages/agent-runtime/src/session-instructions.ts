import { createHash } from "node:crypto";

/**
 * Standing instructions for agents without an instruction channel: they travel in the first prompt
 * of a session and again only when they change.
 * The caller must confirm resume succeeded; a saved session ID alone is not evidence.
 */
export const sessionInstructionPrompt = (input: {
  prompt: string;
  instructions?: string;
  resumed: boolean;
  previousHash?: unknown;
  /** The prompt is one of the agent's own commands, which must start the message. */
  nativeCommand?: boolean;
}): { prompt: string; hash?: string } => {
  if (!input.instructions?.trim()) return { prompt: input.prompt };
  if (input.nativeCommand) {
    // The instructions wait for the next turn. A resumed session keeps the hash of the ones it holds.
    return input.resumed && typeof input.previousHash === "string"
      ? { prompt: input.prompt, hash: input.previousHash }
      : { prompt: input.prompt };
  }
  const hash = createHash("sha256").update(input.instructions).digest("hex");
  return {
    hash,
    prompt: input.resumed && input.previousHash === hash ? input.prompt
      : `<buildwarden_instructions>\nBuildWarden added these standing instructions. The user's message follows them.\n\n${input.instructions.trim()}\n</buildwarden_instructions>\n\n${input.prompt}`,
  };
};
