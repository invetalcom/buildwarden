/** @vitest-environment happy-dom */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "@buildwarden/shared";
import { InstanceContextProvider, parseScopedId, scopedId, type BuildWardenClient } from "@buildwarden/renderer";
import { MobileShell } from "./MobileShell";
import type { MobileRoute } from "./nav/mobile-router";

vi.mock("./data/use-snapshot", () => ({ useSnapshot: () => ({ snapshot, loaded: true, refresh: vi.fn() }) }));
vi.mock("./data/use-approval-queue", () => ({ useApprovalQueue: () => ({ pending: [] }) }));
vi.mock("./nav/mobile-router", () => ({ useMobileRouter: () => ({ route, activeTab: "home", back: vi.fn(), selectTab: vi.fn() }) }));
vi.mock("@buildwarden/renderer/design-scheme", () => ({ applyDesignSchemeToDocument: vi.fn() }));
vi.mock("./screens/ProjectScreen", () => ({ ProjectScreen: () => null }));
vi.mock("./screens/RunDetailScreen", () => ({ RunDetailScreen: () => null }));
vi.mock("./screens/ChatDetailScreen", () => ({ ChatDetailScreen: () => null }));

const snapshot = {
  projects: ["a", "b"].map((id) => ({
    project: { id: scopedId(id, "project"), name: `Project ${id}`, kind: "folder", baseBranch: "", repoPath: `/repo/${id}` },
    runs: [], activeRuns: [], recentRuns: [], forLaterRuns: [], orchestratedRuns: [], tasks: [], insights: [], labThreads: [], loops: [],
  })),
  providerAccounts: ["a", "b"].map((id) => ({ id: scopedId(id, "provider"), providerType: "ai-sdk", label: "Provider", configJson: "{}" })),
  models: ["a", "b"].map((id) => ({ id: scopedId(id, "model"), providerAccountId: scopedId(id, "provider"), modelId: "gpt-5", displayName: "Model", configJson: "{}", capabilitiesJson: "{}", enabled: 1 })),
  settings: {}, chats: [], bookmarks: [], chatBookmarks: [], selectedProjectId: null, selectedRunId: null, selectedChatId: null,
} as unknown as AppSnapshot;
let route: MobileRoute;
let root: Root;
let container: HTMLDivElement;
const selections = vi.fn();
const Harness = () => {
  const [active, setActive] = useState("a");
  const selectInstance = (id: string) => {
    selections(id);
    if (selections.mock.calls.length > 10) throw new Error("Instance selection is oscillating");
    setActive(id);
  };
  const [clients] = useState(() => Object.fromEntries(["a", "b"].map((id) => [id, {
    capabilities: { runMutations: true },
    selectProject: async (projectId: string) => selectInstance(parseScopedId(projectId)!.instanceId),
  } as unknown as BuildWardenClient])));
  return <InstanceContextProvider value={{
    activeInstanceId: active, instances: ["a", "b"].map((id) => ({ id, name: id, label: id, status: "online", readOnly: false })),
    selectInstance, manageInstances: vi.fn(), addProject: vi.fn(), clientForEntity: (id) => clients[parseScopedId(id)!.instanceId],
  }}>
    <output data-testid="active-instance">{active}</output>
    <MobileShell client={clients[active]} disconnect={async () => {}} />
  </InstanceContextProvider>;
};
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); });
const mount = async (next: MobileRoute) => {
  route = next; selections.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
};

describe("mobile instance selection", () => {
  it("lets the New Run project switch instances while the original route stays unchanged", async () => {
    await mount({ name: "new-run", projectId: scopedId("b", "project") });
    expect(container.querySelector("output")?.textContent).toBe("b");
    selections.mockClear();
    const project = container.querySelector<HTMLSelectElement>("select")!;
    expect(project.value).toBe(scopedId("b", "project"));
    await act(async () => {
      project.value = scopedId("a", "project");
      project.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(route).toEqual({ name: "new-run", projectId: scopedId("b", "project") });
    expect(container.querySelector("output")?.textContent).toBe("a");
    expect(project.value).toBe(scopedId("a", "project"));
    expect(selections.mock.calls.every(([id]) => id === "a")).toBe(true);
  });

  it.each<MobileRoute>([
    { name: "project", projectId: scopedId("b", "project"), tab: "overview" },
    { name: "run", runId: scopedId("b", "run"), segment: "activity" },
    { name: "chat", chatId: scopedId("b", "chat") },
  ])("still follows the instance of a $name detail route", async (next) => {
    await mount(next);
    expect(container.querySelector("output")?.textContent).toBe("b");
    expect(selections).toHaveBeenCalledExactlyOnceWith("b");
  });
});
