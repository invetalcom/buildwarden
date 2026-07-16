import { describe, expect, it } from "vitest";
import { getOpenableInlineCodePath, looksLikeRunWorkspaceFilePath } from "./activity-file-links";

describe("activity file link helpers", () => {
  it("detects inline-code workspace file paths", () => {
    expect(getOpenableInlineCodePath("Backend/src/main/java/com/invetal/stockgenious/service/marketdata/MarketDataService.java")).toBe(
      "Backend/src/main/java/com/invetal/stockgenious/service/marketdata/MarketDataService.java",
    );
    expect(getOpenableInlineCodePath(["src/app/components/task-card/task-card.component.ts:42"])).toBe(
      "src/app/components/task-card/task-card.component.ts:42",
    );
    expect(getOpenableInlineCodePath("/C:/Users/r-kel/repos/project/Backend/src/Main.java#L13")).toBe(
      "/C:/Users/r-kel/repos/project/Backend/src/Main.java#L13",
    );
  });

  it("allows common root-level file names", () => {
    expect(getOpenableInlineCodePath("README.md")).toBe("README.md");
    expect(getOpenableInlineCodePath("package.json")).toBe("package.json");
    expect(getOpenableInlineCodePath("Backend/Dockerfile")).toBe("Backend/Dockerfile");
  });

  it("does not treat ordinary inline code as file links", () => {
    expect(getOpenableInlineCodePath("TradeInitiator")).toBeNull();
    expect(getOpenableInlineCodePath("MarketDataFetcher.java")).toBeNull();
    expect(getOpenableInlineCodePath("src/main/java/")).toBeNull();
    expect(getOpenableInlineCodePath("https://example.com/src/App.tsx")).toBeNull();
  });

  it("requires plain text children", () => {
    expect(getOpenableInlineCodePath(["src/App.tsx", { type: "span" }])).toBeNull();
  });

  it("rejects overly broad non-path snippets", () => {
    expect(looksLikeRunWorkspaceFilePath("react-dom/client")).toBe(false);
    expect(looksLikeRunWorkspaceFilePath("Use the value from foo.bar here")).toBe(false);
  });
});
