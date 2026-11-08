import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORCHESTRATION_ERROR_MESSAGE_CODES, classifyOrchestrationToolError } from "./orchestration-tools";

const repoRoot = join(__dirname, "..", "..", "..", "..");

/** Every string literal in a source file: the messages its errors can carry. */
const stringLiterals = (path: string): string[] =>
  [...readFileSync(join(repoRoot, path), "utf8").matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((match) => match[2] ?? "");

describe("orchestration error codes from message text", () => {
  it.each(ORCHESTRATION_ERROR_MESSAGE_CODES.map((entry) => [entry.code, entry] as const))(
    "still matches a message its sources raise (%s)",
    (_code, entry) => {
      const matching = entry.sources.filter((source) => stringLiterals(source).some((literal) => entry.pattern.test(literal)));
      // A reworded message would otherwise fall through to internal_error without anyone noticing.
      expect(matching, `${String(entry.pattern)} in ${entry.sources.join(", ")}`).not.toEqual([]);
    },
  );

  it("classifies those messages and leaves the rest internal", () => {
    expect(classifyOrchestrationToolError(new Error("Orchestration task not found: x")).code).toBe("task_not_found");
    expect(classifyOrchestrationToolError(new Error("The Claude turn is not running.")).code).toBe("delivery_unavailable");
    expect(classifyOrchestrationToolError(new Error("Something else broke.")).code).toBe("internal_error");
  });
});
