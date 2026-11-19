import { describe, expect, it } from "vitest";
import { scopedId } from "@buildwarden/renderer";
import { pendingRouteLink, routeForDeepLinkTarget } from "./deep-link-routes";
import { parseRoute } from "./mobile-router";

const RUN_ID = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const isScoped = (id: string) => id.startsWith("bw-instance:");

describe("pendingRouteLink", () => {
  it("resolves shared run links and keeps the requested panel", () => {
    const route = parseRoute(`#/run/${RUN_ID}/diff`)!;
    const pending = pendingRouteLink(route, isScoped)!;
    expect(pending.target).toEqual({ kind: "run", runId: RUN_ID, segment: "diff" });
    const scopedRun = scopedId("a", RUN_ID);
    expect(pending.toRoute({ kind: "run", runId: scopedRun, projectId: scopedId("a", "p") })).toEqual({ name: "run", runId: scopedRun, segment: "diff" });
    expect(pending.toRoute({ kind: "chat", chatId: scopedRun })).toBeNull();
  });

  it("keeps a project link's tab", () => {
    const pending = pendingRouteLink({ name: "project", projectId: RUN_ID, tab: "tasks" }, isScoped)!;
    expect(pending.toRoute({ kind: "project", projectId: scopedId("a", RUN_ID) })).toEqual({ name: "project", projectId: scopedId("a", RUN_ID), tab: "tasks" });
  });

  it("leaves routes that already use scoped IDs or carry no entity alone", () => {
    expect(pendingRouteLink({ name: "run", runId: scopedId("a", RUN_ID), segment: "activity" }, isScoped)).toBeNull();
    expect(pendingRouteLink({ name: "chat", chatId: scopedId("a", RUN_ID) }, isScoped)).toBeNull();
    expect(pendingRouteLink({ name: "runs" }, isScoped)).toBeNull();
    expect(pendingRouteLink({ name: "new-run", projectId: RUN_ID }, isScoped)).toBeNull();
  });
});

describe("routeForDeepLinkTarget", () => {
  it("opens runs on their activity unless a panel is named", () => {
    expect(routeForDeepLinkTarget({ kind: "run", runId: RUN_ID })).toEqual({ name: "run", runId: RUN_ID, segment: "activity" });
    expect(routeForDeepLinkTarget({ kind: "run", runId: RUN_ID, segment: "files" })).toEqual({ name: "run", runId: RUN_ID, segment: "files" });
    expect(routeForDeepLinkTarget({ kind: "chat", chatId: RUN_ID })).toEqual({ name: "chat", chatId: RUN_ID });
    expect(routeForDeepLinkTarget({ kind: "project", projectId: RUN_ID })).toEqual({ name: "project", projectId: RUN_ID, tab: "overview" });
  });
});
