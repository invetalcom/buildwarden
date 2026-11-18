import { describe, expect, it, vi } from "vitest";
import type { AppSnapshot, ChatDetail, RunDetail } from "@buildwarden/shared";
import { DEEP_LINK_LOOKUP_TIMEOUT_MS, deepLinkTargetFor, deepLinkTargetFromHref, rawEntityId, resolveDeepLink, shareableDeepLink, type DeepLinkLookup } from "./deep-links";
import { scopedId } from "./instance-identity";

const RUN_ID = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const CHAT_ID = "0b1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e";
const PROJECT_ID = "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d";

type Snapshot = Pick<AppSnapshot, "projects" | "chats">;
const emptySnapshot: Snapshot = { projects: [], chats: [] };

const snapshotWithRun = (runId: string, projectId: string): Snapshot => ({
  chats: [],
  projects: [{
    project: { id: projectId },
    runs: [{ id: runId, projectId }],
    activeRuns: [],
    recentRuns: [],
    forLaterRuns: [],
    orchestratedRuns: [],
  }] as unknown as AppSnapshot["projects"],
});

const lookup = (overrides: Partial<DeepLinkLookup["client"]>, scope: (id: string) => string = (id) => id): DeepLinkLookup => ({
  client: {
    getRunDetail: vi.fn(async () => { throw new Error("Run not found."); }),
    getChatDetail: vi.fn(async () => { throw new Error("Chat not found."); }),
    ...overrides,
  },
  scope,
});

describe("resolveDeepLink", () => {
  it("answers from the snapshot without asking a host", async () => {
    const host = lookup({});
    const resolved = await resolveDeepLink({ kind: "run", runId: RUN_ID, segment: "diff" }, { snapshot: snapshotWithRun(RUN_ID, PROJECT_ID), lookups: [host] });
    expect(resolved).toEqual({ kind: "run", runId: RUN_ID, projectId: PROJECT_ID, segment: "diff" });
    expect(host.client.getRunDetail).not.toHaveBeenCalled();
  });

  it("matches host-local IDs against instance-scoped snapshot IDs", async () => {
    const scopedRun = scopedId("cookie:https://host", RUN_ID);
    const scopedProject = scopedId("cookie:https://host", PROJECT_ID);
    const resolved = await resolveDeepLink({ kind: "run", runId: RUN_ID }, { snapshot: snapshotWithRun(scopedRun, scopedProject), lookups: [] });
    expect(resolved).toEqual({ kind: "run", runId: scopedRun, projectId: scopedProject });
  });

  it("asks every host and scopes the first match", async () => {
    const missing = lookup({});
    const owner = lookup({
      getRunDetail: vi.fn(async () => ({ run: { id: RUN_ID, projectId: PROJECT_ID } }) as unknown as RunDetail),
    }, (id) => scopedId("second", id));
    const resolved = await resolveDeepLink({ kind: "run", runId: RUN_ID }, { snapshot: emptySnapshot, lookups: [missing, owner] });
    expect(resolved).toEqual({ kind: "run", runId: scopedId("second", RUN_ID), projectId: scopedId("second", PROJECT_ID) });
  });

  it("resolves chats through the host when the snapshot lacks them", async () => {
    const host = lookup({ getChatDetail: vi.fn(async () => ({ chat: { id: CHAT_ID }, steps: [] }) as unknown as ChatDetail) });
    expect(await resolveDeepLink({ kind: "chat", chatId: CHAT_ID }, { snapshot: emptySnapshot, lookups: [host] })).toEqual({ kind: "chat", chatId: CHAT_ID });
  });

  it("returns null when nothing knows the ID", async () => {
    expect(await resolveDeepLink({ kind: "run", runId: RUN_ID }, { snapshot: emptySnapshot, lookups: [lookup({})] })).toBeNull();
    expect(await resolveDeepLink({ kind: "chat", chatId: CHAT_ID }, { snapshot: emptySnapshot, lookups: [] })).toBeNull();
    expect(await resolveDeepLink({ kind: "project", projectId: PROJECT_ID }, { snapshot: emptySnapshot, lookups: [lookup({})] })).toBeNull();
  });

  it("stops waiting for a host that never answers", async () => {
    vi.useFakeTimers();
    try {
      const silent = lookup({ getRunDetail: vi.fn(() => new Promise<RunDetail>(() => {})) });
      const pending = resolveDeepLink({ kind: "run", runId: RUN_ID }, { snapshot: emptySnapshot, lookups: [lookup({}), silent] });
      await vi.advanceTimersByTimeAsync(DEEP_LINK_LOOKUP_TIMEOUT_MS);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("link building", () => {
  it("shares host-local IDs even when the UI uses scoped IDs", () => {
    const scoped = scopedId("cookie:https://host", RUN_ID);
    expect(rawEntityId(scoped)).toBe(RUN_ID);
    expect(deepLinkTargetFor("run", scoped)).toEqual({ kind: "run", runId: RUN_ID });
    expect(shareableDeepLink(deepLinkTargetFor("run", scoped), "web", "https://host:7777/?ui=mobile#/runs"))
      .toBe(`https://host:7777/?ui=mobile#/run/${RUN_ID}`);
  });

  it("uses the app scheme on the desktop", () => {
    expect(shareableDeepLink({ kind: "chat", chatId: CHAT_ID }, "electron")).toMatch(new RegExp(`^buildwarden(-dev)?://chat/${CHAT_ID}$`));
  });
});

describe("deepLinkTargetFromHref", () => {
  it("recognizes app links, in-page routes, and full links to this page", () => {
    expect(deepLinkTargetFromHref(`buildwarden://run/${RUN_ID}`)).toEqual({ kind: "run", runId: RUN_ID });
    expect(deepLinkTargetFromHref(`buildwarden-dev://chat/${CHAT_ID}`)).toEqual({ kind: "chat", chatId: CHAT_ID });
    expect(deepLinkTargetFromHref(`#/run/${RUN_ID}/diff`)).toEqual({ kind: "run", runId: RUN_ID, segment: "diff" });
    expect(deepLinkTargetFromHref(`https://host:7777/#/chat/${CHAT_ID}`, "https://host:7777")).toEqual({ kind: "chat", chatId: CHAT_ID });
  });

  it("leaves other links alone", () => {
    expect(deepLinkTargetFromHref(`https://elsewhere.example/#/chat/${CHAT_ID}`, "https://host:7777")).toBeNull();
    expect(deepLinkTargetFromHref("https://host:7777/docs", "https://host:7777")).toBeNull();
    expect(deepLinkTargetFromHref("#buildwarden-response-step-1")).toBeNull();
    expect(deepLinkTargetFromHref("src/index.ts")).toBeNull();
    expect(deepLinkTargetFromHref(undefined)).toBeNull();
  });
});
