import {
  DEFAULT_HOME_LAYOUT,
  DESIGN_THEME_GUIDE,
  HOME_CHART_METRICS,
  HOME_CSS_HOOKS,
  HOME_SECTIONS,
  HOME_STATS,
  isDefaultHomeLayout,
  mergeHomeLayout,
  parseHomeLayout,
  serializeHomeLayout,
} from "@buildwarden/shared";
import { describe, expect, it } from "vitest";

describe("Home layout setting", () => {
  it("falls back to the default layout for a missing or damaged value", () => {
    expect(parseHomeLayout(undefined)).toEqual(DEFAULT_HOME_LAYOUT);
    expect(parseHomeLayout("")).toEqual(DEFAULT_HOME_LAYOUT);
    expect(parseHomeLayout("{not json")).toEqual(DEFAULT_HOME_LAYOUT);
    expect(parseHomeLayout("[1,2]")).toEqual(DEFAULT_HOME_LAYOUT);
    expect(isDefaultHomeLayout(parseHomeLayout(null))).toBe(true);
  });

  it("round-trips a layout", () => {
    const layout = {
      ...DEFAULT_HOME_LAYOUT,
      sections: ["projects" as const, "greeting" as const],
      stats: ["waiting" as const],
      greetingText: "Hi",
      chart: { show: false, metrics: ["cost" as const, "runs" as const], range: 7 as const },
      position: "top" as const,
    };
    expect(parseHomeLayout(serializeHomeLayout(layout))).toEqual(layout);
    expect(isDefaultHomeLayout(layout)).toBe(false);
  });

  it("keeps the valid fields of a stored value and defaults the rest", () => {
    const layout = parseHomeLayout(JSON.stringify({ sections: ["runs", "runs", "bogus", "greeting"], recentRuns: 99, width: "wide", chart: { range: 12, metrics: [] }, bootMessage: false }));
    expect(layout.sections).toEqual(["runs", "greeting"]);
    expect(layout.recentRuns).toBe(8);
    expect(layout.width).toBe(DEFAULT_HOME_LAYOUT.width);
    expect(layout.chart).toEqual(DEFAULT_HOME_LAYOUT.chart);
    expect(layout.bootMessage).toBe(false);
  });

  it("allows a page without middle sections but not a row of figures or a chart without content", () => {
    const { layout, ignored } = mergeHomeLayout(DEFAULT_HOME_LAYOUT, { sections: [], stats: [], chart: { metrics: [] } });
    expect(layout.sections).toEqual([]);
    expect(layout.stats).toEqual(DEFAULT_HOME_LAYOUT.stats);
    expect(layout.chart.metrics).toEqual(DEFAULT_HOME_LAYOUT.chart.metrics);
    expect(ignored).toEqual(["stats", "chart.metrics"]);
  });

  it("merges a patch, returns single fields to their default with null, and reports what it could not use", () => {
    const base = { ...DEFAULT_HOME_LAYOUT, recentRuns: 6, greetingText: "Hi", chart: { ...DEFAULT_HOME_LAYOUT.chart, range: 7 as const } };
    const { layout, ignored } = mergeHomeLayout(base, { recentRuns: null, position: "left", colour: "red", chart: { range: null, style: "grouped", show: "yes" } });
    expect(layout.recentRuns).toBe(DEFAULT_HOME_LAYOUT.recentRuns);
    expect(layout.greetingText).toBe("Hi");
    expect(layout.chart.range).toBe(DEFAULT_HOME_LAYOUT.chart.range);
    expect(layout.position).toBe("center");
    expect(ignored.sort()).toEqual(["chart.show", "chart.style", "colour", "position"]);
    // The base is never changed in place.
    expect(base.recentRuns).toBe(6);
    expect(base.chart.range).toBe(7);
  });

  it("tells agents about every option and every Home selector", () => {
    for (const entry of [...HOME_SECTIONS, ...HOME_STATS, ...HOME_CHART_METRICS]) expect(DESIGN_THEME_GUIDE).toContain(entry.key);
    for (const field of ["home.sections", "home.stats", "home.recentRuns", "home.greetingText", "home.bootMessage", "home.chart.show", "home.chart.metrics", "home.chart.range", "home.width", "home.position"]) {
      expect(DESIGN_THEME_GUIDE).toContain(field);
    }
    for (const hook of HOME_CSS_HOOKS) expect(DESIGN_THEME_GUIDE).toContain(hook.selector);
  });
});
