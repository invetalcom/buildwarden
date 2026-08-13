import { renderToStaticMarkup } from "react-dom/server";
import type { BuildWardenClient } from "@buildwarden/renderer";
import { describe, expect, it, vi } from "vitest";
import { MobileAppProvider, type MobileAppValue } from "../../data/mobile-app-context";
import { LocalBranchSheet } from "./RunGitSheets";

describe("LocalBranchSheet", () => {
  it("renders the AI branch-name control", () => {
    const value = { client: {} as BuildWardenClient } as MobileAppValue;
    const markup = renderToStaticMarkup(
      <MobileAppProvider value={value}>
        <LocalBranchSheet
          runId="run-1"
          defaultName="feature/current-branch"
          open
          onClose={vi.fn()}
          onDone={vi.fn()}
        />
      </MobileAppProvider>,
    );

    expect(markup).toContain("Create local branch");
    expect(markup).toContain("feature/current-branch");
    expect(markup).toContain("Generate branch name with AI");
  });
});
