import { computePrMrDiffViaFetch } from "@buildwarden/git-service";
import {
  APP_SETTING_KEYS,
  type FetchProjectPrMrDiffInput,
  type GetProjectForgeRequestDetailsInput,
  type ListProjectForgeRequestsInput,
  type MergeProjectForgeRequestInput,
  parseProjectForgePrMonitorIntervalMinutes,
  parseProjectForgePrMonitorSettingsSetting,
  type PostProjectPrMrReviewInput,
  type ProjectForgeAuthStatus,
  type ProjectForgePrMonitorConfig,
  type ProjectForgePrMonitorSettings,
  type ProjectForgePrMonitorSettingsInput,
  type ProjectForgeRequestDetailsResult,
  type ProjectForgeRequestsResult,
  type ProjectForgeRequestStatus,
  type ProjectForgeReviewActionResult,
  type ProjectPrMrDiffResult,
  type ReplyProjectPrMrReviewThreadInput,
  type ResolveProjectPrMrReviewThreadInput,
  type RunForgeRequestSummary,
  type SubmitProjectPrMrCommentsInput,
  type UpdateProjectForgeRequestInput,
} from "@buildwarden/shared";
import { logWarn } from "../logger";
import { createProjectPrReviewProvider } from "../pr-review/pr-review-provider-factory";
import { resolveProjectPrReviewRemoteContext } from "../pr-review/pr-review-remote-context";
import type { ProjectPrReviewProvider, ProjectPrReviewRemoteContext } from "../pr-review/pr-review-types";
import { AppService } from "./app-service";
import { assertForgeMergeAllowed, assertForgeUpdateSupported, projectForgeTokenSecretKey, toProjectForgeRequestStatus } from "./forge-request-policy";

const PROJECT_FORGE_LIST_CACHE_MS = 30_000;

/** Lists, updates and reviews a project's pull and merge requests. */
export class ForgeRequestService extends AppService<"activeWorkers" | "forgeIssueActions" | "runForge" | "settings" | "workspaceGuard"> {
  readonly projectForgeSyncQueues = new Map<string, Promise<unknown>>();
  private readonly projectForgeRequestListCache = new Map<string, { expiresAt: number; result: ProjectForgeRequestsResult }>();
  private readonly projectForgeRequestListInflight = new Map<string, Promise<ProjectForgeRequestsResult>>();
  private forgeMonitorSettingsCache: { revision: number; settings: ReturnType<typeof parseProjectForgePrMonitorSettingsSetting> } | null = null;

  async fetchProjectPrMrDiff(projectId: string, input: FetchProjectPrMrDiffInput): Promise<ProjectPrMrDiffResult> {
    const project = this.db.getProject(projectId);
    this.services.workspaceGuard.requireGitProject(project, "Pull and merge request review");
    const prUrl = input.prUrl?.trim() ?? "";
    if (!prUrl) {
      throw new Error("Enter a pull request or merge request URL.");
    }
    const token = await this.secrets.readSecret(projectForgeTokenSecretKey(projectId));
    if (token?.trim()) {
      try {
        const context = await this.resolveProjectPrReviewRemoteContext(projectId);
        const provider = createProjectPrReviewProvider(context, token.trim());
        const result = await provider.getRequestDiff(input);
        if (!result.diff.trim()) {
          throw new Error("The hosting API returned an empty diff for this PR/MR.");
        }
        return result;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not load the PR/MR diff via hosting API. ${msg}`);
      }
    }
    if (input.commitSha?.trim()) {
      throw new Error("Commit-specific PR/MR diffs require a Git hosting access token in Project Settings.");
    }
    try {
      const result = await computePrMrDiffViaFetch(project.repoPath, {
        prMrUrl: prUrl,
        baseBranch: input.baseBranch?.trim() || undefined,
      });
      if (!result.diff.trim()) {
        throw new Error(
          "The local git diff is empty. If this PR/MR is already merged, add a Git hosting access token in Project Settings and load it from the hosting API to read the historical diff.",
        );
      }
      return {
        diff: result.diff,
        provider: result.provider,
        number: result.number,
        baseRef: result.baseRef,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not load the PR/MR diff via git fetch. ${msg}`);
    }
  }

  async getProjectForgeAuthStatus(projectId: string): Promise<ProjectForgeAuthStatus> {
    const context = await this.resolveProjectPrReviewRemoteContext(projectId);
    return {
      provider: context.provider,
      webBaseUrl: context.webBaseUrl,
      repoLabel: context.repoLabel,
      hasToken: (await this.secrets.readSecret(projectForgeTokenSecretKey(projectId))) !== null,
    };
  }

