import { expect, it } from "vitest";
import { sessionInstructionPrompt } from "@buildwarden/agent-runtime";

it("deduplicates only confirmed resumes with the same policy, and restores on context loss", () => {
  const first = sessionInstructionPrompt({ prompt: "Start", instructions: "Policy v1", resumed: false });
  expect(first.prompt).toBe("Policy v1\n\nStart");
  expect(sessionInstructionPrompt({ prompt: "Wake", instructions: "Policy v1", resumed: true, previousHash: first.hash }).prompt).toBe("Wake");
  expect(sessionInstructionPrompt({ prompt: "Wake", instructions: "Policy v1", resumed: false, previousHash: first.hash }).prompt).toContain("Policy v1");
  expect(sessionInstructionPrompt({ prompt: "Wake", instructions: "Policy v2", resumed: true, previousHash: first.hash }).prompt).toContain("Policy v2");
  expect(sessionInstructionPrompt({ prompt: "Wake", instructions: "Policy v1", resumed: true }).prompt).toContain("Policy v1");
});
