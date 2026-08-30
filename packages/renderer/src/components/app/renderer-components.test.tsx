import { createRef, type ComponentProps } from "react";
import { renderWithBuildWardenClient as renderToStaticMarkup } from "../../lib/buildwarden-client-test-utils";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  getModelPresetsByGroupForProvider,
  isTextLikeFileName,
  type AppSnapshot,
  type DesktopApi,
  type ModelRecord,
  type ProviderAccountRecord,
  type ProviderType,
  type RunRecord,
  type RunDetail,
  type ProjectSnapshot,
} from "@buildwarden/shared";
import { AllRunsPage } from "./AllRunsPage";
import { AgentRunHoverCard } from "./AgentRunHoverCard";
import { BookmarksPage } from "./BookmarksPage";
import { ChatPage } from "./ChatPage";
import { ContextWindowBadge } from "./ContextWindowBadge";
import { ProjectForLaterTab } from "./ProjectForLaterTab";
import { ProjectGraphsTab } from "./ProjectGraphsTab";
import { ProjectOverviewTab } from "./ProjectOverviewTab";
import { ProjectTasksTab } from "./ProjectTasksTab";
import { ProjectBranchesPage } from "./ProjectBranchesPage";
import { ProjectLabTab } from "./ProjectLabTab";
import { ProjectPrMrTab } from "./ProjectPrMrTab";
import { ProjectSettingsPage } from "./ProjectSettingsPage";
import { ProviderModelPanelButtons, ProviderModelsOverview } from "./provider-models-overview";
import { RunEmbeddedBrowser } from "./RunEmbeddedBrowser";
import { RunComposer } from "./RunComposer";
import { intersectModelExecutionControls, nextModelChipSection } from "./model-execution-controls";
import { RunDetailHeader } from "./RunDetailHeader";
import { RunPlanProgressPill } from "./RunPlanProgressPill";
import { RunPlanSteps } from "./RunPlanSteps";
import { RunTokenBadge } from "./RunTokenBadge";
import { Sidebar } from "./Sidebar";
import { ProviderModelsSettingsTab, type ProviderModelsSettingsTabProps } from "./settings-provider-models-tab";

beforeAll(() => {
  const buildwarden = new Proxy({} as DesktopApi, {
    get: () => vi.fn(() => Promise.resolve([])),
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      buildwarden,
      localStorage: { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() },
    },
  });
});

