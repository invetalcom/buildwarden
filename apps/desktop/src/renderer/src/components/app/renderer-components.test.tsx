import { createRef } from "react";
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
  approvalResponses: false,
  gitMutations: true,
  projectCreation: false,
  hostDirectoryBrowser: false,
  liveEvents: true,
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
  });

  it("renders plan, token, and context summaries", () => {
    const planMarkup = renderToStaticMarkup(
      <RunPlanSteps content={"1. [x] Inspect\n2. [-] Refactor\n3. [ ] Verify"} />,
    );
    expect(planMarkup).toContain("Plan steps");
    expect(planMarkup).toContain("in progress");
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
    const overviewMarkup = renderToStaticMarkup(
      <ProjectOverviewTab
        projectId="project-1"
        projectName="BuildWarden"
        repoPath="C:/repo"
        projectKind="git"
        runs={[runRecord()]}
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
      />,
    );
    expect(overviewMarkup).toContain("BuildWarden");
    expect(overviewMarkup).toContain("Improve renderer coverage");

    const taskMarkup = renderToStaticMarkup(
      <ProjectTasksTab
        projectId="project-1"
        tasks={[{ id: "task-1", projectId: "project-1", title: "Raise quality", prompt: "Add tests", status: "open", runId: null, pullRequestUrl: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }]}
        modelOptions={modelOptions}
        defaultTaskModelId="model-1"
        busy={false}
        onCreateTask={vi.fn()}
        onUpdateTask={vi.fn()}
        onDeleteTask={vi.fn()}
        onStartTask={vi.fn()}
      />,
    );
    expect(taskMarkup).toContain("Raise quality");
    expect(taskMarkup).toContain("Beta");
    expect(taskMarkup).toContain("View task");
    expect(taskMarkup).toContain("In Progress");
    expect(taskMarkup).toContain("In Review");
    expect(taskMarkup).toContain("Done");

    const remoteTaskMarkup = renderToStaticMarkup(
      <ProjectTasksTab
        projectId="project-1"
        tasks={[{ id: "task-1", projectId: "project-1", title: "Raise quality", prompt: "Add tests", status: "open", runId: null, pullRequestUrl: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }]}
        modelOptions={modelOptions}
        defaultTaskModelId="model-1"
        busy={false}
        onCreateTask={vi.fn()}
        onUpdateTask={vi.fn()}
        onDeleteTask={vi.fn()}
        onStartTask={vi.fn()}
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
  });

  it("renders run and chat composer configurations", () => {
    const commonProps = {
      prompt: "Review the change",
      onPromptChange: vi.fn(),
      selectedMode: "code" as const,
      onModeChange: vi.fn(),
      selectedModelId: "model-1",
      modelOptions: [
        { value: "model-1", label: "GPT-5", providerType: "ai-sdk" as const, providerFamily: "openai" as const },
        { value: "model-2", label: "Claude", providerType: "claude-code" as const },
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
        onYoloModeChange={vi.fn()}
        reasoningEffort="high"
        onReasoningEffortChange={vi.fn()}
      />,
    );
    expect(runMarkup).toContain("Full access");
    const chatMarkup = renderToStaticMarkup(<RunComposer {...commonProps} variant="chat" submitLabel="Send chat" />);
    expect(chatMarkup).toContain("Send chat");
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

  it.each<ProviderType>(["ai-sdk", "azure-legacy", "codex-cli", "claude-code", "cursor-agent"])(
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

    const remoteSettingsMarkup = renderToStaticMarkup(
      <ProjectSettingsPage
        project={projectSnapshot}
        modelOptions={[{ id: "model-1", label: "GPT-5", modelId: "gpt-5", providerType: "ai-sdk", providerFamily: "openai" }]}
        availableBranches={["main", "feat/remote"]}
        currentProjectBranch="main"
        runMode="code"
        runWorkspaceType="worktree"
        runModelId="model-1"
        runWorktreeModelIds={["model-1"]}
        projectRunStats={{ total: 1, active: 0, completed: 1, failed: 0, cancelled: 0, inputTokens: 1200, outputTokens: 300, totalTokens: 1500 }}
        reasoningEffort="high"
        anthropicEffort="medium"
        yoloMode={false}
        busy={false}
        availableIntegratedSkills={[]}
        activeIntegratedSkillIds={[]}
        onRunModeChange={vi.fn()}
        onRunWorkspaceTypeChange={vi.fn()}
        onProjectBaseBranchChange={vi.fn()}
        onRunModelChange={vi.fn()}
        onRunWorktreeModelIdsChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onAnthropicEffortChange={vi.fn()}
        onYoloModeChange={vi.fn()}
        onActiveIntegratedSkillIdsChange={vi.fn()}
        onDeleteProject={vi.fn()}
      />,
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

    const remoteSidebarMarkup = renderToStaticMarkup(
      <Sidebar
        projects={[projectSnapshot]}
        landingSelected={false}
        allRunsSelected={false}
        bookmarksSelected={false}
        chatsSelected={false}
        settingsSelected={false}
        selectedProjectId="project-1"
        currentProjectBranch="main"
        currentProjectBranchStatus="attached"
        projectView="overview"
        highlightedRunId={null}
        collapsed={false}
        width={312}
        recentRunDays={2}
        bookmarksCount={0}
        chatsCount={0}
        bookmarkedRunIds={new Set()}
        onSelectLanding={vi.fn()}
        onSelectAllRuns={vi.fn()}
        onSelectBookmarks={vi.fn()}
        onSelectChats={vi.fn()}
        onSelectProject={vi.fn()}
        onSelectProjectFeature={vi.fn()}
        onSelectRun={vi.fn()}
        onRunDragStart={vi.fn()}
        onReorderProjects={vi.fn()}
        onAddRunToBookmarks={vi.fn()}
        onRemoveRunFromBookmarks={vi.fn()}
        onContinueRun={vi.fn()}
        onDeleteRun={vi.fn()}
        onSetRunForLater={vi.fn()}
        pendingDeleteRunIds={{}}
        onOpenSettings={vi.fn()}
        onWidthCommit={vi.fn()}
        onToggleCollapsed={vi.fn()}
        loopEnabledProjectIds={new Set()}
      />,
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
  });
});