  async saveProjectForgeAuthToken(projectId: string, token: string): Promise<ProjectForgeAuthStatus> {
    this.services.runForge.forgeSourceIdentities.clear();
    const trimmed = token.trim();
    if (!trimmed) {
      throw new Error("Enter an access token before saving.");
    }
    await this.resolveProjectPrReviewRemoteContext(projectId);
    await this.secrets.saveSecret(projectForgeTokenSecretKey(projectId), trimmed);
    this.db.clearProjectRunForgeRetryDelays(projectId);
    this.clearProjectForgeRequestListCache(projectId);
    this.services.runForge.projectForgeDiscoveryRetryAt.delete(projectId);
    this.services.runForge.runForgeDiscovery?.refresh(projectId, true);
    this.services.forgeIssueActions.forgeIssues.forgetProject(projectId);
    return this.getProjectForgeAuthStatus(projectId);
  }

  async deleteProjectForgeAuthToken(projectId: string): Promise<ProjectForgeAuthStatus> {
    this.services.runForge.forgeSourceIdentities.clear();
    await this.resolveProjectPrReviewRemoteContext(projectId);
    await this.secrets.deleteSecret(projectForgeTokenSecretKey(projectId));
    this.clearProjectForgeRequestListCache(projectId);
    this.services.forgeIssueActions.forgeIssues.forgetProject(projectId);
    this.services.settings.setProjectForgePrMonitorInterval(projectId, 0);
    return this.getProjectForgeAuthStatus(projectId);
  }

  async getProjectForgePrMonitorSettings(projectId: string): Promise<ProjectForgePrMonitorSettings> {
    const project = this.db.getProject(projectId);
    this.services.workspaceGuard.requireGitProject(project, "PR/MR monitoring");
    const settings = parseProjectForgePrMonitorSettingsSetting(
      this.db.getSettings()[APP_SETTING_KEYS.projectForgePrMonitorSettings],
    );
    return settings[projectId] ?? { intervalMinutes: 0 };
  }

  async saveProjectForgePrMonitorSettings(
    projectId: string,
    input: ProjectForgePrMonitorSettingsInput,
  ): Promise<ProjectForgePrMonitorSettings> {
    const project = this.db.getProject(projectId);
    this.services.workspaceGuard.requireGitProject(project, "PR/MR monitoring");
    const intervalMinutes = parseProjectForgePrMonitorIntervalMinutes(input.intervalMinutes);
    if (intervalMinutes > 0) {
      const token = await this.secrets.readSecret(projectForgeTokenSecretKey(projectId));
      if (!token?.trim()) {
        throw new Error("Save a Git hosting access token before enabling PR/MR background checks.");
      }
    }
    this.services.settings.setProjectForgePrMonitorInterval(projectId, intervalMinutes);
    return { intervalMinutes };
  }

  async listProjectForgePrMonitorConfigs(): Promise<ProjectForgePrMonitorConfig[]> {
    const settings = parseProjectForgePrMonitorSettingsSetting(
      this.db.getSettings()[APP_SETTING_KEYS.projectForgePrMonitorSettings],
    );
    const configs: ProjectForgePrMonitorConfig[] = [];

    for (const project of this.db.listProjects()) {
      if (project.kind !== "git") {
        continue;
      }
      const intervalMinutes = settings[project.id]?.intervalMinutes ?? 0;
      if (intervalMinutes <= 0) {
        continue;
      }
      const token = await this.secrets.readSecret(projectForgeTokenSecretKey(project.id));
      if (!token?.trim()) {
        continue;
      }
      try {
        const context = await this.resolveProjectPrReviewRemoteContext(project.id);
        configs.push({
          projectId: project.id,
          projectName: project.name,
          provider: context.provider,
          repoLabel: context.repoLabel,
          intervalMinutes,
        });
      } catch (error) {
        logWarn("Skipping PR/MR monitor for project with unresolved Git hosting context.", {
          projectId: project.id,
          projectName: project.name,
          error,
        });
      }
    }

    return configs;
  }

  async listProjectForgeRequests(
    projectId: string,
    input?: ListProjectForgeRequestsInput,
  ): Promise<ProjectForgeRequestsResult> {
    return this.serializeProjectForgeSync(projectId, async () => {
      const provider = await this.createProjectPrReviewProvider(projectId);
      return this.loadProjectForgeRequests(projectId, provider, input);
    });
  }

  async getProjectForgeRequestDetails(
    projectId: string,
    input: GetProjectForgeRequestDetailsInput,
  ): Promise<ProjectForgeRequestDetailsResult> {
    const provider = await this.createProjectPrReviewProvider(projectId);
    return provider.getRequestDetails(input);
  }

