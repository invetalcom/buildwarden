import { BuildWardenDatabase } from "@buildwarden/db";
import {
  APP_SETTING_KEYS,
  type MergeRunForgeRequestInput,
  parseRecentRunDaysSetting,
  type ProjectForgeRequestSummary,
  type ProjectPrMrDiffResult,
  type ProjectRecord,
  type RunForgeRequestDetailsResult,
  type RunForgeRequestSummary,
  type RunRecord,
  toPrWatchView,
  type UpdateRunForgeRequestInput,
} from "@buildwarden/shared";
import { PrReviewHttpError } from "../pr-review/pr-review-http-client";
import type { ForgeRequestStatusResult, RunForgeReadProvider } from "../pr-review/pr-review-types";
import { cacheRunForgeReads, guardRunForgeReads, RunForgeDiscovery } from "../run-forge-discovery";
import { eligibleForgeDiscoveryRuns, lightweightForgeSummary } from "../run-forge-policy";
import { resolveRunForgeSourceRepository } from "../run-forge-source";
import { AppService } from "./app-service";
import {
  assertForgeMergeAllowed,
  assertForgeUpdateSupported,
  forgeReadiness,
  isOpenForgeRequestState,
  projectForgeTokenSecretKey,
  summarizeForgeChecks,
  toProjectForgeRequestStatus,
} from "./forge-request-policy";

const RUN_FORGE_ERROR_BACKOFF_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;
const RUN_FORGE_HEAD_PROBE_LIMIT = 3;

/** Finds and refreshes the pull or merge request that belongs to a run. */
export class RunForgeService extends AppService<"forgeRequests" | "prWatch" | "workspaceGuard"> {
  readonly runForgeViewRefreshedAt = new Map<string, number>();
  readonly forgeSourceIdentities = new Map<string, { expiresAt: number; value: Promise<string | null> }>();
  private readonly runForgeViewRefreshes = new Map<string, Promise<RunForgeRequestSummary | null>>();
  runForgeDiscovery: RunForgeDiscovery | null = null;
  forgeStopping = false;
  readonly projectForgeDiscoveryRetryAt = new Map<string, number>();

  publishRunForgeRequest(run: RunRecord, forgeRequest: RunForgeRequestSummary | null): void {
    const watch = this.db.getPrWatch(run.id);
    this.events.publish("forge", { runId: run.id, projectId: run.projectId, forgeRequest, prWatch: watch ? toPrWatchView(watch) : null });
  }

  refreshLinkedRunForgeRequests(projectId: string, prUrl: string): void {
    for (const run of this.db.listRunsForProject(projectId)) {
      if (this.db.getRunForgeRequestCache(run.id)?.summary?.url === prUrl) {
        // This follows an explicit PR/MR write, even when background monitoring is off.
        void this.syncRunForgeRequest(run.id, true, false).catch((error) => this.logControllerWarn("Could not refresh an updated request.", { runId: run.id, error }));
      }
    }
  }

  startRunForgeDiscovery(): void {
    if (this.runForgeDiscovery || this.forgeStopping) return;
    this.runForgeDiscovery = new RunForgeDiscovery({
      projects: () => this.db.listProjects().filter((project) => project.kind === "git").map((project) => ({ projectId: project.id, intervalMs: this.services.forgeRequests.projectForgeIntervalMs(project.id) })),
      shouldRun: (projectId) => this.services.forgeRequests.shouldRunProjectForgeBackgroundCheck(projectId),
      refresh: (projectId, includeOlder) => this.discoverProjectRunForgeRequests(projectId, includeOlder),
      onError: (projectId, error) => {
        const delay = error instanceof PrReviewHttpError && error.retryAfterMs != null
          ? Math.max(RUN_FORGE_ERROR_BACKOFF_MS[0], error.retryAfterMs)
          : RUN_FORGE_ERROR_BACKOFF_MS[0];
        this.projectForgeDiscoveryRetryAt.set(projectId, Date.now() + delay);
        this.logControllerWarn("Could not discover sidebar pull requests.", { projectId, error });
      },
    });
    this.runForgeDiscovery.start();
    // Watches run independently of background checks, which only refresh sidebar badges.
    const watches = this.services.prWatch.getPrWatchService();
    void watches.reconcileAfterRestart()
      .catch((error: unknown) => this.logControllerError("Could not reconcile PR watches after a restart.", error, {}))
      .finally(() => { if (!this.forgeStopping) watches.startPolling(); });
  }

