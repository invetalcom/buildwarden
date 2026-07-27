import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MARKDOWN_EXTRA_TAG_NAMES,
  MARKDOWN_HREF_PROTOCOLS,
  MARKDOWN_SRC_PROTOCOLS,
  markdownSanitizeSchema,
} from "./markdown-sanitize";

/**
 * Both UIs render the same untrusted agent output with raw HTML enabled, so their sanitisation
 * allow-lists must not drift apart. The desktop schema is a literal inside a component file, so it
 * is compared as source text rather than imported (importing it would pull the desktop renderer
 * into a node-environment test).
 */
const DESKTOP_SOURCE = "../../../../../packages/renderer/src/components/ui/activity-rich-text.tsx";

const desktopSchemaSource = (): string => {
  const source = readFileSync(fileURLToPath(new URL(DESKTOP_SOURCE, import.meta.url)), "utf8");
  const start = source.indexOf("const markdownSanitizeSchema");
  expect(start, "desktop markdownSanitizeSchema not found").toBeGreaterThan(-1);
  const end = source.indexOf("\n};", start);
  expect(end, "desktop markdownSanitizeSchema is not terminated").toBeGreaterThan(start);
  return source.slice(start, end);
};

/**
 * Every allow-list in the desktop schema is declared on one line, so the quoted entries on that
 * line are the additions. Line-based rather than brace-matching: `tagNames` spreads
 * `defaultSchema.tagNames` first, which a naive bracket match would stop inside.
 */
const listAfter = (source: string, key: string): string[] => {
  const line = source.split("\n").find((entry) => entry.trim().startsWith(`${key}:`));
  expect(line, `${key} not found in the desktop schema`).toBeDefined();
  return [...(line ?? "").matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
};

describe("markdown sanitisation", () => {
  it("blocks javascript: and data: URLs in links and images", () => {
    expect(markdownSanitizeSchema.protocols.href).not.toContain("javascript");
    expect(markdownSanitizeSchema.protocols.href).not.toContain("data");
    expect(markdownSanitizeSchema.protocols.src).not.toContain("javascript");
    expect(markdownSanitizeSchema.protocols.src).not.toContain("data");
  });

  it("never allows script or event-handler attributes through", () => {
    expect(markdownSanitizeSchema.tagNames).not.toContain("script");
    expect(markdownSanitizeSchema.tagNames).not.toContain("iframe");
    expect(markdownSanitizeSchema.tagNames).not.toContain("style");
    const attributes = Object.values(markdownSanitizeSchema.attributes ?? {}).flat();
    expect(attributes.filter((entry) => typeof entry === "string" && entry.startsWith("on"))).toEqual([]);
  });

  it("allows the same href and src protocols as the desktop renderer", () => {
    const desktop = desktopSchemaSource();
    expect(listAfter(desktop, "href")).toEqual([...MARKDOWN_HREF_PROTOCOLS]);
    expect(listAfter(desktop, "src")).toEqual([...MARKDOWN_SRC_PROTOCOLS]);
  });

  it("allows the same extra raw-HTML tags as the desktop renderer", () => {
    const desktop = desktopSchemaSource();
    expect(listAfter(desktop, "tagNames")).toEqual([...MARKDOWN_EXTRA_TAG_NAMES]);
  });
});
