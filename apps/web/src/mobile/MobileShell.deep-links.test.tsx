/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppSnapshot, RunDetail } from "@buildwarden/shared";
import { BuildWardenClientProvider, InstanceContextProvider, scopedId, type BuildWardenClient, type InstanceContextValue } from "@buildwarden/renderer";
import { MobileShell } from "./MobileShell";
import type { MobileRoute } from "./nav/mobile-router";

const RUN_ID = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const PROJECT_ID = "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d";

const replace = vi.fn();
const push = vi.fn();
let route: MobileRoute;

let snapshotState: { snapshot: AppSnapshot; loaded: boolean; error: string | null };
vi.mock("./data/use-snapshot", () => ({ useSnapshot: () => ({ ...snapshotState, refresh: vi.fn() }) }));
vi.mock("./data/use-approval-queue", () => ({ useApprovalQueue: () => ({ pending: [] }) }));
vi.mock("./nav/mobile-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./nav/mobile-router")>()),
  useMobileRouter: () => ({ route, activeTab: "runs", back: vi.fn(), selectTab: vi.fn(), replace, push }),
}));
vi.mock("@buildwarden/renderer/design-scheme", () => ({ applyDesignSchemeToDocument: vi.fn() }));
vi.mock("./screens/RunDetailScreen", () => ({ RunDetailScreen: ({ runId }: { runId: string }) => <p data-run={runId}>run screen</p> }));
vi.mock("./screens/ChatDetailScreen", () => ({ ChatDetailScreen: () => null }));

const snapshot = {
  projects: [], providerAccounts: [], models: [], settings: {}, chats: [], bookmarks: [], chatBookmarks: [],
  selectedProjectId: null, selectedRunId: null, selectedChatId: null,
} as unknown as AppSnapshot;

const projectSnapshot = {
  ...snapshot,
  projects: [{ project: { id: scopedId("a", PROJECT_ID) }, activeRuns: [], runs: [], recentRuns: [], forLaterRuns: [] }],
} as unknown as AppSnapshot;

let root: Root;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); replace.mockClear(); push.mockClear(); });

const mount = async (
  next: MobileRoute,
  getRunDetail: (id: string) => Promise<RunDetail>,
  initialSnapshot: typeof snapshotState = { snapshot, loaded: true, error: null },
) => {
  route = next;
  snapshotState = initialSnapshot;
  const client = { capabilities: { runMutations: true }, selectProject: vi.fn(async () => {}) } as unknown as BuildWardenClient;
  const context: InstanceContextValue = {
    activeInstanceId: "a",
    instances: [{ id: "a", name: "a", label: "a", status: "online", readOnly: false }],
    selectInstance: vi.fn(), manageInstances: vi.fn(), addProject: vi.fn(), clientForEntity: () => client,
    deepLinkLookups: () => [{ client: { getRunDetail, getChatDetail: vi.fn(async () => { throw new Error("missing"); }) }, scope: (id) => scopedId("a", id) }],
  };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const render = () => act(async () => root.render(<InstanceContextProvider value={context}>
    <BuildWardenClientProvider client={client}><MobileShell client={client} disconnect={async () => {}} /></BuildWardenClientProvider>
  </InstanceContextProvider>));
  await render();
  return { rerender: async (nextSnapshot: typeof snapshotState) => { snapshotState = nextSnapshot; await render(); } };
};

describe("mobile deep links", () => {
  it("swaps a shared link's host-local ID for the owning instance's scoped ID", async () => {
    const getRunDetail = vi.fn(async (id: string) => ({ run: { id, projectId: PROJECT_ID } }) as unknown as RunDetail);
    await mount({ name: "run", runId: RUN_ID, segment: "diff" }, getRunDetail);
    expect(getRunDetail).toHaveBeenCalledWith(RUN_ID);
    expect(replace).toHaveBeenCalledWith({ name: "run", runId: scopedId("a", RUN_ID), segment: "diff" });
    expect(container.querySelector("[data-run]")).toBeNull();
  });

  it("explains a link no connected instance knows", async () => {
    await mount({ name: "run", runId: RUN_ID, segment: "activity" }, vi.fn(async () => { throw new Error("Run not found."); }));
    expect(replace).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Link unavailable");
  });

  it("waits for a snapshot before deciding a project link is unavailable", async () => {
    const { rerender } = await mount({ name: "project", projectId: PROJECT_ID, tab: "overview" }, vi.fn(), { snapshot, loaded: false, error: null });
    expect(container.textContent).not.toContain("Link unavailable");
    await rerender({ snapshot, loaded: true, error: "Could not reach the BuildWarden host." });
    expect(container.textContent).not.toContain("Link unavailable");
    await rerender({ snapshot: projectSnapshot, loaded: true, error: null });
    expect(replace).toHaveBeenCalledWith({ name: "project", projectId: scopedId("a", PROJECT_ID), tab: "overview" });
  });

  it("resolves run links through the hosts even when the snapshot failed to load", async () => {
    const getRunDetail = vi.fn(async (id: string) => ({ run: { id, projectId: PROJECT_ID } }) as unknown as RunDetail);
    await mount({ name: "run", runId: RUN_ID, segment: "activity" }, getRunDetail, { snapshot, loaded: true, error: "Could not reach the BuildWarden host." });
    expect(replace).toHaveBeenCalledWith({ name: "run", runId: scopedId("a", RUN_ID), segment: "activity" });
  });

  it("shows scoped routes directly", async () => {
    const getRunDetail = vi.fn();
    await mount({ name: "run", runId: scopedId("a", RUN_ID), segment: "activity" }, getRunDetail);
    expect(getRunDetail).not.toHaveBeenCalled();
    expect(container.querySelector("[data-run]")?.getAttribute("data-run")).toBe(scopedId("a", RUN_ID));
  });
});
