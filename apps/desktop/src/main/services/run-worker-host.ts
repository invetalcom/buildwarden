import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  APP_SETTING_KEYS,
  type ChatAttachmentPayload,
  getHarnessCapabilities,
  type ModelRecord,
  type NetworkProxyRuntimeConfig,
  parseProjectRunDefaultsSetting,
  parseShellAllowlistExtraSetting,
  parseToolApprovalAllowlistSetting,
  type ProviderAccountRecord,
  type ProviderExecutionOptions,
  type RunRecord,
} from "@buildwarden/shared";
import { getCompileCacheWorkerData } from "../compile-cache";
import { resolveMcpServerRuntimeConfigs } from "../mcp-server-registry";
import { ORCHESTRATION_TOOL_DEFINITIONS } from "../orchestration-tools";
import { AppService } from "./app-service";
import { parseMetadataRecord } from "./run-step-content";
import { RunWorkerTurn, type RunWorkerTurnDependencies } from "./run-worker-turn";

/** Starts a run's turn in a worker thread. */
export class RunWorkerHost extends AppService<RunWorkerTurnDependencies | "providerRuntime" | "skills"> {
  /**
   * The model each live run's provider last said served it. The reports are silent chunks, which
   * are not saved as steps, so publication copies the value into its durable effect.
   */
  readonly runExecutedModels = new Map<string, string>();

  async startWorker(
    run: RunRecord,
    provider: ProviderAccountRecord,
    model: ModelRecord,
    apiKey: string,
    networkProxy: NetworkProxyRuntimeConfig | undefined,
    options?: {
      promptOverride?: string;
      skillPrompt?: string;
      attachments?: ChatAttachmentPayload[];
      recoverSkills?: boolean;
      providerOptions?: ProviderExecutionOptions;
      yoloMode?: boolean;
      isOrchestrationUpdate?: boolean;
      /** Full conversation for a fresh session when the expected session resume fails. */
      resumeFallbackContext?: string;
    },
  ): Promise<Worker> {
    this.services.activeWorkers.requireAgentWorkersAvailable();
    this.services.workspaceGuard.requireWorkspaceNotRestoring(run.worktreePath);
    const settings = this.db.getSettings();
    try {
      // Recheck after asynchronous workspace preparation, using the worker's settings snapshot.
      this.services.providerRuntime.requireProjectMcpSupported(run.projectId, provider, settings[APP_SETTING_KEYS.projectRunDefaults]);
    } catch (error) {
      this.db.updateRunStatus(run.id, "failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (run.kind === "orchestration-task" && this.db.getOrchestrationTaskByChildRunId(run.id)?.permissionMode === "supervised") {
      options = { ...options, yoloMode: false };
    }
    const checkpoint = this.services.turnState.getRunCheckpoint(run.id);
    const savedSkills = checkpoint?.skills ?? (checkpoint || options?.recoverSkills ? this.db.getSessionSkills("run", run.id) ?? undefined : undefined);
    const skills = {
      snapshot: await this.services.skills.prepareSessionSkills("run", run.id, options?.skillPrompt ?? run.prompt, run.projectId, savedSkills),
      storePath: this.services.skills.skillService.storePath,
      recovering: Boolean(checkpoint || options?.recoverSkills),
    };
    const workspaceSetup = this.db.getRunWorkspaceSetup(run.id, true);
    this.services.activeWorkers.requireAgentWorkersAvailable();
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), "worker.js");
    const nativeSession = this.services.turnState.resolveRunNativeSession(run, provider);
    // Every resume needs it, including recovery and orchestration wakes, not only follow-ups.
    const resumeFallbackContext = nativeSession.session
      ? options?.resumeFallbackContext ?? this.services.turnState.buildResumeFallbackContext(this.db.getRunSteps(run.id), provider)
      : undefined;
    const usageTracker = this.services.runWorkerOutput.initialUsageReportTracker(provider, this.db.getRunSteps(run.id), nativeSession.session !== null, model);
    if (this.services.workspaceGuard.manualVerifications.has(run.id)) throw new Error("Wait for verification to finish or cancel it first.");
    const shellAllowlistExtra = parseShellAllowlistExtraSetting(settings[APP_SETTING_KEYS.shellAllowlistExtra]);
    const toolApprovalAllowlist = parseToolApprovalAllowlistSetting(settings[APP_SETTING_KEYS.toolApprovalAllowlist])[run.projectId] ?? [];
    const runDefaults = parseProjectRunDefaultsSetting(settings[APP_SETTING_KEYS.projectRunDefaults])[run.projectId];
    const projectMcpSupported = getHarnessCapabilities(provider.providerType).projectMcp !== "unsupported";
    const mcpServers = projectMcpSupported
      ? resolveMcpServerRuntimeConfigs(runDefaults?.mcpServers ?? [])
      : [];
    const devModeEnabled = settings[APP_SETTING_KEYS.enableDevMode] === "true";
    if (devModeEnabled) {
      mkdirSync(this.logDirPath, { recursive: true });
    }