  async getProjectForgeRequestStatus(
    projectId: string,
    input: GetProjectForgeRequestDetailsInput,
  ): Promise<ProjectForgeRequestStatus> {
    return this.serializeProjectForgeSync(projectId, async () => {
      const provider = await this.createProjectPrReviewProvider(projectId);
      return toProjectForgeRequestStatus(await provider.getRequestStatus(input));
    });
  }

  async updateProjectForgeRequest(
    projectId: string,
    input: UpdateProjectForgeRequestInput,
  ): Promise<ProjectForgeRequestStatus> {
    const result = await this.serializeProjectForgeSync(projectId, async () => {
      const provider = await this.createProjectPrReviewProvider(projectId);
      const current = await provider.getRequestStatus({ prUrl: input.prUrl });
      assertForgeUpdateSupported(current.supportedActions, input.action);
      await provider.updateRequest(input);
      this.clearProjectForgeRequestListCache(projectId);
      try {
        return toProjectForgeRequestStatus(await provider.getRequestStatus({ prUrl: input.prUrl }));
      } catch {
        let state = current.state;
        if (input.action === "close") state = "closed";
        else if (input.action === "reopen") state = "open";
        let draft = current.draft;
        if (input.action === "mark-draft") draft = true;
        else if (input.action === "mark-ready") draft = false;
        const optimistic = {
          ...current,
          state,
          draft,
          supportedActions: state === "closed"
            ? ["refresh", "open", "reopen"] as RunForgeRequestSummary["supportedActions"]
            : ["refresh", "open", draft ? "mark-ready" : "mark-draft", "merge", "close"] as RunForgeRequestSummary["supportedActions"],
        };
        return toProjectForgeRequestStatus(optimistic);
      }
    });
    this.services.runForge.refreshLinkedRunForgeRequests(projectId, input.prUrl);
    return result;
  }

  async mergeProjectForgeRequest(
    projectId: string,
    input: MergeProjectForgeRequestInput,
  ): Promise<ProjectForgeRequestStatus> {
    const result = await this.serializeProjectForgeSync(projectId, async () => {
      const provider = await this.createProjectPrReviewProvider(projectId);
      const current = toProjectForgeRequestStatus(await provider.getRequestStatus({ prUrl: input.prUrl }));
      assertForgeMergeAllowed(current, input);
      await provider.mergeRequest(input);
      this.clearProjectForgeRequestListCache(projectId);
      try {
        return toProjectForgeRequestStatus(await provider.getRequestStatus({ prUrl: input.prUrl }));
      } catch {
        return {
          ...current,
          state: "merged" as const,
          readiness: "merged" as const,
          draft: false,
          supportedActions: ["refresh", "open"] as ProjectForgeRequestStatus["supportedActions"],
          supportedMergeMethods: [] as ProjectForgeRequestStatus["supportedMergeMethods"],
          lastSyncedAt: new Date().toISOString(),
        };
      }
    });
    this.services.runForge.refreshLinkedRunForgeRequests(projectId, input.prUrl);
    return result;
  }

