import { describe, expect, it } from "vitest";
import { parseStepMetadata } from "./chat-steps";

describe("parseStepMetadata", () => {
  it("preserves object metadata", () => {
    expect(parseStepMetadata('{"source":"user"}')).toEqual({ source: "user" });
  });

  it.each(["null", "true", "42", '"text"', "[]", "{bad json"])(
    "normalizes non-object metadata from %s",
    (metadataJson) => {
      expect(parseStepMetadata(metadataJson)).toEqual({});
    },
  );
});
