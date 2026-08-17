import { describe, expect, it } from "vitest";
import {
  HOME_ROUTE,
  applyTabSwitch,
  parseRoute,
  routesEqual,
  serializeRoute,
  tabForRoute,
  type MobileRoute,
} from "./mobile-router";

const ROUND_TRIP: MobileRoute[] = [
  { name: "home" },
  { name: "runs" },
  { name: "chats" },
  { name: "more" },
  { name: "projects" },
  { name: "bookmarks" },
  { name: "search" },
  { name: "run", runId: "run-1", segment: "diff" },
  { name: "run", runId: "run-1", segment: "pull-request" },
  { name: "chat", chatId: "chat-1" },
  { name: "project", projectId: "proj-1", tab: "branches" },
  { name: "new-run" },
  { name: "new-run", projectId: "proj-1" },
  { name: "new-run", projectId: "proj-1", taskId: "task-1" },
  { name: "settings" },
  { name: "settings", section: "models" },
];

describe("route serialisation", () => {
  it("round-trips every route", () => {
    for (const route of ROUND_TRIP) {
      expect(parseRoute(serializeRoute(route))).toEqual(route);
    }
  });

  it("tolerates a leading hash and trailing slashes", () => {
    expect(parseRoute("#/runs")).toEqual({ name: "runs" });
    expect(parseRoute("#/")).toEqual(HOME_ROUTE);
    expect(parseRoute("")).toEqual(HOME_ROUTE);
  });

  it("encodes identifiers that contain slashes", () => {
    const route: MobileRoute = { name: "project", projectId: "a/b", tab: "overview" };
    expect(serializeRoute(route)).toBe("/project/a%2Fb/overview");
    expect(parseRoute(serializeRoute(route))).toEqual(route);
  });

  it("falls back to the default sub-view for an unknown segment or tab", () => {
    expect(parseRoute("/run/run-1/nope")).toEqual({ name: "run", runId: "run-1", segment: "activity" });
    expect(parseRoute("/project/p1/nope")).toEqual({ name: "project", projectId: "p1", tab: "overview" });
    expect(parseRoute("/settings/nope")).toEqual({ name: "settings" });
  });

  it("returns null for unroutable paths so the caller can keep the current screen", () => {
    expect(parseRoute("/nonsense")).toBeNull();
    expect(parseRoute("/run")).toBeNull();
    expect(parseRoute("/chat")).toBeNull();
  });
});

describe("tabForRoute", () => {
  it("maps detail routes back onto their owning tab", () => {
    expect(tabForRoute({ name: "run", runId: "r", segment: "activity" })).toBe("runs");
    expect(tabForRoute({ name: "chat", chatId: "c" })).toBe("chats");
    expect(tabForRoute({ name: "new-run" })).toBe("home");
    expect(tabForRoute({ name: "project", projectId: "p", tab: "overview" })).toBe("more");
    expect(tabForRoute({ name: "settings" })).toBe("more");
  });
});

describe("applyTabSwitch", () => {
  it("resets the stack to the tab root", () => {
    const stack: MobileRoute[] = [{ name: "runs" }, { name: "run", runId: "r", segment: "activity" }];
    expect(applyTabSwitch(stack, "runs")).toEqual([{ name: "runs" }]);
    expect(applyTabSwitch(stack, "chats")).toEqual([{ name: "chats" }]);
  });

  it("is a no-op when the tab root is already the only entry", () => {
    const stack: MobileRoute[] = [{ name: "home" }];
    expect(applyTabSwitch(stack, "home")).toBe(stack);
  });
});

describe("routesEqual", () => {
  it("compares by serialised identity", () => {
    expect(routesEqual({ name: "run", runId: "r", segment: "diff" }, { name: "run", runId: "r", segment: "diff" })).toBe(true);
    expect(routesEqual({ name: "run", runId: "r", segment: "diff" }, { name: "run", runId: "r", segment: "files" })).toBe(false);
  });
});
