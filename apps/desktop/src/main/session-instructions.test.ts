import { expect, it } from "vitest";
import { sessionInstructionPrompt } from "@buildwarden/agent-runtime";

it("deduplicates only confirmed resumes with the same policy, and restores on context loss", () => {
  const first = sessionInstructionPrompt({ prompt: "Start", instructions: "Policy v1", resumed: false });
  expect(first.prompt).toMatch(/^<buildwarden_instructions>\n[\s\S]*Policy v1\n<\/buildwarden_instructions>\n\nStart$/);
  expect(sessionInstructionPrompt({ prompt: "Wake", instructions: "Policy v1", resumed: true, previousHash: first.hash }).prompt).toBe("Wake");
  expect(sessionInstructionPrompt({ prompt: "Wake", instructions: "Policy v1", resumed: false, previousHash: first.hash }).prompt).toContain("Policy v1");
  expect(sessionInstructionPrompt({ prompt: "Wake", instructions: "Policy v2", resumed: true, previousHash: first.hash }).prompt).toContain("Policy v2");
  expect(sessionInstructionPrompt({ prompt: "Wake", instructions: "Policy v1", resumed: true }).prompt).toContain("Policy v1");
});

it("keeps a native command at the start of the message and sends the policy with the next turn", () => {
  const command = sessionInstructionPrompt({ prompt: "/compact", instructions: "Policy v1", resumed: false, nativeCommand: true });
  expect(command).toEqual({ prompt: "/compact" });
  expect(sessionInstructionPrompt({ prompt: "Next", instructions: "Policy v1", resumed: true, previousHash: command.hash }).prompt).toContain("Policy v1");
  // Text that only starts with a slash is an ordinary message.
  expect(sessionInstructionPrompt({ prompt: "/tmp is full", instructions: "Policy v1", resumed: false }).prompt).toContain("Policy v1");
});

it("keeps the delivered policy's hash across a native command on a resumed session", () => {
  const first = sessionInstructionPrompt({ prompt: "Start", instructions: "Policy v1", resumed: false });
  const command = sessionInstructionPrompt({ prompt: "/compact", instructions: "Policy v1", resumed: true, previousHash: first.hash, nativeCommand: true });
  expect(command).toEqual({ prompt: "/compact", hash: first.hash });
  expect(sessionInstructionPrompt({ prompt: "Next", instructions: "Policy v1", resumed: true, previousHash: command.hash }).prompt).toBe("Next");
});
