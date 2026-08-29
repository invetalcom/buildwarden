import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ForgeChecksView } from "./ForgeChecksView";

describe("ForgeChecksView", () => {
  it("renders progress and detailed provider checks", () => {
    const markup = renderToStaticMarkup(
      <ForgeChecksView
        progress={{ completed: 2, total: 3, successful: 1, failed: 1, running: 1 }}
        checks={[
          {
            id: "unit-tests",
            name: "Unit tests",
            status: "success",
            url: "https://ci.example/unit-tests",
            description: "test",
            startedAt: null,
            completedAt: null,
            durationMs: 65_000,
          },
          {
            id: "lint",
            name: "Lint",
            status: "failure",
            url: null,
            description: "quality",
            startedAt: null,
            completedAt: null,
            durationMs: 8_000,
          },
          {
            id: "build",
            name: "Build",
            status: "running",
            url: null,
            description: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        ]}
        readiness="blocked"
        onOpenExternal={vi.fn()}
      />,
    );

    expect(markup).toContain("2 of 3 complete");
    expect(markup).toContain("1 passed · 1 failed · 1 running");
    expect(markup).toContain("Unit tests");
    expect(markup).toContain("Passed · 1m 5s · test");
    expect(markup).toContain("Failed · 8s · quality");
    expect(markup).toContain("aria-label=\"Open Unit tests\"");
  });

  it("renders a concise empty state", () => {
    const markup = renderToStaticMarkup(
      <ForgeChecksView
        progress={{ completed: 0, total: 0, successful: 0, failed: 0, running: 0 }}
        checks={[]}
        readiness="ready"
        onOpenExternal={vi.fn()}
      />,
    );

    expect(markup).toContain("No checks were reported.");
  });

  it("shows completed successful checks in green even when the request is otherwise pending", () => {
    const markup = renderToStaticMarkup(
      <ForgeChecksView
        progress={{ completed: 5, total: 5, successful: 5, failed: 0, running: 0 }}
        checks={[]}
        readiness="pending"
        onOpenExternal={vi.fn()}
      />,
    );

    expect(markup).toContain("conic-gradient(var(--ec-success) 360deg");
    expect(markup).not.toContain("conic-gradient(var(--ec-warning) 360deg");
  });
});