  // This queue is not reentrant: a callback must not invoke another serialized
  // forge operation for the same project or it will wait on its own pending
  // promise. syncRunForgeRequest uses loadProjectForgeRequests directly to avoid
  // re-entering through the public listProjectForgeRequests operation.
  serializeProjectForgeSync<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.projectForgeSyncQueues.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.projectForgeSyncQueues.set(projectId, current);
    return current.finally(() => {
      if (this.projectForgeSyncQueues.get(projectId) === current) this.projectForgeSyncQueues.delete(projectId);
    });
  }

  async loadProjectForgeRequests(
    projectId: string,
    provider: Pick<ProjectPrReviewProvider, "listRequests">,
    input?: ListProjectForgeRequestsInput,
    bypassCache = false,
  ): Promise<ProjectForgeRequestsResult> {
    const cacheKey = `${projectId}:${input?.state ?? "all"}${input?.sourceBranch ? `:${JSON.stringify([input.sourceBranch, input.sourceRepository])}` : ""}`;
    const cached = this.projectForgeRequestListCache.get(cacheKey);
    if (!bypassCache && cached && cached.expiresAt > Date.now()) return cached.result;
    const inflight = this.projectForgeRequestListInflight.get(cacheKey);
    if (!bypassCache && inflight) return inflight;
    const pending = provider.listRequests(input).then((result) => {
      // Clearing the cache or a newer read takes the slot away from an older one.
      if (this.projectForgeRequestListInflight.get(cacheKey) === pending) {
        this.projectForgeRequestListCache.set(cacheKey, { expiresAt: Date.now() + PROJECT_FORGE_LIST_CACHE_MS, result });
      }
      return result;
    }).finally(() => {
      if (this.projectForgeRequestListInflight.get(cacheKey) === pending) this.projectForgeRequestListInflight.delete(cacheKey);
    });
    this.projectForgeRequestListInflight.set(cacheKey, pending);
    return pending;
  }

  clearProjectForgeRequestListCache(projectId: string): void {
    for (const key of this.projectForgeRequestListCache.keys()) {
      if (key.startsWith(`${projectId}:`)) this.projectForgeRequestListCache.delete(key);
    }
    for (const key of this.projectForgeRequestListInflight.keys()) {
      if (key.startsWith(`${projectId}:`)) this.projectForgeRequestListInflight.delete(key);
    }
  }

  projectForgeIntervalMs(projectId: string): number {
    const revision = this.db.getSettingsRevision?.();
    if (revision === undefined || this.forgeMonitorSettingsCache?.revision !== revision) {
      this.forgeMonitorSettingsCache = { revision: revision ?? -1, settings: parseProjectForgePrMonitorSettingsSetting(this.db.getSettings()[APP_SETTING_KEYS.projectForgePrMonitorSettings]) };
    }
    const settings = this.forgeMonitorSettingsCache!.settings;
    return (settings[projectId]?.intervalMinutes ?? 0) * 60_000;
  }

  shouldRunProjectForgeBackgroundCheck(projectId: string, startup = false): boolean {
    return !this.services.runForge.forgeStopping && this.projectForgeIntervalMs(projectId) > 0 &&
      (startup || (this.lifecycle.isAppVisible?.() ?? true) || this.services.activeWorkers.runWorkers.size > 0);
  }

  async postProjectPrMrReview(
    projectId: string,
    input: PostProjectPrMrReviewInput,
  ): Promise<ProjectForgeReviewActionResult> {
    const provider = await this.createProjectPrReviewProvider(projectId);
    return provider.postReview(input);
  }

  async submitProjectPrMrComments(
    projectId: string,
    input: SubmitProjectPrMrCommentsInput,
  ): Promise<ProjectForgeReviewActionResult> {
    const provider = await this.createProjectPrReviewProvider(projectId);
    return provider.submitComments(input);
  }

  async replyProjectPrMrReviewThread(
    projectId: string,
    input: ReplyProjectPrMrReviewThreadInput,
  ): Promise<ProjectForgeReviewActionResult> {
    const provider = await this.createProjectPrReviewProvider(projectId);
    return provider.replyToThread(input);
  }

  async resolveProjectPrMrReviewThread(
    projectId: string,
    input: ResolveProjectPrMrReviewThreadInput,
  ): Promise<ProjectForgeReviewActionResult> {
    const provider = await this.createProjectPrReviewProvider(projectId);
    return provider.resolveThread(input);
  }

  async resolveProjectPrReviewRemoteContext(projectId: string): Promise<ProjectPrReviewRemoteContext> {
    const project = this.db.getProject(projectId);
    this.services.workspaceGuard.requireGitProject(project, "Pull and merge request review");
    return resolveProjectPrReviewRemoteContext(project, this.gitService);
  }

  async createProjectPrReviewProvider(projectId: string): Promise<ProjectPrReviewProvider> {
    const context = await this.resolveProjectPrReviewRemoteContext(projectId);
    const token = await this.requireProjectForgeToken(projectId);
    const provider = createProjectPrReviewProvider(context, token);
    const resolveSource = provider.getSourceRepository.bind(provider);
    provider.getSourceRepository = (url) => {
      const key = JSON.stringify([projectId, context.webBaseUrl, url]);
      const cached = this.services.runForge.forgeSourceIdentities.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const value = resolveSource(url).then((identity) => {
        if (identity === null && this.services.runForge.forgeSourceIdentities.get(key)?.value === value) this.services.runForge.forgeSourceIdentities.delete(key);
        return identity;
      }).catch((error: unknown) => { if (this.services.runForge.forgeSourceIdentities.get(key)?.value === value) this.services.runForge.forgeSourceIdentities.delete(key); throw error; });
      this.services.runForge.forgeSourceIdentities.set(key, { expiresAt: Date.now() + 30 * 60_000, value });
      return value;
    };
    return provider;
  }

  private async requireProjectForgeToken(projectId: string): Promise<string> {
    const token = await this.secrets.readSecret(projectForgeTokenSecretKey(projectId));
    if (!token?.trim()) {
      throw new Error("Add a Git hosting access token in Project Settings before fetching PRs/MRs.");
    }
    return token.trim();
  }
}
