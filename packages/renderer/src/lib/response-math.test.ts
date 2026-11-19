import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters } from "./response-math";

describe("normalizeMathDelimiters", () => {
  it("turns \\( \\) and inline \\[ \\] into $$ math", () => {
    expect(normalizeMathDelimiters("so \\(a^2 + b^2\\) holds")).toBe("so $$a^2 + b^2$$ holds");
    expect(normalizeMathDelimiters("where \\[x_1\\] is")).toBe("where $$x_1$$ is");
  });
  it("turns \\[ \\] and $$ $$ on their own lines into display math, keeping list indentation", () => {
    expect(normalizeMathDelimiters("Text:\n\\[\n\\int_0^1 x\\,dx\n\\]\nmore")).toBe("Text:\n$$\n\\int_0^1 x\\,dx\n$$\nmore");
    expect(normalizeMathDelimiters("1. Item\n   $$E = mc^2$$")).toBe("1. Item\n   $$\n   E = mc^2\n   $$");
  });
  it("keeps escaped brackets and prices as text", () => {
    for (const text of [
      "\\[TODO\\] and \\(see notes\\)",
      // Escaped literal text, as quoted citations write it.
      "Use \\*literal\\* \\[text\\]\\(https\\://example\\.com\\)\\.",
      "f\\(x \\+ 1\\) and \\\\\\(a\\_1\\\\\\)",
      "costs $5 and $10", "$1,000 to $2,000", "$5/$10", "pay $ 3 $", "$HOME and $PATH"]) {
      expect(normalizeMathDelimiters(text)).toBe(text);
    }
  });
  it("accepts single-symbol formulas, except in escaped literal text", () => {
    expect(normalizeMathDelimiters("let \\(x\\) vary over \\[n'\\]")).toBe("let $$x$$ vary over $$n'$$");
    // A quoted citation escapes all punctuation: "option (a)." stays text.
    expect(normalizeMathDelimiters("option \\(a\\)\\.")).toBe("option \\(a\\)\\.");
    expect(normalizeMathDelimiters("\\(see notes\\) and \\[TODO\\]")).toBe("\\(see notes\\) and \\[TODO\\]");
  });
  it("leaves URLs alone but still converts math in link text", () => {
    for (const text of [
      "[Open](https://example.com/$x$)",
      "![Plot](<plots/$a$.png> \"t\")",
      "<https://e.com/$y$>",
      "see https://e.com/\\(a+1\\)/$x$ now",
      "[ref]: https://e.com/$x$",
      "[Open](plots/(v1)/$x$.svg)",
      "[Open](plots/\\(v1/$x$.svg)",
      "![Plot](a/((b))/$x$.png \"t\")",
    ]) expect(normalizeMathDelimiters(text)).toBe(text);
    // The destination ends at the link's closing parenthesis; prose after it is still converted.
    expect(normalizeMathDelimiters("([Open](plots/(v1)/a.svg)) and $y$")).toBe("([Open](plots/(v1)/a.svg)) and $$y$$");
    expect(normalizeMathDelimiters("[the $x$ axis](https://e.com/$x$) and $y$"))
      .toBe("[the $$x$$ axis](https://e.com/$x$) and $$y$$");
  });
  it("turns $x$ into math when it qualifies under Pandoc's rules", () => {
    expect(normalizeMathDelimiters("let $x$ and $y_i^2$ vary")).toBe("let $$x$$ and $$y_i^2$$ vary");
    expect(normalizeMathDelimiters("price \\$5 and $x$")).toBe("price \\$5 and $$x$$");
    expect(normalizeMathDelimiters("already $$a$$ math")).toBe("already $$a$$ math");
  });
});