  async stopRunForgeDiscovery(): Promise<void> {
    this.forgeStopping = true;
    this.services.prWatch.prWatchService?.dispose();
    await this.runForgeDiscovery?.stop();
    await Promise.allSettled(this.services.forgeRequests.projectForgeSyncQueues.values());
  }

  private async discoverProjectRunForgeRequests(projectId: string, includeOlder = false): Promise<void> {
    const enabled = () => this.services.forgeRequests.shouldRunProjectForgeBackgroundCheck(projectId, includeOlder);
    if (!enabled() || (this.projectForgeDiscoveryRetryAt.get(projectId) ?? 0) > Date.now()) return;
    if (!(await this.secrets.readSecret(projectForgeTokenSecretKey(projectId)))?.trim() || !enabled()) return;
    const allRuns = this.db.listRunsForProject(projectId, true);
    const recentDays = parseRecentRunDaysSetting(this.db.getSettings()[APP_SETTING_KEYS.recentRunDays]);
    const runs = eligibleForgeDiscoveryRuns(allRuns, includeOlder, recentDays);
    if (runs.length === 0) return;
    const project = this.db.getProject(projectId);
    const provider = cacheRunForgeReads(guardRunForgeReads(await this.services.forgeRequests.createProjectPrReviewProvider(projectId), enabled));
    if (!enabled()) return;
    const requests = (await this.services.forgeRequests.loadProjectForgeRequests(projectId, provider, { state: "open" })).items;
    const sourcesByBranch = new Map<string, Promise<string | null>>();
    let rateLimited = false;
    for (const run of runs) {
      if (!enabled() || rateLimited) break;
      await this.services.forgeRequests.serializeProjectForgeSync(projectId, async () => {
        if (!enabled()) return;
        try {
          this.db.getRun(run.id);
          const cached = this.db.getRunForgeRequestCache(run.id);
          if (cached?.retryAfterAt && Date.parse(cached.retryAfterAt) > Date.now()) return;
          // The user unlinked this run, or chose its request: discovery must not guess another one.
          if (cached?.linkSource === "none") return;
          const userLinkUrl = cached?.linkSource === "user" ? cached.summary?.url ?? null : null;
          const candidates = requests.filter((request) => request.sourceBranch === run.branchName);
          if (!candidates.length && cached?.summary?.state !== "open") return;
          let sourceLookup = sourcesByBranch.get(run.branchName);
          if (!sourceLookup) {
            sourceLookup = resolveRunForgeSourceRepository(this.gitService, project.repoPath, run.branchName, provider);
            sourcesByBranch.set(run.branchName, sourceLookup);
          }
          const source = await sourceLookup;
          if (!enabled()) return;
          const cachedMatches = cached?.branchName === run.branchName && cached.summary?.sourceRepository === source && source !== null;
          const matching = candidates.filter((request) => source !== null && request.sourceRepository === source);
          const selected = userLinkUrl ? requests.find((request) => request.url === userLinkUrl) : (cachedMatches ? requests.find((request) => request.url === cached?.summary?.url) : undefined)
            ?? matching.sort((left, right) => Number(right.targetBranch === project.baseBranch) - Number(left.targetBranch === project.baseBranch) || (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))[0];
          // A missing list entry is not proof of a merge: confirm its basic state once.
          // Older links lack source identity. Confirm their saved, provider-validated
          // URL rather than treating absence from the open list as a missing PR.
          const legacyLink = cached?.branchName === run.branchName && cached.summary?.sourceRepository == null;
          const unresolvedSource = source === null && cached?.branchName === run.branchName;
          const request = selected ?? ((userLinkUrl || cachedMatches || legacyLink || unresolvedSource) && cached?.summary?.state === "open"
            ? await provider.getRequestSummary({ prUrl: cached.summary.url }) : null);
          if (!enabled()) return;
          if (!request) {
            if (cached?.summary?.state === "open") {
              this.db.saveRunForgeNegativeProbe(run.id, run.branchName, null, new Date(Date.now() + this.services.forgeRequests.projectForgeIntervalMs(projectId)).toISOString());
              this.publishRunForgeRequest(this.db.getRun(run.id), null);
            }
            return;
          }
          let summary = lightweightForgeSummary(request, cached?.summary ?? null, new Date().toISOString());
          if (summary.state === "open") {
            // Listing discovers associations but cannot supply readiness. Refresh
            // each matching PR once per sweep, including unopened runs, without
            // fetching full comments, files, or review details.
            let status: ForgeRequestStatusResult;
            try {
              status = await provider.getRequestStatus({ prUrl: request.url });
            } catch (error) {
              // Retain a newly discovered association so a failed status read can
              // surface its sync error and recover on the next eligible check.
              if (enabled()) this.db.saveRunForgeRequest(run.id, projectId, run.branchName, cached?.headSha ?? null, summary, null);
              throw error;
            }
            if (!enabled()) return;
            const { checkRuns, ...statusSummary } = toProjectForgeRequestStatus(status);
            summary = { ...summary, ...statusSummary, statusLastSyncedAt: statusSummary.lastSyncedAt };
            const details = cached?.summary?.url === request.url && cached.details
              ? {
                  ...cached.details, summary, checks: checkRuns,
                  request: { ...cached.details.request, ...request, state: summary.state, draft: summary.draft },
                }
              : null;
            this.db.saveRunForgeRequest(run.id, projectId, run.branchName, summary.headSha, summary, details, {
              etag: status.etag, lastModified: status.lastModified,
            });
          } else {
            this.db.saveRunForgeRequest(run.id, projectId, run.branchName, cached?.headSha ?? null, summary, null);
          }
          this.publishRunForgeRequest(this.db.getRun(run.id), summary);
        } catch (error) {
          if (!enabled()) return;
          const message = error instanceof Error ? error.message : String(error);
          const retry = error instanceof PrReviewHttpError && error.retryAfterMs != null ? Math.max(1_000, error.retryAfterMs) : RUN_FORGE_ERROR_BACKOFF_MS[0];
          if (error instanceof PrReviewHttpError && error.retryAfterMs != null) {
            rateLimited = true;
            this.projectForgeDiscoveryRetryAt.set(projectId, Date.now() + retry);
          }
          // Deletion can race a queued/background read. Never recreate a deleted run.
          try {
            const current = this.db.getRun(run.id);
            const stale = this.db.saveRunForgeSyncError(run.id, message, new Date(Date.now() + retry).toISOString(), { branchName: run.branchName, headSha: null });
            if (stale) this.publishRunForgeRequest(current, stale);
          } catch { /* The next sweep omits deleted runs. */ }
        }
      });
    }
  }

