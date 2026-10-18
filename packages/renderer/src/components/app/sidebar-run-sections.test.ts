import { parseSidebarRunSectionsSetting, parseSidebarRunViewSetting, type RunRecord } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import { resolveRunSidebarSectionId, sidebarRunMatchesView } from "./sidebar-run-sections";

const run = (overrides: Partial<RunRecord>): RunRecord => ({ id: "run-1", status: "completed", ...overrides }) as RunRecord;

describe("sidebar run sections", () => {
  it("parses section settings defensively", () => {
    expect(parseSidebarRunSectionsSetting(undefined)).toEqual({ sections: [], uncategorizedCollapsed: false });
    expect(parseSidebarRunSectionsSetting("not json").sections).toEqual([]);
    expect(parseSidebarRunSectionsSetting(JSON.stringify({
      sections: [
        { id: "a", name: "  Release  ", color: "warning", collapsed: true },
        { id: "a", name: "Duplicate" },
        { id: "b", name: " " },
        { id: "c", name: "Perf", color: "neon" },
        "invalid",
      ],
      uncategorizedCollapsed: true,
    }))).toEqual({
      sections: [
        { id: "a", name: "Release", color: "warning", collapsed: true },
        { id: "c", name: "Perf", color: "accent", collapsed: false },
      ],
      uncategorizedCollapsed: true,
    });
    expect(parseSidebarRunViewSetting("failed")).toBe("failed");
    expect(parseSidebarRunViewSetting("bogus")).toBe("all");
  });

  it("falls back to Uncategorized for unknown sections and honors pending moves", () => {
    const sectionIds = new Set(["release"]);
    expect(resolveRunSidebarSectionId(run({ sidebarSectionId: "release" }), sectionIds)).toBe("release");
    expect(resolveRunSidebarSectionId(run({ sidebarSectionId: "deleted" }), sectionIds)).toBeNull();
    expect(resolveRunSidebarSectionId(run({}), sectionIds)).toBeNull();
    expect(resolveRunSidebarSectionId(run({ sidebarSectionId: "release" }), sectionIds, new Map([["run-1", null]]))).toBeNull();
    expect(resolveRunSidebarSectionId(run({}), sectionIds, new Map([["run-1", "release"]]))).toBe("release");
  });

  it("maps run states to status views", () => {
    expect(sidebarRunMatchesView(run({ status: "running" }), "active")).toBe(true);
    expect(sidebarRunMatchesView(run({ status: "completed", pendingUserInputRequest: true }), "active")).toBe(true);
    expect(sidebarRunMatchesView(run({ status: "running", orchestrationStatus: "attention" }), "active")).toBe(false);
    expect(sidebarRunMatchesView(run({ status: "running", orchestrationStatus: "attention" }), "failed")).toBe(true);
    expect(sidebarRunMatchesView(run({ status: "failed" }), "failed")).toBe(true);
    expect(sidebarRunMatchesView(run({ status: "completed" }), "done")).toBe(true);
    expect(sidebarRunMatchesView(run({ status: "cancelled" }), "done")).toBe(false);
    expect(sidebarRunMatchesView(run({ status: "cancelled" }), "all")).toBe(true);
  });
});