const providerAccount = (providerType: ProviderType = "ai-sdk"): ProviderAccountRecord => ({
  id: `provider-${providerType}`,
  providerType,
  label: `${providerType} account`,
  apiBaseUrl: null,
  apiKeyRef: "secret-ref",
  configJson: "{}",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const modelRecord = (account = providerAccount()): ModelRecord => ({
  id: "model-1",
  providerAccountId: account.id,
  modelId: "gpt-5",
  displayName: "GPT-5",
  baseUrlOverride: null,
  configJson: "{}",
  capabilitiesJson: "{}",
  enabled: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const remoteRunCapabilities = {
  platform: "web" as const,
  nativeTitleBar: false,
  nativeAppMenu: false,
  directoryPicker: false,
  ideIntegration: false,
  fileManager: false,
  systemTerminal: false,
  embeddedTerminal: false,
  settings: false,
  mutations: true,
  runMutations: true,
  chatMutations: false,
  bookmarkMutations: false,
  runListVisibilityMutations: false,
  taskMutations: false,
  automationMutations: false,
  insightMutations: false,
  projectLabMutations: false,
  projectLoopMutations: false,
  prReview: false,
  projectSettingsMutations: false,
  approvalResponses: false,
  gitMutations: true,
  projectCreation: false,
  hostDirectoryBrowser: false,
  orchestrationRead: true,
  orchestrationOperate: true,
  orchestrationAdoption: true,
  orchestrationSettings: false,
  liveEvents: true,
};

const remoteControlCapabilities = {
  ...remoteRunCapabilities,
  settings: true,
  chatMutations: true,
  bookmarkMutations: true,
  runListVisibilityMutations: true,
  taskMutations: true,
  automationMutations: true,
  insightMutations: true,
  projectLabMutations: true,
  projectLoopMutations: true,
  prReview: true,
  projectSettingsMutations: true,
  projectCreation: true,
  hostDirectoryBrowser: true,
};

const runRecord = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: "run-1",
  projectId: "project-1",
  providerAccountId: "provider-ai-sdk",
  modelId: "model-1",
  harnessType: "ai-sdk",
  mode: "code",
  workspaceType: "worktree",
  workspaceVcs: "git",
  prompt: "Improve renderer coverage",
  goalText: null,
  status: "completed",
  branchName: "feat/coverage",
  worktreePath: "C:/repo/worktree",
  summary: null,
  errorMessage: null,
  lastProviderResponseId: null,
  inputTokens: 1200,
  outputTokens: 300,
  listVisibility: "default",
  kind: "standard",
  labThreadId: null,
  parentRunId: null,
  rootRunId: null,
  projectTaskId: null,
  delegationEnabled: false,
  lineageTitle: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:05:00.000Z",
  startedAt: "2026-01-01T00:00:10.000Z",
  finishedAt: "2026-01-01T00:04:00.000Z",
  ...overrides,
});

const providerSettingsProps = (providerType: ProviderType): ProviderModelsSettingsTabProps => {
  const account = providerAccount(providerType);
  return {
    busy: false,
    providerLabel: account.label,
    providerType,
    providerFamily: providerType === "ai-sdk" ? "openai" : "openai-compatible",
    apiKey: "test-key",
    codexBinaryPath: "",
    codexHomePath: "",
    detectedCodexBinaryPath: "C:/tools/codex.exe",
    claudeBinaryPath: "",
    claudeLaunchArgs: "",
    detectedClaudeBinaryPath: "C:/tools/claude.exe",
    cursorBinaryPath: "",
    cursorApiEndpoint: "",
    detectedCursorBinaryPath: "C:/tools/agent.exe",
    detectedCursorMessage: null,
    providerBaseUrl: "https://example.test/v1",
    providerConfigJson: "{}",
    providerAzureApiVersion: "2024-06-01",
    selectedProviderId: account.id,
    modelId: "gpt-5",
    modelDisplayName: "GPT-5",
    modelBaseUrl: "",
    providerAccounts: [account],
    models: [modelRecord(account)],
    openAiPresetUserChoseCustom: false,
    openAiPresetsGrouped: getModelPresetsByGroupForProvider(providerType, providerType === "ai-sdk" ? "openai" : undefined),
    onSubmitProvider: vi.fn(),
    onSubmitModel: vi.fn(),
    onEnsureAvailableModels: vi.fn(),
    onDeleteProviderAccount: vi.fn(),
    onDeleteModel: vi.fn(),
    onProviderLabelChange: vi.fn(),
    onProviderTypeChange: vi.fn(),
    onProviderFamilyChange: vi.fn(),
    onApiKeyChange: vi.fn(),
    onCodexBinaryPathChange: vi.fn(),
    onCodexHomePathChange: vi.fn(),
    onClaudeBinaryPathChange: vi.fn(),
    onClaudeLaunchArgsChange: vi.fn(),
    onCursorBinaryPathChange: vi.fn(),
    onCursorApiEndpointChange: vi.fn(),
    onProviderBaseUrlChange: vi.fn(),
    onProviderConfigJsonChange: vi.fn(),
    onProviderAzureApiVersionChange: vi.fn(),
    onSelectedProviderIdChange: vi.fn(),
    onModelIdChange: vi.fn(),
    onModelDisplayNameChange: vi.fn(),
    onModelBaseUrlChange: vi.fn(),
    onSetOpenAiPresetUserChoseCustom: vi.fn(),
  };
};

describe("renderer component states", () => {
  it("classifies text-like file names without a complex regular expression", () => {
    expect(isTextLikeFileName("src/App.TSX")).toBe(true);
    expect(isTextLikeFileName("C:\\repo\\.env")).toBe(true);
    expect(isTextLikeFileName("assets/icon.png")).toBe(false);
    expect(isTextLikeFileName("README")).toBe(false);
  });

  it("renders empty and populated all-runs states", () => {
    expect(renderToStaticMarkup(<AllRunsPage projects={[]} onSelectRun={vi.fn()} />)).toContain("No agent runs yet");
    const run = runRecord();
    const projectEntry = {
      project: {
        id: "project-1",
        name: "BuildWarden",
        repoPath: "C:/repo",
        baseBranch: "main",
        kind: "git",
        cumulativeInputTokens: 0,
        cumulativeOutputTokens: 0,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        lastOpenedAt: run.updatedAt,
      },
      runs: [run],
      forLaterRuns: [],
      orchestratedRuns: [],
      activeRuns: [],
      recentRuns: [run],
      tasks: [],
      insights: [],
      labThreads: [],
      loops: [],
    } as AppSnapshot["projects"][number];
    const markup = renderToStaticMarkup(<AllRunsPage projects={[projectEntry]} onSelectRun={vi.fn()} />);
    expect(markup).toContain("Improve renderer coverage");
    expect(markup).toContain("feat/coverage");
    expect(markup).toContain(">Done</span>");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-pressed="false"');
    // Which agent produced the run, next to the project it ran in.
    expect(markup).toContain("<title>AI SDK</title>");
    const claudeMarkup = renderToStaticMarkup(
      <AllRunsPage projects={[{ ...projectEntry, runs: [runRecord({ harnessType: "claude-code" })] }]} onSelectRun={vi.fn()} />,
    );
    expect(claudeMarkup).toContain("<title>Claude Code</title>");
    const openRouterAccount = providerAccount("openrouter");
    const openRouterMarkup = renderToStaticMarkup(
      <AllRunsPage
        projects={[{
          ...projectEntry,
          runs: [runRecord({ providerAccountId: openRouterAccount.id, harnessType: "ai-sdk" })],
        }]}
        providerAccounts={[openRouterAccount]}
        onSelectRun={vi.fn()}
      />,
    );
    expect(openRouterMarkup).toContain("<title>OpenRouter</title>");
  });

  it("renders the shared agent run hover card with expanded run context", () => {
    const markup = renderToStaticMarkup(
      <AgentRunHoverCard
        projectName="BuildWarden"
        run={runRecord({
          prompt: "Inspect the complete sidebar prompt and preserve the compact navigation layout.",
          branchName: "feat/run-hover-card",
          harnessType: "codex-app-server",
        })}
      />,
    );

    expect(markup).toContain("data-agent-run-hover-card");
    expect(markup).toContain("Inspect the complete sidebar prompt");
    expect(markup).toContain("BuildWarden");
    expect(markup).toContain("feat/run-hover-card");
    expect(markup).toContain("Codex CLI");
    expect(markup).toContain("line-clamp-6");
    expect(markup).toContain("var(--ec-text)");
    expect(markup).not.toContain("data-agent-run-forge-request");

    const pullRequestMarkup = renderToStaticMarkup(
      <AgentRunHoverCard
        projectName="BuildWarden"
        run={runRecord({
          forgeRequest: {
            provider: "github",
            number: 42,
            title: "Show pull request context in the sidebar hover card",
            url: "https://github.com/example/buildwarden/pull/42",
            state: "open",
            readiness: "pending",
            draft: false,
            mergeability: "checking",
            reviewDecision: "review-required",
            author: "octocat",
            sourceBranch: "feat/run-hover-card",
            targetBranch: "main",
            headSha: "abcdef1234567890",
            checks: { completed: 4, total: 7, successful: 4, failed: 0, running: 3 },
            unresolvedThreadCount: 0,
            supportedActions: [],
            supportedMergeMethods: [],
            updatedAt: "2026-01-01T00:04:00.000Z",
            lastSyncedAt: "2026-01-01T00:05:00.000Z",
            stale: false,
            syncError: null,
          },
        })}
      />,
    );

    expect(pullRequestMarkup).toContain("data-agent-run-forge-request");
    expect(pullRequestMarkup).toContain("Pull request #42");
    expect(pullRequestMarkup).toContain("Show pull request context in the sidebar hover card");
    expect(pullRequestMarkup).toContain("Waiting");
    expect(pullRequestMarkup).toContain(">4 of 7</span> checks");
  });

  it("renders plan, token, and context summaries", () => {
    const planMarkup = renderToStaticMarkup(
      <RunPlanSteps content={"1. [x] Inspect\n2. [-] Refactor\n3. [ ] Verify"} />,
    );
    expect(planMarkup).toContain("Plan steps");
    expect(planMarkup).toContain("in progress");
    expect(planMarkup).toContain("--ec-accent-soft");
    expect(planMarkup).toContain("--ec-accent");
    expect(planMarkup).not.toContain("--ec-info");
    expect(
      renderToStaticMarkup(
        <RunPlanProgressPill
          progress={{
            stepId: "step-1",
            createdAt: "2026-01-01T00:00:00.000Z",
            fallback: false,
            explanation: "Quality plan",
            source: "codex",
            steps: [
              { title: "Inspect", status: "completed" },
              { title: "Refactor", status: "inProgress" },
              { title: "Verify", status: "pending" },
            ],
          }}
        />,
      ),
    ).toContain("Refactor");
    expect(
      renderToStaticMarkup(
        <RunTokenBadge
          inputTokens={1200}
          outputTokens={300}
          usage={{ usedTokens: 1500, maxTokens: 10_000, totalProcessedTokens: 1800 }}
        />,
      ),
    ).toContain("Token usage");
    expect(renderToStaticMarkup(<ContextWindowBadge modelIds={["gpt-5"]} prompt={"Review this change"} />)).toContain(
      "Estimated context window",
    );
  });

  it("renders folder and git runs saved for later", () => {
    const component = (
      <ProjectForLaterTab
        runs={[runRecord(), runRecord({ id: "run-2", workspaceVcs: "folder", workspaceType: "copy" })]}
        onSelectRun={vi.fn()}
        onRestoreRunFromForLater={vi.fn()}
      />
    );
    const markup = renderToStaticMarkup(component);
    expect(markup).toContain("feat/coverage");
    expect(markup).toContain("Folder copy");
    expect(markup).toContain("Reactivate");

    const remoteMarkup = renderToStaticMarkup(component, {} as DesktopApi, remoteRunCapabilities);
    expect(remoteMarkup).toContain("Improve renderer coverage");
    expect(remoteMarkup).not.toContain("Reactivate");
  });

  it("renders project overview and task states", () => {
    const modelOptions = [
      { id: "model-1", label: "GPT-5", modelId: "gpt-5", providerType: "ai-sdk" as const, providerFamily: "openai" as const },
    ];
    const overviewRun = runRecord({ orchestrationStatus: "deletion-failed" });
    const overviewSubagent = runRecord({
      id: "subagent-1",
      kind: "orchestration-task",
      parentRunId: overviewRun.id,
      rootRunId: overviewRun.id,
      lineageTitle: "Implement the run hierarchy",
      prompt: "Implement a reusable hierarchical run list across the renderer.",
    });
    const overviewMarkup = renderToStaticMarkup(
      <ProjectOverviewTab
        projectId="project-1"
        projectName="BuildWarden"
        repoPath="C:/repo"
        projectKind="git"
        runs={[overviewRun]}
        orchestratedRuns={[overviewSubagent]}
        modelOptions={modelOptions}
        configuredIdeKinds={[]}
        availableBranches={["main"]}
        currentProjectBranch="main"
        runPrompt="Improve quality"
        runMode="code"
        runWorkspaceType="worktree"
        runBaseBranch="main"
        runModelId="model-1"
        runWorktreeModelIds={["model-1"]}
        submitShortcut="ctrl+enter"
        projectRunStats={{ total: 1, active: 0, completed: 1, failed: 0, cancelled: 0, inputTokens: 1200, outputTokens: 300, totalTokens: 1500 }}
        busy={false}
        reasoningEffort="high"
        anthropicEffort="medium"
        yoloMode={false}
        delegationEnabled={false}
        delegationAvailable={true}
        onSubmitRun={vi.fn()}
        onSetRunForLater={vi.fn()}
        onSelectRun={vi.fn()}
        onRunPromptChange={vi.fn()}
        onRunModeChange={vi.fn()}
        onRunWorkspaceTypeChange={vi.fn()}
        onRunBaseBranchChange={vi.fn()}
        onRunModelChange={vi.fn()}
        onRunWorktreeModelIdsChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onAnthropicEffortChange={vi.fn()}
        onYoloModeChange={vi.fn()}
        onDelegationEnabledChange={vi.fn()}
      />,
    );
    expect(overviewMarkup).toContain("BuildWarden");
    expect(overviewMarkup).toContain("Improve renderer coverage");
    expect(overviewMarkup).toContain('data-run-hierarchy-toggle="run-1"');
    expect(overviewMarkup).toContain('aria-expanded="false"');
    expect(overviewMarkup).toContain("1 primary, 1 subagent run");
    expect(overviewMarkup).toContain("Cleanup failed");
    expect(overviewMarkup).not.toContain(">deletion-failed</span>");
    expect(overviewMarkup).not.toContain("Implement the run hierarchy");
    const orchestrationButton = overviewMarkup.match(/<button[^>]*aria-label="Orchestration"[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(orchestrationButton).toBeDefined();
    expect(orchestrationButton).toContain("lucide-workflow");
    expect(orchestrationButton).not.toContain(">Orchestration<");
    expect(overviewMarkup).not.toContain("Allow delegation");

    const taskMarkup = renderToStaticMarkup(
      <ProjectTasksTab
        projectId="project-1"
        tasks={[
          { id: "task-1", projectId: "project-1", title: "Raise quality", prompt: "Add tests", attachmentCount: 0, status: "open", runId: null, pullRequestUrl: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
          { id: "task-2", projectId: "project-1", title: "Improve runtime", prompt: "Reduce startup time", attachmentCount: 0, status: "in_progress", runId: "run-2", pullRequestUrl: null, createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
          { id: "task-3", projectId: "project-1", title: "Review output", prompt: "Check the generated patch", attachmentCount: 0, status: "in_review", runId: "run-3", pullRequestUrl: null, createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" },
          { id: "task-4", projectId: "project-1", title: "Ship release", prompt: "Complete the release", attachmentCount: 0, status: "done", runId: "run-4", pullRequestUrl: null, createdAt: "2026-01-04T00:00:00.000Z", updatedAt: "2026-01-04T00:00:00.000Z" },
        ]}
        modelOptions={modelOptions}
        defaultTaskModelId="model-1"
        busy={false}
        onCreateTask={vi.fn()}
        onUpdateTask={vi.fn()}
        onDeleteTask={vi.fn()}
        onStartTask={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
    expect(taskMarkup).toContain("Raise quality");
    expect(taskMarkup).toContain("Beta");
    expect(taskMarkup).toContain("View task");
    expect(taskMarkup).toContain("In Progress");
    expect(taskMarkup).toContain("In Review");
    expect(taskMarkup).toContain("Done");
    expect(taskMarkup.match(/Start run/g)).toHaveLength(1);
    expect(taskMarkup.match(/Open run/g)).toHaveLength(3);
    expect(taskMarkup.match(/Re-run task/g)).toHaveLength(3);
    expect(taskMarkup.match(/title="Edit task"/g)).toHaveLength(1);

    const remoteTaskMarkup = renderToStaticMarkup(
      <ProjectTasksTab
        projectId="project-1"
        tasks={[{ id: "task-1", projectId: "project-1", title: "Raise quality", prompt: "Add tests", attachmentCount: 0, status: "open", runId: null, pullRequestUrl: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }]}
        modelOptions={modelOptions}
        defaultTaskModelId="model-1"
        busy={false}
        onCreateTask={vi.fn()}
        onUpdateTask={vi.fn()}
        onDeleteTask={vi.fn()}
        onStartTask={vi.fn()}
        onOpenRun={vi.fn()}
      />,
      {} as DesktopApi,
      remoteRunCapabilities,
    );
    expect(remoteTaskMarkup).toContain("Raise quality");
    expect(remoteTaskMarkup).toContain("Start run");
    expect(remoteTaskMarkup).toContain("View task");
    expect(remoteTaskMarkup).not.toContain("Add task");
    expect(remoteTaskMarkup).not.toContain("Edit task");
    expect(remoteTaskMarkup).not.toContain("Delete task");
  });

  it("renders loading chat and bookmark pages", () => {
    const chatMarkup = renderToStaticMarkup(
      <ChatPage
        modelOptions={[{ id: "model-1", label: "GPT-5", modelId: "gpt-5", providerType: "ai-sdk", providerFamily: "openai" }]}
        defaultModelId="model-1"
        submitShortcut="ctrl+enter"
        onSelectChat={vi.fn()}
        onCreateChat={vi.fn()}
        reasoningEffort="medium"
        anthropicEffort="medium"
        onReasoningEffortChange={vi.fn()}
        onAnthropicEffortChange={vi.fn()}
        onDeleteChat={vi.fn()}
      />,
    );
    expect(chatMarkup).toContain("Loading chats");
    const bookmarksMarkup = renderToStaticMarkup(
      <BookmarksPage onSelectBookmark={vi.fn()} onRemoveRunBookmarkById={vi.fn()} onRemoveChatBookmarkById={vi.fn()} />,
    );
    expect(bookmarksMarkup).toContain("Loading bookmarks");
  });

  it("renders browser navigation state", () => {
    const markup = renderToStaticMarkup(
      <RunEmbeddedBrowser
        runId="run-1"
        session={{
          draftUrl: "localhost:5173",
          currentUrl: "https://example.test/",
          history: ["https://example.test/", "https://example.test/docs"],
          historyIndex: 1,
          reloadKey: 2,
        }}
        onSessionChange={vi.fn()}
      />,
    );
    expect(markup).toContain("Browser");
    expect(markup).toContain("Open in external browser");
    expect(markup).not.toContain("<iframe");
  });

  it("renders run and chat composer configurations", () => {
    const commonProps = {
      prompt: "Review the change",
      onPromptChange: vi.fn(),
      selectedMode: "code" as const,
      onModeChange: vi.fn(),
      selectedModelId: "model-1",
      modelOptions: [
        {
          value: "model-1",
          label: "GPT-5",
          providerType: "ai-sdk" as const,
          providerFamily: "openai" as const,
          executionProfile: {
            controls: [
              {
                id: "reasoningEffort" as const,
                label: "Effort",
                options: [{ value: "auto", label: "Provider default" }, { value: "high", label: "High" }],
              },
              {
                id: "speed" as const,
                label: "Speed",
                options: [{ value: "auto", label: "Provider default" }, { value: "fast", label: "Fast" }],
              },
            ],
          },
        },
        { value: "model-2", label: "Claude", providerType: "claude-code" as const, executionProfile: { controls: [] } },
      ],
      onModelChange: vi.fn(),
      selectedBranch: "main",
      branchOptions: [{ value: "main", label: "main" }],
      onBranchChange: vi.fn(),
      selectedWorkspaceType: "worktree" as const,
      onWorkspaceTypeChange: vi.fn(),
      busy: false,
      onSubmit: vi.fn(),
    };
    const runMarkup = renderToStaticMarkup(
      <RunComposer
        {...commonProps}
        modelSelectionMode="multi"
        selectedModelIds={["model-1", "model-2"]}
        onModelIdsChange={vi.fn()}
        modelConfigurations={{
          "model-1": { effort: "high", executionMode: "fast" },
          "model-2": { effort: "auto", executionMode: "auto" },
        }}
        onModelConfigurationsChange={vi.fn()}
        onYoloModeChange={vi.fn()}
        reasoningEffort="high"
        onReasoningEffortChange={vi.fn()}
      />,
    );
    const fullAccessButton = runMarkup.match(/<button[^>]*aria-label="Full access"[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(fullAccessButton).toBeDefined();
    expect(fullAccessButton).toContain("lucide-shield-off");
    expect(fullAccessButton).not.toContain(">Full access<");
    expect(runMarkup).toContain('aria-label="Configure 2 models, High, Fast"');
    expect(runMarkup).not.toContain('aria-label="Configure GPT-5"');
    expect(runMarkup).not.toContain('aria-label="Configure Claude"');
    expect(runMarkup).not.toContain('data-model-chip-rail="true"');
    expect(runMarkup).toContain('data-model-readout="multi"');
    expect(runMarkup).toContain('data-model-readout-meta="true"');
    expect(runMarkup).toContain("lucide-brain-circuit");
    expect(runMarkup).toContain("lucide-gauge");
    const multiModelReadout = runMarkup.match(/<button[^>]*data-model-readout="multi"[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(multiModelReadout).toBeDefined();
    expect(multiModelReadout).not.toContain("truncate");
    expect(runMarkup).toContain(">2 models<");
    expect(runMarkup).toContain(">High<");
    expect(runMarkup).toContain(">Fast<");
    const staleModelMarkup = renderToStaticMarkup(
      <RunComposer
        {...commonProps}
        modelSelectionMode="multi"
        selectedModelIds={["removed-model"]}
        onModelIdsChange={vi.fn()}
      />,
    );
    const staleModelTrigger = staleModelMarkup.match(/<button[^>]*aria-label="Configure Select model"[^>]*>/)?.[0];
    expect(staleModelTrigger).toBeDefined();
    expect(staleModelTrigger).not.toContain("disabled");
    const chatMarkup = renderToStaticMarkup(<RunComposer {...commonProps} variant="chat" submitLabel="Send chat" />);
    expect(chatMarkup).toContain("Send chat");
    expect(chatMarkup).toContain('aria-label="Configure GPT-5, Default effort, Default speed"');
    expect(chatMarkup).not.toContain('aria-label="Add model"');
    expect(chatMarkup).toContain('data-model-readout="single"');
    const singleModelReadout = chatMarkup.match(/<button[^>]*data-model-readout="single"[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(singleModelReadout).toBeDefined();
    expect(singleModelReadout).not.toContain("truncate");
  });

  it("keeps model configuration moving through the same menu after replacement", () => {
    expect(nextModelChipSection({
      controls: [{
        id: "reasoningEffort",
        label: "Effort",
        options: [{ value: "auto", label: "Provider default" }, { value: "high", label: "High" }],
      }],
    })).toBe("effort");
    expect(nextModelChipSection({
      controls: [{
        id: "speed",
        label: "Speed",
        options: [{ value: "auto", label: "Provider default" }, { value: "fast", label: "Fast" }],
      }],
    })).toBe("secondary");
    expect(nextModelChipSection({ controls: [] })).toBe("model");
  });

  it("intersects effort choices across every selected model", () => {
    const common = intersectModelExecutionControls([
      {
        id: "reasoningEffort",
        label: "Effort",
        options: [
          { value: "auto", label: "Provider default" },
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra high" },
        ],
      },
      {
        id: "reasoningEffort",
        label: "Effort",
        options: [
          { value: "auto", label: "Provider default" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
      },
    ]);
    expect(common?.options.map((option) => option.value)).toEqual(["auto", "high"]);
    expect(intersectModelExecutionControls([])).toBeUndefined();
  });

  it("renders completed run header controls", () => {
    const run = runRecord();
    const runDetail: RunDetail = { run, steps: [], notes: [], diff: "diff --git a/a.ts b/a.ts" };
    const markup = renderToStaticMarkup(
      <RunDetailHeader
        run={run}
        runDetail={runDetail}
        tokenUsage={{ totalProcessedTokens: 1500 }}
        busy={false}
        pendingDelete={false}
        configuredIdeKinds={[]}
        canContinueRun
        runTimelineDensity="comfortable"
        onRunTimelineDensityChange={vi.fn()}
        runDensityMenuOpen={false}
        setRunDensityMenuOpen={vi.fn()}
        runDensityMenuAnchorRef={createRef<HTMLDivElement>()}
        runPanelToggleItems={[]}
        runWorkspaceVisiblePanelCount={0}
        runPanelsMenuOpen={false}
        setRunPanelsMenuOpen={vi.fn()}
        runPanelsMenuAnchorRef={createRef<HTMLDivElement>()}
        publishMenuOpen={false}
        setPublishMenuOpen={vi.fn()}
        publishMenuAnchorRef={createRef<HTMLDivElement>()}
        onCommitRun={vi.fn()}
        onOpenPublishDialog={vi.fn()}
        onOpenBranchPublishDialog={vi.fn()}
        onOpenInIde={vi.fn()}
        onOpenFileManager={vi.fn()}
        onOpenContinueRunDialog={vi.fn()}
        onDeleteRun={vi.fn()}
      />,
    );
    expect(markup).toContain("feat/coverage");
    expect(markup).toContain("Changes");
    expect(markup).toContain('title="Run token usage"');
  });

  it("hides token usage controls for Cursor runs", () => {
    const run = runRecord({
      providerAccountId: "provider-cursor-agent",
      harnessType: "cursor-acp",
      inputTokens: 0,
      outputTokens: 0,
    });
    const runDetail: RunDetail = { run, steps: [], notes: [], diff: "" };
    const markup = renderToStaticMarkup(
      <RunDetailHeader
        run={run}
        runDetail={runDetail}
        tokenUsage={{ inputTokens: 0, outputTokens: 0, totalProcessedTokens: 0 }}
        busy={false}
        pendingDelete={false}
        configuredIdeKinds={[]}
        canContinueRun
        runTimelineDensity="comfortable"
        onRunTimelineDensityChange={vi.fn()}
        runDensityMenuOpen={false}
        setRunDensityMenuOpen={vi.fn()}
        runDensityMenuAnchorRef={createRef<HTMLDivElement>()}
        runPanelToggleItems={[]}
        runWorkspaceVisiblePanelCount={0}
        runPanelsMenuOpen={false}
        setRunPanelsMenuOpen={vi.fn()}
        runPanelsMenuAnchorRef={createRef<HTMLDivElement>()}
        publishMenuOpen={false}
        setPublishMenuOpen={vi.fn()}
        publishMenuAnchorRef={createRef<HTMLDivElement>()}
        onCommitRun={vi.fn()}
        onOpenPublishDialog={vi.fn()}
        onOpenBranchPublishDialog={vi.fn()}
        onOpenInIde={vi.fn()}
        onOpenFileManager={vi.fn()}
        onOpenContinueRunDialog={vi.fn()}
        onDeleteRun={vi.fn()}
      />,
    );

    expect(markup).not.toContain('title="Run token usage"');
    expect(markup).not.toContain("Token Usage");
  });

  it("shows the orchestration status while the coordinator provider turn is idle", () => {
    const run = runRecord({ orchestrationStatus: "waiting" });
    const runDetail: RunDetail = { run, steps: [], notes: [], diff: "" };
    const markup = renderToStaticMarkup(
      <RunDetailHeader
        run={run}
        runDetail={runDetail}
        tokenUsage={null}
        busy={false}
        pendingDelete={false}
        configuredIdeKinds={[]}
        canContinueRun
        runTimelineDensity="comfortable"
        onRunTimelineDensityChange={vi.fn()}
        runDensityMenuOpen={false}
        setRunDensityMenuOpen={vi.fn()}
        runDensityMenuAnchorRef={createRef<HTMLDivElement>()}
        runPanelToggleItems={[]}
        runWorkspaceVisiblePanelCount={0}
        runPanelsMenuOpen={false}
        setRunPanelsMenuOpen={vi.fn()}
        runPanelsMenuAnchorRef={createRef<HTMLDivElement>()}
        publishMenuOpen={false}
        setPublishMenuOpen={vi.fn()}
        publishMenuAnchorRef={createRef<HTMLDivElement>()}
        onCommitRun={vi.fn()}
        onOpenPublishDialog={vi.fn()}
        onOpenBranchPublishDialog={vi.fn()}
        onOpenInIde={vi.fn()}
        onOpenFileManager={vi.fn()}
        onOpenContinueRunDialog={vi.fn()}
        onDeleteRun={vi.fn()}
      />,
    );
    expect(markup).toContain(">waiting<");
    expect(markup).toContain("waiting for orchestrated tasks");
  });

  it("renders provider registries and navigation states", () => {
    const account = providerAccount();
    const model = modelRecord(account);
    expect(
      renderToStaticMarkup(
        <ProviderModelsOverview
          welcome={false}
          accounts={[account]}
          models={[model]}
          onDeleteProvider={vi.fn()}
          onDeleteModel={vi.fn()}
        />,
      ),
    ).toContain("GPT-5");
    expect(
      renderToStaticMarkup(
        <ProviderModelPanelButtons
          welcome
          providerReady={false}
          modelReady={false}
          openPanel="connection"
          onOpenPanelChange={vi.fn()}
        />,
      ),
    ).toContain("Unlocks after the connection");
  });

  it.each<ProviderType>(["ai-sdk", "openrouter", "azure-legacy", "codex-cli", "claude-code", "cursor-agent"])(
    "renders the %s connection form",
    (providerType) => {
      const markup = renderToStaticMarkup(
        <ProviderModelsSettingsTab {...providerSettingsProps(providerType)} openPanel="connection" />,
      );
      expect(markup).toContain("Save connection");
    },
  );

  it("renders loaded and failed model selection states", () => {
    const props = providerSettingsProps("ai-sdk");
    const loaded = renderToStaticMarkup(
      <ProviderModelsSettingsTab
        {...props}
        openPanel="model"
        availableModelsState={{
          status: "loaded",
          models: [{ modelId: "gpt-5", displayName: "GPT-5", source: "provider" }],
          errorMessage: null,
        }}
      />,
    );
    expect(loaded).toContain("Available models reported");
    const failed = renderToStaticMarkup(
      <ProviderModelsSettingsTab
        {...props}
        openPanel="model"
        availableModelsState={{ status: "error", models: [], errorMessage: "offline" }}
      />,
    );
    expect(failed).toContain("Could not load live models");
    expect(failed).toContain("Enter a model ID manually or retry");
    expect(failed).toContain("Model ID");
  });

  it("renders branch and pull-request workflow shells", () => {
    const branches = renderToStaticMarkup(
      <ProjectBranchesPage
        projectId="project-1"
        repoPath="C:/repo"
        baseBranch="main"
        currentBranch="main"
        branches={["main", "feat/quality"]}
        busy={false}
        onBranchesChanged={vi.fn()}
      />,
    );
    expect(branches).toContain("2 branches");

    const pullRequests = renderToStaticMarkup(
      <ProjectPrMrTab
        projectId="project-1"
        modelOptions={[{ id: "model-1", label: "GPT-5", modelId: "gpt-5", providerType: "ai-sdk", providerFamily: "openai" }]}
        defaultModelId="model-1"
        onOpenProjectSettings={vi.fn()}
      />,
    );
    expect(pullRequests).toContain("Pull / merge requests");
  });

  it("renders configured Project Lab threads", () => {
    const run = runRecord();
    const projectSnapshot = {
      project: {
        id: "project-1",
        name: "BuildWarden",
        repoPath: "C:/repo",
        baseBranch: "main",
        kind: "git",
        cumulativeInputTokens: 0,
        cumulativeOutputTokens: 0,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        lastOpenedAt: run.updatedAt,
      },
      runs: [run],
      forLaterRuns: [],
      orchestratedRuns: [],
      activeRuns: [],
      recentRuns: [run],
      tasks: [],
      insights: [],
      loops: [],
      labThreads: [{
        thread: {
          id: "lab-1",
          projectId: "project-1",
          kind: "rfc",
          mode: "refactoring",
          status: "completed",
          origin: "manual",
          title: "Extract renderer workflow",
          summary: "Split the large component",
          outcome: "Completed",
          seedPrompt: null,
          implementationPrompt: "Refactor the workflow",
          baseBranch: "main",
          implementationRunId: run.id,
          implementationModelId: "model-1",
          reviewModelId: "model-1",
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
        },
        events: [{ id: "event-1", threadId: "lab-1", role: "rfc", label: "RFC", content: "Refactor the workflow", createdAt: run.createdAt }],
        implementationRun: run,
      }],
    } as unknown as ProjectSnapshot;
    const markup = renderToStaticMarkup(
      <ProjectLabTab
        project={projectSnapshot}
        modelOptions={[{ id: "model-1", label: "GPT-5", modelId: "gpt-5", providerType: "ai-sdk", providerFamily: "openai" }]}
        settings={{ enabled: true, maxThreadsPerDay: 3, maxConcurrentThreads: 1, implementationModelId: "model-1", reviewModelId: "model-1" }}
        busy={false}
        branchOptions={["main"]}
        selectedBaseBranch="main"
        onBaseBranchChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onRunProjectLab={vi.fn()}
        onDeleteThread={vi.fn()}
        onOpenImplementationRun={vi.fn()}
      />,
    );
    expect(markup).toContain("Project Lab");
    expect(markup).toContain("Extract renderer workflow");

    const remoteLabMarkup = renderToStaticMarkup(
      <ProjectLabTab
        project={projectSnapshot}
        modelOptions={[{ id: "model-1", label: "GPT-5", modelId: "gpt-5", providerType: "ai-sdk", providerFamily: "openai" }]}
        settings={{ enabled: true, maxThreadsPerDay: 3, maxConcurrentThreads: 1, implementationModelId: "model-1", reviewModelId: "model-1" }}
        busy={false}
        branchOptions={["main"]}
        selectedBaseBranch="main"
        onBaseBranchChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onRunProjectLab={vi.fn()}
        onDeleteThread={vi.fn()}
        onOpenImplementationRun={vi.fn()}
      />,
      {} as DesktopApi,
      remoteRunCapabilities,
    );
    expect(remoteLabMarkup).toContain("Extract renderer workflow");
    expect(remoteLabMarkup).toContain("Open implementation run");
    expect(remoteLabMarkup).not.toContain("Start Project Lab");
    expect(remoteLabMarkup).not.toContain("Delete");

    const remoteGraphsMarkup = renderToStaticMarkup(
      <ProjectGraphsTab project={projectSnapshot} onGenerateInsight={vi.fn()} />,
      {} as DesktopApi,
      remoteRunCapabilities,
    );
    expect(remoteGraphsMarkup).toContain("Architecture graph");
    expect(remoteGraphsMarkup).toContain("No saved architecture graph is available on the host.");
    expect(remoteGraphsMarkup).not.toContain("Refresh");

    const projectSettingsProps = {
      project: projectSnapshot,
      modelOptions: [{ id: "model-1", label: "GPT-5", modelId: "gpt-5", providerType: "ai-sdk", providerFamily: "openai" }],
      availableBranches: ["main", "feat/remote"],
      currentProjectBranch: "main",
      runMode: "code",
      runWorkspaceType: "worktree",
      runModelId: "model-1",
      runWorktreeModelIds: ["model-1"],
      projectRunStats: { total: 1, active: 0, completed: 1, failed: 0, cancelled: 0, inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
      reasoningEffort: "high",
      anthropicEffort: "medium",
      yoloMode: false,
      verificationCommands: [],
      maxRunMinutes: 0,
      maxRunTokens: 0,
      mcpServers: [],
      busy: false,
      availableIntegratedSkills: [],
      activeIntegratedSkillIds: [],
      onRunModeChange: vi.fn(),
      onRunWorkspaceTypeChange: vi.fn(),
      onProjectBaseBranchChange: vi.fn(),
      onRunModelChange: vi.fn(),
      onRunWorktreeModelIdsChange: vi.fn(),
      onReasoningEffortChange: vi.fn(),
      onAnthropicEffortChange: vi.fn(),
      onYoloModeChange: vi.fn(),
      onVerificationCommandsChange: vi.fn(),
      onMaxRunMinutesChange: vi.fn(),
      onMaxRunTokensChange: vi.fn(),
      onMcpServersChange: vi.fn(),
      onActiveIntegratedSkillIdsChange: vi.fn(),
      onDeleteProject: vi.fn(),
    } satisfies ComponentProps<typeof ProjectSettingsPage>;
    const remoteSettingsMarkup = renderToStaticMarkup(
      <ProjectSettingsPage {...projectSettingsProps} />,
      {} as DesktopApi,
      remoteRunCapabilities,
    );
    expect(remoteSettingsMarkup).toContain("limited remote settings");
    expect(remoteSettingsMarkup).toContain("Base branch");
    expect(remoteSettingsMarkup).not.toContain("Project defaults");
    expect(remoteSettingsMarkup).not.toContain("Model set");
    expect(remoteSettingsMarkup).not.toContain("Git hosting");
    expect(remoteSettingsMarkup).not.toContain("Project skills");
    expect(remoteSettingsMarkup).not.toContain("Delete project");

    const remoteFolderSettingsMarkup = renderToStaticMarkup(
      <ProjectSettingsPage
        {...projectSettingsProps}
        project={{
          ...projectSnapshot,
          project: { ...projectSnapshot.project, kind: "folder" },
        }}
        runWorkspaceType="copy"
      />,
      {} as DesktopApi,
      remoteRunCapabilities,
    );
    expect(remoteFolderSettingsMarkup).toContain("limited remote settings");
    expect(remoteFolderSettingsMarkup).not.toContain("Repository");

    const sidebarProps = {
      projects: [projectSnapshot],
      landingSelected: false,
      allRunsSelected: false,
      bookmarksSelected: false,
      chatsSelected: false,
      settingsSelected: false,
      selectedProjectId: "project-1",
      currentProjectBranch: "main",
      currentProjectBranchStatus: "attached",
      projectView: "overview",
      highlightedRunId: null,
      collapsed: false,
      width: 312,
      recentRunDays: 2,
      runEntrySize: "medium",
      groupRunsByProject: true,
      bookmarksCount: 0,
      chatsCount: 0,
      bookmarkedRunIds: new Set<string>(),
      onSelectLanding: vi.fn(),
      onSelectAllRuns: vi.fn(),
      onSelectBookmarks: vi.fn(),
      onSelectChats: vi.fn(),
      onSelectProject: vi.fn(),
      onSelectProjectFeature: vi.fn(),
      onSelectRun: vi.fn(),
      onRunDragStart: vi.fn(),
      onReorderProjects: vi.fn(),
      onAddRunToBookmarks: vi.fn(),
      onRemoveRunFromBookmarks: vi.fn(),
      onContinueRun: vi.fn(),
      onDeleteRun: vi.fn(),
      onSetRunForLater: vi.fn(),
      pendingDeleteRunIds: {},
      onOpenSettings: vi.fn(),
      onWidthCommit: vi.fn(),
      onToggleCollapsed: vi.fn(),
      loopEnabledProjectIds: new Set<string>(),
    } satisfies ComponentProps<typeof Sidebar>;
    const remoteSidebarMarkup = renderToStaticMarkup(
      <Sidebar {...sidebarProps} />,
      {} as DesktopApi,
      remoteRunCapabilities,
    );
    expect(remoteSidebarMarkup).toContain("Start new agent run");
    expect(remoteSidebarMarkup).toContain("Project settings (limited remote access)");
    expect(remoteSidebarMarkup).toContain("Graphs");
    expect(remoteSidebarMarkup).toContain("AI Insights");
    expect(remoteSidebarMarkup).toContain("Task Board");
    expect(remoteSidebarMarkup).toContain("Project Lab");
    expect(remoteSidebarMarkup).toContain("For Later");
    expect(remoteSidebarMarkup).not.toContain("PR Review");
    expect(remoteSidebarMarkup).not.toContain("Loops");

    const sidebarSubagent = runRecord({
      id: "sidebar-subagent",
      kind: "orchestration-task",
      parentRunId: run.id,
      rootRunId: run.id,
      lineageTitle: "Inspect the sidebar hierarchy",
    });
    const flatSidebarMarkup = renderToStaticMarkup(
      <Sidebar
        {...sidebarProps}
        projects={[{ ...projectSnapshot, orchestratedRuns: [sidebarSubagent] }]}
        recentRunDays={10_000}
        runEntrySize="small"
        groupRunsByProject={false}
      />,
      {} as DesktopApi,
      remoteRunCapabilities,
    );
    expect(flatSidebarMarkup).toContain('data-sidebar-run-entry-size="small"');
    expect(flatSidebarMarkup).toContain('data-sidebar-run-project="true"');
    expect(flatSidebarMarkup).toContain("BuildWarden");
    expect(flatSidebarMarkup).toContain('data-run-hierarchy-toggle="run-1"');
    expect(flatSidebarMarkup).toContain('aria-expanded="false"');
    expect(flatSidebarMarkup).not.toContain("Inspect the sidebar hierarchy");
    expect(flatSidebarMarkup).not.toContain("data-sidebar-run-group");

    const recentTimestamp = new Date().toISOString();
    const oldTimestamp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const oldSidebarParent = runRecord({
      createdAt: oldTimestamp,
      updatedAt: oldTimestamp,
      startedAt: oldTimestamp,
      finishedAt: oldTimestamp,
    });
    const recentSidebarChild = runRecord({
      id: "recent-sidebar-subagent",
      kind: "orchestration-task",
      parentRunId: oldSidebarParent.id,
      rootRunId: oldSidebarParent.id,
      lineageTitle: "Recent delegated work",
      createdAt: recentTimestamp,
      updatedAt: recentTimestamp,
      startedAt: recentTimestamp,
      finishedAt: recentTimestamp,
    });
    const recentChildSidebarMarkup = renderToStaticMarkup(
      <Sidebar
        {...sidebarProps}
        projects={[{
          ...projectSnapshot,
          runs: [oldSidebarParent],
          recentRuns: [],
          orchestratedRuns: [recentSidebarChild],
        }]}
        recentRunDays={2}
        groupRunsByProject={false}
      />,
      {} as DesktopApi,
      remoteRunCapabilities,
    );
    expect(recentChildSidebarMarkup).toContain('data-run-hierarchy-toggle="run-1"');
    expect(recentChildSidebarMarkup).toContain("1 subagent");

    const controlLabMarkup = renderToStaticMarkup(
      <ProjectLabTab
        project={projectSnapshot}
        modelOptions={[{ id: "model-1", label: "GPT-5", modelId: "gpt-5", providerType: "ai-sdk", providerFamily: "openai" }]}
        settings={{ enabled: true, maxThreadsPerDay: 3, maxConcurrentThreads: 1, implementationModelId: "model-1", reviewModelId: "model-1" }}
        busy={false}
        branchOptions={["main"]}
        selectedBaseBranch="main"
        onBaseBranchChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onRunProjectLab={vi.fn()}
        onDeleteThread={vi.fn()}
        onOpenImplementationRun={vi.fn()}
      />,
      {} as DesktopApi,
      remoteControlCapabilities,
    );
    expect(controlLabMarkup).toContain("Start Project Lab");

    const controlGraphsMarkup = renderToStaticMarkup(
      <ProjectGraphsTab project={projectSnapshot} onGenerateInsight={vi.fn()} />,
      {} as DesktopApi,
      remoteControlCapabilities,
    );
    expect(controlGraphsMarkup).toContain("Refresh");

    const controlSettingsMarkup = renderToStaticMarkup(
      <ProjectSettingsPage {...projectSettingsProps} />,
      {} as DesktopApi,
      remoteControlCapabilities,
    );
    expect(controlSettingsMarkup).toContain("Project defaults");
    expect(controlSettingsMarkup).toContain("Git hosting");
    expect(controlSettingsMarkup).toContain("Delete project");
  });
});
