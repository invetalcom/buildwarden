import { readProjectActivityLog, readProjectReleaseHistory, readRecentCommitLog, readTrackedProjectFiles } from "@buildwarden/git-service";
import {
  type GenerateProjectInsightInput,
  PROJECT_INSIGHT_KINDS,
  type ProjectActivityInsightData,
  type ProjectActivityQueryInput,
  type ProjectActivityQueryResult,
  type ProjectInsightKind,
  type ProjectInsightRecord,
} from "@buildwarden/shared";
import { logInfo } from "../logger";
import {
  buildProjectActivityInsight,
  parseProjectActivityLog,
  type ProjectActivityCommit,
  queryProjectActivity as queryProjectActivityCommits,
} from "../project-activity";
import { buildDependencyGraphSnapshotForProjectGraph, listDependencySourceFilesForProjectGraph } from "../project-graph-utils";
import {
  buildNarrativeBranchingInsight,
  buildProjectInsightPrompt,
  type DependencyGraphSnapshot,
  parseProjectInsightAiResponse,
  parseRecentCommitLog,
  type RepoCommitInfo,
} from "../project-insights";
import { AppService } from "./app-service";

const PROJECT_INSIGHT_AI_KINDS = new Set<ProjectInsightKind>([
  "repo-historian",
  "codebase-mood",
  "curiosity-mode",
]);

const PROJECT_ACTIVITY_CACHE_MS = 60_000;
/** A history can hold every commit of a repository, so only the most recent ones are kept. */
const PROJECT_ACTIVITY_CACHE_LIMIT = 3;

interface ProjectActivityData {
  commits: ProjectActivityCommit[];
  currentFiles: string[];
  releaseHistory: Awaited<ReturnType<typeof readProjectReleaseHistory>>;
}

/** Generates project insights and activity reports. */
export class ProjectInsightService extends AppService<"modelText"> {
  private readonly projectActivityCache = new Map<string, ProjectActivityData & { expiresAt: number }>();

  private rememberProjectActivity(repoPath: string, data: ProjectActivityData): void {
    const now = Date.now();
    this.projectActivityCache.delete(repoPath);
    const kept = [...this.projectActivityCache].filter(([, entry]) => entry.expiresAt > now).slice(1 - PROJECT_ACTIVITY_CACHE_LIMIT);
    this.projectActivityCache.clear();
    for (const [path, entry] of kept) this.projectActivityCache.set(path, entry);
    this.projectActivityCache.set(repoPath, { ...data, expiresAt: now + PROJECT_ACTIVITY_CACHE_MS });
  }

  async getProjectInsights(projectId: string): Promise<ProjectInsightRecord[]> {
    return this.db.listProjectInsights(projectId);
  }