    // A report belongs to the worker that made it. A new turn that reports no model (an ACP agent
    // whose reloaded session omits it, a provider that never reports) must not inherit the last one.
    this.runExecutedModels.delete(run.id);
    const worker = new Worker(workerPath, {
      workerData: {
        ...getCompileCacheWorkerData(),
        acknowledgeChunks: true,
        request: {
          ...(workspaceSetup && workspaceSetup.status !== "completed" ? { workspaceSetup: {
            profile: workspaceSetup.profile, sourcePath: this.db.getProject(run.projectId).repoPath,
          } } : {}),
          runId: run.id,
          providerAccountId: provider.id,
          worktreePath: run.worktreePath,
          browserToolsEnabled: Boolean(this.lifecycle.executeBrowserTool),
          // Delegated children and council reviewers work on the repository, never on the app's look.
          themeToolsEnabled: Boolean(this.lifecycle.executeThemeTool) && run.kind !== "orchestration-task" && run.kind !== "council-review",
          // Reviewers answer in a fixed format; every other run may show the user a page.
          visualRepliesEnabled: run.kind !== "council-review",
          workspaceVcs: run.workspaceVcs,
          mode: run.mode,
          yoloMode: options?.yoloMode === true,
          prompt: options?.promptOverride ?? run.prompt,
          providerType: provider.providerType,
          modelId: model.modelId,
          apiKey,
          apiBaseUrl: model.baseUrlOverride ?? provider.apiBaseUrl,
          previousResponseId: nativeSession.previousResponseId,
          providerSessionRuntime: nativeSession.session,
          priorMessages: this.services.turnState.buildPriorRunMessagesFromSteps(run.id),
          skills,
          config: JSON.parse(provider.configJson || "{}") as Record<string, unknown>,
          modelConfig: JSON.parse(model.configJson || "{}") as Record<string, unknown>,
          modelCapabilities: parseMetadataRecord(model.capabilitiesJson),
          providerOptions: options?.providerOptions,
          ...(networkProxy ? { networkProxy } : {}),
          shellAllowlistExtra,
          ...(mcpServers.length > 0 ? { mcpServers } : {}),
          ...(toolApprovalAllowlist.length > 0 ? { toolApprovalAllowlist } : {}),
          ...(resumeFallbackContext ? { resumeFallbackContext } : {}),
          ...(run.kind === "orchestration-task" && run.mode !== "code" ? { requireReadOnly: true } : {}),
          resumeCheckpoint: this.services.turnState.getRunCheckpoint(run.id),
          ...(devModeEnabled ? { devLogging: { logDirPath: this.logDirPath } } : {}),
          ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
          ...(Boolean(run.delegationEnabled) && run.kind !== "orchestration-task"
            ? { orchestrationTools: ORCHESTRATION_TOOL_DEFINITIONS }
            : {}),
          ...(options?.isOrchestrationUpdate ? { isOrchestrationUpdate: true } : {}),
        },
      },
    });

    new RunWorkerTurn(this.context, this.services, {
      run, provider, model, worker, usageTracker,
      maxRunMinutes: runDefaults?.maxRunMinutes ?? 0,
      maxRunTokens: runDefaults?.maxRunTokens ?? 0,
    }).begin();
    return worker;
  }
}
