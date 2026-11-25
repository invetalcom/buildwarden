import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { promptLine } from "./prompt-line";

describe("promptLine", () => {
  it.each([["yes\n", "yes"], [" yes \r", "yes"], ["\n", ""]])("answers %j with %j", async (typed, expected) => {
    const input = new PassThrough();
    const answer = promptLine("Continue? ", input, new PassThrough());
    input.write(typed);
    expect(await answer).toBe(expected);
  });

  it("answers with nothing when the input ends", async () => {
    const input = new PassThrough();
    const answer = promptLine("Continue? ", input, new PassThrough());
    input.end();
    expect(await answer).toBe("");
  });
});