  syncRunForgeRequestInBackground(runId: string, force: boolean): void {
    if (this.forgeStopping) return;
    let run: RunRecord;
    try { run = this.db.getRun(runId); }
    catch { return; } // Deletion may finish before a queued completion callback.
    if (this.services.forgeRequests.projectForgeIntervalMs(run.projectId) <= 0) return;
    if (force) this.services.forgeRequests.clearProjectForgeRequestListCache(run.projectId);
    this.runForgeDiscovery?.refresh(run.projectId);
  }

  private async selectRunForgeRequest(
    run: RunRecord,
    project: ProjectRecord,
    provider: RunForgeReadProvider,
    branchName: string,
    headSha: string | null,
    cached: ReturnType<BuildWardenDatabase["getRunForgeRequestCache"]>,
    preferredRequestUrl: string | undefined,
    force: boolean,
    sourceRepository: string | null,
  ): Promise<{
    selected: ProjectForgeRequestSummary | null;
    selectedStatus: ForgeRequestStatusResult | null;
  }> {
    if (preferredRequestUrl) return { selected: await provider.getRequestSummary({ prUrl: preferredRequestUrl }), selectedStatus: null };
    if (sourceRepository === null && cached?.branchName === branchName && cached.summary?.state === "open") {
      // An unresolved publishing remote is not evidence that a saved PR vanished.
      // Confirm its provider-validated URL; never guess new links by branch alone.
      return { selected: await provider.getRequestSummary({ prUrl: cached.summary.url }), selectedStatus: null };
    }
    let selected: ProjectForgeRequestSummary | null = cached?.summary &&
      sourceRepository !== null && cached.summary.sourceRepository === sourceRepository &&
      cached.branchName === branchName &&
      cached.summary.state === "open" &&
      (!preferredRequestUrl || cached.summary.url === preferredRequestUrl)
      ? {
          provider: cached.summary.provider,
          number: cached.summary.number,
          title: cached.summary.title,
          url: cached.summary.url,
          state: cached.summary.state,
          draft: cached.summary.draft,
          author: cached.summary.author,
          sourceBranch: cached.summary.sourceBranch,
          sourceRepository: cached.summary.sourceRepository,
          targetBranch: cached.summary.targetBranch,
          createdAt: cached.details?.request.createdAt ?? null,
          updatedAt: cached.summary.updatedAt,
        }
      : null;
    let selectedStatus: ForgeRequestStatusResult | null = null;
    if (selected) {
      return { selected, selectedStatus };
    }

    const requests = (await this.services.forgeRequests.loadProjectForgeRequests(run.projectId, provider, {
      state: "all", sourceBranch: branchName, ...(sourceRepository ? { sourceRepository } : {}),
    }, force)).items;
    const matchingRepository = requests.filter((request) => sourceRepository !== null && request.sourceRepository === sourceRepository);
    const exactBranch = matchingRepository
      .filter((request) => request.sourceBranch === branchName)
      .sort((left, right) => {
        const score = (request: typeof left) => {
          if (!isOpenForgeRequestState(request.state)) return 1;
          return request.targetBranch === project.baseBranch ? 3 : 2;
        };
        const scoreDelta = score(right) - score(left);
        return scoreDelta || (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
      });
    selected = preferredRequestUrl
      ? (requests.find((request) => request.url === preferredRequestUrl) ?? exactBranch[0] ?? null)
      : (exactBranch[0] ?? null);
    if (selected || !headSha) {
      return { selected, selectedStatus };
    }

    const headProbeCandidates = matchingRepository
      .filter((request) => isOpenForgeRequestState(request.state))
      .slice(0, RUN_FORGE_HEAD_PROBE_LIMIT);
    for (const candidate of headProbeCandidates) {
      const status = await provider.getRequestStatus({ prUrl: candidate.url });
      if (status.headSha?.toLowerCase() === headSha.toLowerCase()) {
        selected = candidate;
        selectedStatus = status;
        break;
      }
    }
    return { selected, selectedStatus };
  }

  async syncRunForgeRequest(
    runId: string,
    force: boolean,
    includeDetails: boolean,
    preferredRequestUrl?: string,
    automatic = false,
    onOpen = false,
  ): Promise<RunForgeRequestSummary | null> {
    const run = this.db.getRun(runId);
    if (run.workspaceVcs !== "git" || this.forgeStopping) return null;
    if (automatic && this.services.forgeRequests.projectForgeIntervalMs(run.projectId) <= 0) return this.db.getRunForgeRequestCache(runId)?.summary ?? null;
    const project = this.db.getProject(run.projectId);
    const workspacePath = this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, project);

    return this.services.forgeRequests.serializeProjectForgeSync(run.projectId, async () => {
      if (this.forgeStopping || (automatic && this.services.forgeRequests.projectForgeIntervalMs(run.projectId) <= 0)) return null;
      // A queued refresh may outlive deletion of its run.
      this.db.getRun(runId);
      const cached = this.db.getRunForgeRequestCache(runId);
      // A user's choice replaces branch matching: an unlinked run stays unlinked, a chosen request stays chosen.
      if (!preferredRequestUrl && cached?.linkSource === "none") return null;
      const requestUrl = preferredRequestUrl ?? (cached?.linkSource === "user" ? cached.summary?.url : undefined);
      if (automatic && !includeDetails && cached?.summary?.state === "merged") return cached.summary;
      const retryAfterMs = cached?.retryAfterAt ? Date.parse(cached.retryAfterAt) - Date.now() : 0;
      if (!force && cached && retryAfterMs > 0) {
        return cached.summary;
      }
      // View refreshes are throttled per session by refreshRunForgeRequest.
      // Persisted freshness must not suppress the first check after a restart:
      // the request can change while the app is closed.
      // Local runs share the project checkout. Another run can check out a
      // different branch there, so the run's persisted branch—not the current
      // checkout—must remain authoritative for Forge association.
      const useRecordedBranch = run.workspaceType === "local" && run.branchName.trim().length > 0;
      const [probedHeadSha, probedBranchName] = await Promise.all([
        (useRecordedBranch
          ? this.gitService.getBranchCommitSha(workspacePath, run.branchName)
          : this.gitService.getHeadCommitSha(workspacePath)
        ).catch(() => cached?.headSha ?? null),
        useRecordedBranch
          ? Promise.resolve(run.branchName)
          : this.gitService.getCurrentBranch(workspacePath).catch(() => run.branchName),
      ]);
      const branchName = probedBranchName.trim() || run.branchName;
      const negativeProbeStillMatches = cached?.branchName === branchName && cached.headSha === probedHeadSha;
      if (
        !force && !onOpen &&
        negativeProbeStillMatches &&
        cached?.negativeCacheUntil &&
        Date.parse(cached.negativeCacheUntil) > Date.now()
      ) return null;

      try {
        const rawProvider = await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId);
        const provider = automatic ? guardRunForgeReads(rawProvider, () => this.services.forgeRequests.projectForgeIntervalMs(run.projectId) > 0 && !this.forgeStopping) : rawProvider;
        if (automatic && this.services.forgeRequests.projectForgeIntervalMs(run.projectId) <= 0) return cached?.summary ?? null;
        const sourceRepository = await resolveRunForgeSourceRepository(this.gitService, project.repoPath, branchName, provider);
        const selection = await this.selectRunForgeRequest(
          run,
          project,
          provider,
          branchName,
          probedHeadSha,
          cached,
          requestUrl,
          force || onOpen,
          sourceRepository,
        );
        const { selected, selectedStatus } = selection;
        if (automatic && this.services.forgeRequests.projectForgeIntervalMs(run.projectId) <= 0) return cached?.summary ?? null;
        let headSha = probedHeadSha;

        if (!selected) {
          const negativeUntil = new Date(Date.now() + 60_000).toISOString();
          this.db.saveRunForgeNegativeProbe(run.id, branchName, headSha, negativeUntil);
          this.publishRunForgeRequest(run, null);
          return null;
        }

        const associationChanged = cached?.summary?.url !== selected.url;
        const shouldLoadDetails = includeDetails || !cached?.details || associationChanged;
        const previousStatus: ForgeRequestStatusResult | null = cached?.summary?.url === selected.url ? {
          state: cached.summary.state,
          draft: cached.summary.draft,
          mergeability: cached.summary.mergeability,
          reviewDecision: cached.summary.reviewDecision,
          headSha: cached.summary.headSha,
          checks: cached.details?.checks ?? [],
          unresolvedThreadCount: cached.summary.unresolvedThreadCount,
          supportedActions: cached.summary.supportedActions,
          supportedMergeMethods: cached.summary.supportedMergeMethods,
          etag: cached.etag,
          lastModified: cached.lastModified,
        } : null;
        const [status, detailResult] = await Promise.all([
          selectedStatus ? Promise.resolve(selectedStatus) : provider.getRequestStatus({
            prUrl: selected.url,
            etag: previousStatus?.etag,
            lastModified: previousStatus?.lastModified,
            previousStatus,
          }),
          shouldLoadDetails ? provider.getRequestDetails({ prUrl: selected.url }) : Promise.resolve(null),
        ]);
        headSha = status.headSha ?? headSha;
        const now = new Date().toISOString();
        const summary: RunForgeRequestSummary = {
          provider: selected.provider,
          number: selected.number,
          title: detailResult?.request.title ?? selected.title,
          url: selected.url,
          state: status.state,
          readiness: forgeReadiness(status),
          draft: status.draft,
          mergeability: status.mergeability,
          reviewDecision: status.reviewDecision,
          author: detailResult?.request.author ?? selected.author,
          sourceBranch: detailResult?.request.sourceBranch ?? selected.sourceBranch,
          sourceRepository: selected.sourceRepository ?? null,
          targetBranch: detailResult?.request.targetBranch ?? selected.targetBranch,
          headSha: status.headSha,
          checks: summarizeForgeChecks(status.checks),
          unresolvedThreadCount: status.unresolvedThreadCount,
          supportedActions: status.supportedActions,
          supportedMergeMethods: status.supportedMergeMethods,
          updatedAt: detailResult?.request.updatedAt ?? selected.updatedAt,
          lastSyncedAt: now,
          statusLastSyncedAt: now,
          stale: false,
          syncError: null,
        };
        let details: RunForgeRequestDetailsResult | null = null;
        if (detailResult) {
          details = {
            summary,
            request: detailResult.request,
            activity: detailResult.activity,
            commits: detailResult.commits,
            files: detailResult.files,
            reviewThreads: detailResult.reviewThreads,
            checks: status.checks,
            warnings: detailResult.warnings,
          };
        } else if (cached?.details && !associationChanged) {
          details = { ...cached.details, summary, checks: status.checks };
        }
        if (automatic && this.services.forgeRequests.projectForgeIntervalMs(run.projectId) <= 0) return cached?.summary ?? null;
        this.db.saveRunForgeRequest(run.id, run.projectId, branchName, headSha, summary, details, {
          etag: status.etag ?? previousStatus?.etag ?? null,
          lastModified: status.lastModified ?? previousStatus?.lastModified ?? null,
        });
        this.publishRunForgeRequest(run, summary);
        return summary;
      } catch (error) {
        if (automatic && this.services.forgeRequests.projectForgeIntervalMs(run.projectId) <= 0) return cached?.summary ?? null;
        const message = error instanceof Error ? error.message : String(error);
        const errorCount = cached?.errorCount ?? 0;
        const configuredBackoffMs = RUN_FORGE_ERROR_BACKOFF_MS[Math.min(errorCount, RUN_FORGE_ERROR_BACKOFF_MS.length - 1)]!;
        const backoffMs = error instanceof PrReviewHttpError && error.retryAfterMs != null
          ? Math.max(1_000, error.retryAfterMs)
          : configuredBackoffMs;
        const retryAfterAt = new Date(Date.now() + backoffMs).toISOString();
        const stale = this.db.saveRunForgeSyncError(run.id, message, retryAfterAt, { branchName, headSha: probedHeadSha });
        if (stale) {
          this.publishRunForgeRequest(run, stale);
        }
        return stale;
      }
    });
  }

  async getRunForgeRequestDetails(
    runId: string,
    options?: { refresh?: boolean },
  ): Promise<RunForgeRequestDetailsResult | null> {
    let cache = this.db.getRunForgeRequestCache(runId);
    if (!options?.refresh && this.services.forgeRequests.projectForgeIntervalMs(this.db.getRun(runId).projectId) <= 0) {
      return cache?.details && cache.summary ? { ...cache.details, summary: cache.summary } : null;
    }
    if (options?.refresh || !cache?.summary || !cache.details) {
      await this.syncRunForgeRequest(runId, options?.refresh === true, true, undefined, !options?.refresh);
      cache = this.db.getRunForgeRequestCache(runId);
    }
    return cache?.details && cache.summary ? { ...cache.details, summary: cache.summary } : null;
  }

  async refreshRunForgeRequest(runId: string, options?: { automatic?: boolean; onOpen?: boolean }): Promise<RunForgeRequestSummary | null> {
    if (options?.automatic) {
      const run = this.db.getRun(runId);
      const intervalMs = this.services.forgeRequests.projectForgeIntervalMs(run.projectId);
      const last = this.runForgeViewRefreshedAt.get(runId);
      const cached = this.db.getRunForgeRequestCache(runId);
      if (intervalMs <= 0 || run.workspaceVcs !== "git" || cached?.summary?.state === "merged" ||
        (!options.onOpen && last !== undefined && Date.now() - last < intervalMs)) return cached?.summary ?? null;
      const inflight = this.runForgeViewRefreshes.get(runId);
      if (inflight) return inflight;
      this.runForgeViewRefreshedAt.set(runId, Date.now());
      const refresh = this.syncRunForgeRequest(runId, false, false, undefined, true, options.onOpen === true);
      this.runForgeViewRefreshes.set(runId, refresh);
      try {
        return await refresh;
      } finally {
        if (this.runForgeViewRefreshes.get(runId) === refresh) this.runForgeViewRefreshes.delete(runId);
      }
    }
    const result = await this.syncRunForgeRequest(runId, true, false);
    const error = this.db.getRunForgeRequestCache(runId)?.syncError;
    if (!result && error) throw new Error(error);
    return result;
  }

  async getRunForgeRequestDiff(runId: string): Promise<ProjectPrMrDiffResult | null> {
    const run = this.db.getRun(runId);
    const cache = this.db.getRunForgeRequestCache(runId);
    if (!cache?.summary) return null;
    const provider = await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId);
    return provider.getRequestDiff({ prUrl: cache.summary.url });
  }

  async updateRunForgeRequest(runId: string, input: UpdateRunForgeRequestInput): Promise<RunForgeRequestSummary> {
    const run = this.db.getRun(runId);
    const cache = this.db.getRunForgeRequestCache(runId);
    if (!cache?.summary) throw new Error("This run is not linked to a pull request or merge request.");
    assertForgeUpdateSupported(cache.summary.supportedActions, input.action);
    const provider = await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId);
    await provider.updateRequest({ prUrl: cache.summary.url, action: input.action, expectedHeadSha: input.expectedHeadSha });
    const refreshed = await this.syncRunForgeRequest(runId, true, true);
    return refreshed ?? {
      ...cache.summary,
      readiness: "unavailable",
      stale: true,
      syncError: "The request was updated, but its state could not be refreshed.",
    };
  }

  async mergeRunForgeRequest(runId: string, input: MergeRunForgeRequestInput): Promise<RunForgeRequestSummary> {
    const run = this.db.getRun(runId);
    const cache = this.db.getRunForgeRequestCache(runId);
    const summary = cache?.summary;
    if (!summary) throw new Error("This run is not linked to a pull request or merge request.");
    assertForgeMergeAllowed(summary, input);
    const provider = await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId);
    await provider.mergeRequest({ prUrl: summary.url, method: input.method, expectedHeadSha: input.expectedHeadSha });
    const refreshed = await this.syncRunForgeRequest(runId, true, true);
    return refreshed ?? {
      ...summary,
      readiness: "unavailable",
      stale: true,
      syncError: "The request was merged, but its state could not be refreshed.",
    };
  }

  onRunForgeRequestChanged(listener: (payload: import("@buildwarden/shared").RunForgeRequestChangedPayload) => void): () => void {
    return this.events.subscribe("forge", listener);
  }
}
