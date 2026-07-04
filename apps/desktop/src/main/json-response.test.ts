import { describe, expect, it } from "vitest";
import { normalizeJsonResponse } from "./json-response";

describe("normalizeJsonResponse", () => {
  it("keeps plain JSON unchanged", () => {
    expect(normalizeJsonResponse('{"headline":"Ready","findings":[]}')).toBe('{"headline":"Ready","findings":[]}');
  });

  it("unwraps markdown fenced JSON", () => {
    expect(normalizeJsonResponse('```json\n{"headline":"Ready"}\n```')).toBe('{"headline":"Ready"}');
  });

  it("extracts a balanced JSON object after provider commentary", () => {
    const raw = [
      "Reviewing the PR diff against existing auth patterns.",
      "{",
      '  "headline": "WorkOS integration needs fixes",',
      '  "summary": "Several security-sensitive paths need follow-up.",',
      '  "findings": [',
      '    { "title": "Do not log codes", "detail": "The string contains { braces } but is still JSON." }',
      "  ],",
      '  "nextSteps": ["Stop logging OAuth codes"]',
      "}",
    ].join("\n");

    expect(JSON.parse(normalizeJsonResponse(raw))).toMatchObject({
      headline: "WorkOS integration needs fixes",
      findings: [{ title: "Do not log codes" }],
    });
  });

  it("returns normalized text when no JSON value is present", () => {
    expect(normalizeJsonResponse("  No structured payload.  ")).toBe("No structured payload.");
  });

  it("extracts a fenced JSON array embedded after leading commentary", () => {
    const raw = "Here is the result:\n```\n[1, 2, 3]\n```\nThanks!";

    expect(normalizeJsonResponse(raw)).toBe("[1, 2, 3]");
  });

  it("extracts a balanced JSON array without surrounding fences", () => {
    const raw = 'Findings follow: ["one", "two"] end of message';

    expect(JSON.parse(normalizeJsonResponse(raw))).toEqual(["one", "two"]);
  });

  it("falls back to the trimmed original text when braces never balance", () => {
    const raw = "  Some commentary { not valid json  ";

    expect(normalizeJsonResponse(raw)).toBe("Some commentary { not valid json");
  });
});