  async queryProjectActivity(input: ProjectActivityQueryInput): Promise<ProjectActivityQueryResult> {
    const project = this.db.getProject(input.projectId);
    const groupByValues = new Set(["day", "week", "month", "contributor", "module"]);
    if (!groupByValues.has(input.groupBy)) throw new Error("Unsupported Activity grouping.");
    if (input.contributorKey !== undefined && (typeof input.contributorKey !== "string" || input.contributorKey.length > 320)) {
      throw new Error("Invalid Activity contributor filter.");
    }
    if (input.modulePath !== undefined && (typeof input.modulePath !== "string" || input.modulePath.length > 1_024)) {
      throw new Error("Invalid Activity module filter.");
    }
    for (const date of [input.dateFrom, input.dateTo]) {
      if (date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T12:00:00.000Z`)))) {
        throw new Error("Invalid Activity date filter.");
      }
    }
    if (input.dateFrom && input.dateTo && input.dateFrom > input.dateTo) throw new Error("Activity start date must not be after the end date.");
    if (input.weekday !== undefined && (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6)) {
      throw new Error("Invalid Activity weekday filter.");
    }

    const cached = this.projectActivityCache.get(project.repoPath);
    let activityData: ProjectActivityData;
    if (cached && cached.expiresAt > Date.now()) {
      activityData = cached;
    } else {
      const [activityLog, currentFiles, releaseHistory] = await Promise.all([
        readProjectActivityLog(project.repoPath),
        readTrackedProjectFiles(project.repoPath),
        readProjectReleaseHistory(project.repoPath),
      ]);
      activityData = { commits: parseProjectActivityLog(activityLog), currentFiles, releaseHistory };
      this.rememberProjectActivity(project.repoPath, activityData);
    }
    return queryProjectActivityCommits(activityData.commits, input, {
      currentFiles: activityData.currentFiles,
      releases: activityData.releaseHistory.releases,
      totalReleaseCount: activityData.releaseHistory.totalReleases,
    });
  }

  async generateProjectInsight(input: GenerateProjectInsightInput): Promise<ProjectInsightRecord> {
    if (!PROJECT_INSIGHT_KINDS.includes(input.kind)) {
      throw new Error(`Unsupported project insight kind: ${String(input.kind)}`);
    }
    const project = this.db.getProject(input.projectId);
    const kind = input.kind;
    logInfo("Starting project insight generation.", {
      projectId: project.id,
      projectName: project.name,
      repoPath: project.repoPath,
      kind,
      modelId: input.modelId ?? null,
    });

    try {
      if (kind === "activity") {
        const [activityLog, trackedFiles, releaseHistory] = await Promise.all([
          readProjectActivityLog(project.repoPath),
          readTrackedProjectFiles(project.repoPath),
          readProjectReleaseHistory(project.repoPath),
        ]);
        const commits = parseProjectActivityLog(activityLog);
        this.rememberProjectActivity(project.repoPath, { commits, currentFiles: trackedFiles, releaseHistory });
        const insight: ProjectActivityInsightData = buildProjectActivityInsight(commits, {
          currentFiles: trackedFiles,
          releases: releaseHistory.releases,
          totalReleaseCount: releaseHistory.totalReleases,
        });
        logInfo("Project activity insight built.", {
          projectId: project.id,
          commitCount: insight.summaryStats.totalCommits,
          contributorCount: insight.summaryStats.contributorCount,
          moduleCount: insight.modules.length,
          trackedFileCount: trackedFiles.length,
          releaseCount: releaseHistory.totalReleases,
          activityLogLength: activityLog.length,
        });
        return this.db.upsertProjectInsight({
          projectId: project.id,
          kind,
          title: "Activity",
          summary: `Analyzed ${String(insight.summaryStats.totalCommits)} commits by ${String(insight.summaryStats.contributorCount)} contributors across ${String(insight.modules.length)} modules.`,
          dataJson: JSON.stringify(insight),
          modelId: null,
        });
      }

      if (kind === "narrative-branching") {
        const insight = buildNarrativeBranchingInsight(this.db.listRunsForProject(project.id));
        logInfo("Narrative branching insight built.", {
          projectId: project.id,
          branchCount: insight.branches.length,
          timelineCount: insight.timeline.length,
        });
        return this.db.upsertProjectInsight({
          projectId: project.id,
          kind,
          title: "Narrative branching",
          summary: `Grouped ${String(insight.timeline.length)} runs into ${String(insight.branches.length)} active story branches.`,
          dataJson: JSON.stringify(insight),
          modelId: null,
        });
      }

      if (!PROJECT_INSIGHT_AI_KINDS.has(kind)) {
        throw new Error("Unsupported project insight kind.");
      }

      const modelId = input.modelId?.trim();
      if (!modelId) {
        throw new Error("Select a model before generating this project insight.");
      }

      const context = await this.services.modelText.resolveModelInvocationContext(modelId);
      const dependencyGraph = this.readDependencyGraphSnapshot(project.repoPath);
      const commits = await this.readRecentCommitInfo(project.repoPath, 120);
      const runs = this.db.listRunsForProject(project.id);
      const prompt = buildProjectInsightPrompt(project, kind, {
        dependencyGraph,
        commits,
        runs,
      });
      logInfo("Submitting AI-backed project insight request.", {
        projectId: project.id,
        kind,
        modelId: context.model.id,
        moduleCount: dependencyGraph.modules.length,
        commitCount: commits.length,
        runCount: runs.length,
        promptLength: prompt.length,
      });
      const raw = await this.services.modelText.askModelForText(project.repoPath, context, {
        prompt,
        systemPrompt: "You analyze software repositories and return valid JSON only, with no markdown fences or extra commentary.",
        maxTokens: 1_600,
        temperature: 0.2,
        usageProjectId: project.id,
      });
      const parsed = parseProjectInsightAiResponse(kind, raw);
      logInfo("AI-backed project insight parsed successfully.", {
        projectId: project.id,
        kind,
        modelId: context.model.id,
        title: parsed.title,
        summaryLength: parsed.summary.length,
        rawLength: raw.length,
      });
      return this.db.upsertProjectInsight({
        projectId: project.id,
        kind,
        title: parsed.title,
        summary: parsed.summary,
        dataJson: JSON.stringify(parsed.data),
        modelId: context.model.id,
      });
    } catch (error) {
      this.logControllerError("Project insight generation failed.", error, {
        projectId: project.id,
        kind,
        modelId: input.modelId ?? null,
        repoPath: project.repoPath,
      });
      throw error;
    }
  }

  private readDependencyGraphSnapshot(repoPath: string): DependencyGraphSnapshot {
    const sourceFiles = listDependencySourceFilesForProjectGraph(repoPath);
    logInfo("Collected dependency graph source files.", {
      repoPath,
      sourceFileCount: sourceFiles.length,
    });
    if (sourceFiles.length === 0) {
      this.logControllerWarn("No source files were found for dependency graph generation.", { repoPath });
    }
    const snapshot = buildDependencyGraphSnapshotForProjectGraph(repoPath);
    logInfo("Built dependency graph snapshot.", {
      repoPath,
      moduleCount: snapshot.modules.length,
      dependencyEdgeCount: snapshot.modules.reduce((sum, module) => sum + module.dependencies.length, 0),
    });
    return snapshot;
  }

  async readRecentCommitInfo(repoPath: string, limit: number, ref?: string): Promise<RepoCommitInfo[]> {
    let output: string;
    try {
      output = await readRecentCommitLog(repoPath, limit, ref);
    } catch (error) {
      this.logControllerWarn("git log failed while collecting project insight commit history.", {
        repoPath,
        limit,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }

    const commits = parseRecentCommitLog(output);
    logInfo("Collected recent commit info for project insight generation.", {
      repoPath,
      limit,
      commitCount: commits.length,
    });
    return commits;
  }
}
