/** @vitest-environment happy-dom */
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopApi } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { startRunBatch, type RunComposerSubmission } from "../../lib/run-batch";
import { ProjectOverviewTab } from "./ProjectOverviewTab";
import type { RunComposer } from "./RunComposer";

vi.mock("./RunComposer", () => ({
  RunComposer: (props: ComponentProps<typeof RunComposer>) => <>
    {props.attachments}
    <textarea value={props.prompt} onChange={(event) => props.onPromptChange(event.target.value)} />
    <button disabled={props.submitDisabled} onClick={props.onSubmit}>Start</button>
  </>,
}));
vi.mock("./RunHistory", () => ({ RunHistory: () => null }));

let root: Root;
let container: HTMLDivElement;
afterEach(async () => { await act(() => root.unmount()); container.remove(); });

it.each([false, true])("retries a partial launch after remount (changed prompt: %s)", async (changedPrompt) => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = { ...createElectronBuildWardenClient({} as DesktopApi), draftScopeId: crypto.randomUUID() };
  let fail = true;
  const createRun = vi.fn(async (modelId: string) => {
    if (modelId === "b" && fail) throw new Error("Provider offline");
    return `run-${modelId}`;
  });
  const onSubmitRun = async (payload: RunComposerSubmission) => { await startRunBatch(["a", "b"], createRun, payload.batch); };
  const props: ComponentProps<typeof ProjectOverviewTab> = {
    projectId: "project", projectName: "Project", repoPath: "/repo", projectKind: "git", runs: [], orchestratedRuns: [],
    modelOptions: [], configuredIdeKinds: [], availableBranches: ["main"], currentProjectBranch: "main",
    runMode: "code", runWorkspaceType: "worktree", runBaseBranch: "main", runModelId: "a", runWorktreeModelIds: ["a", "b"],
    submitShortcut: "ctrl+enter", projectRunStats: { total: 0, active: 0, completed: 0, failed: 0, cancelled: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    busy: false, reasoningEffort: "auto", anthropicEffort: "auto", yoloMode: false, delegationEnabled: false, delegationAvailable: false,
    onSubmitRun, onSetRunForLater: vi.fn(), onSelectRun: vi.fn(), onRunModeChange: vi.fn(), onRunWorkspaceTypeChange: vi.fn(),
    onRunBaseBranchChange: vi.fn(), onRunModelChange: vi.fn(), onRunWorktreeModelIdsChange: vi.fn(),
    onReasoningEffortChange: vi.fn(), onAnthropicEffortChange: vi.fn(), onYoloModeChange: vi.fn(), onDelegationEnabledChange: vi.fn(),
  };
  const render = () => root.render(<BuildWardenClientProvider client={client}><ProjectOverviewTab {...props} /></BuildWardenClientProvider>);
  const edit = (value: string) => {
    const textarea = container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const submit = () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Start")!.click();
  await act(render);
  await act(() => edit("Build this"));
  await act(submit);
  expect(createRun.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  expect(container.querySelector("textarea")?.value).toBe("Build this");
  expect(container.textContent).toContain("Retry will start only the remaining models");
  await act(() => root.render(null));
  await act(render);
  if (changedPrompt) await act(() => edit("Build something else"));
  fail = false;
  await act(submit);
  expect(createRun.mock.calls.map(([id]) => id)).toEqual(changedPrompt ? ["a", "b", "a", "b"] : ["a", "b", "b"]);
  expect(container.querySelector("textarea")?.value).toBe("");
});
