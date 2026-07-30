import type { HarnessType } from "@buildwarden/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderBrandIcon } from "./provider-brand-icons";

const HARNESS_TYPES: HarnessType[] = ["ai-sdk", "azure-legacy", "codex-app-server", "claude-code", "cursor-acp"];

describe("ProviderBrandIcon", () => {
  it("renders a distinct, titled mark for every harness type", () => {
    const markups = HARNESS_TYPES.map((harnessType) => renderToStaticMarkup(<ProviderBrandIcon harnessType={harnessType} />));

    for (const markup of markups) {
      expect(markup).toContain("<title>");
      expect(markup).toContain("<path");
    }
    expect(new Set(markups).size).toBe(HARNESS_TYPES.length);
  });

  it("names the provider so the mark is readable on hover and by screen readers", () => {
    expect(renderToStaticMarkup(<ProviderBrandIcon harnessType="claude-code" />)).toContain("<title>Claude Code</title>");
    expect(renderToStaticMarkup(<ProviderBrandIcon harnessType="cursor-acp" />)).toContain("<title>Cursor Agent</title>");
    expect(renderToStaticMarkup(<ProviderBrandIcon harnessType="azure-legacy" />)).toContain("<title>Azure Legacy</title>");
  });

  it("sizes itself in em so a run row never grows taller than its own line box", () => {
    const markup = renderToStaticMarkup(<ProviderBrandIcon harnessType="codex-app-server" className="size-3" />);
    expect(markup).toContain('width="1em"');
    expect(markup).toContain('height="1em"');
    expect(markup).toContain('class="size-3"');
  });
});
