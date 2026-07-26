import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The mobile UI deliberately owns its own stylesheet, but it speaks the desktop renderer's
 * `--ec-*` token vocabulary so shared status/tone semantics stay in sync. Values may differ
 * (mobile uses more opaque surfaces); the set of declared names may not.
 */

const readTokenNames = (relativePath: string, selector: string): Set<string> => {
  const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
  const blockStart = source.indexOf(selector);
  expect(blockStart, `${selector} not found in ${relativePath}`).toBeGreaterThan(-1);
  const bodyStart = source.indexOf("{", blockStart);
  const bodyEnd = source.indexOf("}", bodyStart);
  const body = source.slice(bodyStart, bodyEnd);
  return new Set([...body.matchAll(/--ec-[a-z0-9-]+/g)].map((match) => match[0]));
};

const DESKTOP_STYLES = "../../../../../packages/renderer/src/styles.css";
const MOBILE_TOKENS = "./tokens.css";

describe("mobile design tokens", () => {
  it("declares exactly the desktop --ec-* dark tokens", () => {
    const desktop = readTokenNames(DESKTOP_STYLES, ':root[data-theme="dark"]');
    const mobile = readTokenNames(MOBILE_TOKENS, ':root[data-theme="dark"]');
    expect([...mobile].sort()).toEqual([...desktop].sort());
  });

  it("declares exactly the desktop --ec-* light tokens", () => {
    const desktop = readTokenNames(DESKTOP_STYLES, ':root[data-theme="light"],');
    const mobile = readTokenNames(MOBILE_TOKENS, ':root[data-theme="light"],');
    expect([...mobile].sort()).toEqual([...desktop].sort());
  });
});
