import type { NarrativeBranchingInsightData, ProjectInsightData, ProjectInsightKind, ProjectRecord, RunRecord } from "@buildwarden/shared";
import { normalizeProjectInsightRepoPath, shouldIgnoreProjectInsightPath } from "./project-graph-utils";
import { normalizeJsonResponse } from "./json-response";

const MAX_PROJECT_INSIGHT_PROMPT_CHARS = 20_000;

export type RepoCommitInfo = {
  sha: string;
  author: string;
  date: string;
  title: string;
  files: string[];
};

export const parseRecentCommitLog = (output: string): RepoCommitInfo[] => {
  const commits: RepoCommitInfo[] = [];
  let current: RepoCommitInfo | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("__EC__")) {
      if (current) commits.push(current);
      const [, sha = "", author = "", date = "", title = ""] = line.split("\t");
      current = { sha: sha.replace(/^__EC__/, ""), author: author.trim(), date: date.trim(), title: title.trim(), files: [] };
      continue;
    }
    if (current) {
      const normalized = normalizeProjectInsightRepoPath(line);
      if (!shouldIgnoreProjectInsightPath(normalized)) current.files.push(normalized);
    }
  }
  if (current) commits.push(current);
  return commits;
};

type RepoFileHotspot = {
  path: string;
  commitCount: number;
  ownerLabel: string | null;
};

export type DependencyGraphSnapshot = {
  modules: Array<{
    source: string;
    dependencies: Array<{
      resolved: string | null;
    }>;
  }>;
};

export const clampReviewScore = (value: unknown): number => {
  const score = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(score)));
};

export function buildNarrativeBranchingInsight(runs: RunRecord[]): NarrativeBranchingInsightData {
  const branchMap = new Map<
    string,
    {
      branchName: string;
      runCount: number;
      statuses: Set<string>;
      latestRunId: string | null;
      latestUpdatedAt: string | null;
      prompts: string[];
    }
  >();

  const timeline = runs
    .map((run) => ({
      runId: run.id,
      branchName: run.branchName,
      status: run.status,
      createdAt: run.createdAt,
      title: run.prompt,
    }))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

  for (const run of runs) {
    const existing =
      branchMap.get(run.branchName) ??
      {
        branchName: run.branchName,
        runCount: 0,
        statuses: new Set<string>(),
        latestRunId: null,
        latestUpdatedAt: null,
        prompts: [],
      };
    existing.runCount += 1;
    existing.statuses.add(run.status);
    if (!existing.latestUpdatedAt || new Date(run.updatedAt).getTime() > new Date(existing.latestUpdatedAt).getTime()) {
      existing.latestUpdatedAt = run.updatedAt;
      existing.latestRunId = run.id;
    }
    if (run.prompt.trim()) {
      existing.prompts.push(run.prompt.trim());
    }
    branchMap.set(run.branchName, existing);
  }

  return {
    branches: [...branchMap.values()]
      .map((branch) => ({
        branchName: branch.branchName,
        summary:
          branch.prompts[0] ??
          `Run branch ${branch.branchName} with ${String(branch.runCount)} recorded agent runs.`,
        runCount: branch.runCount,
        statuses: [...branch.statuses],
        latestRunId: branch.latestRunId,
        latestUpdatedAt: branch.latestUpdatedAt,
        prompts: branch.prompts.slice(0, 5),
      }))
      .sort((left, right) =>
        new Date(right.latestUpdatedAt ?? 0).getTime() - new Date(left.latestUpdatedAt ?? 0).getTime(),
      ),
    timeline,
  };
}

export function buildProjectInsightPrompt(
  project: ProjectRecord,
  kind: ProjectInsightKind,
  context: {
    dependencyGraph: DependencyGraphSnapshot;
    commits: RepoCommitInfo[];
    runs: RunRecord[];
  },
): string {
  const dependencySummary = buildDependencySummaryText(context.dependencyGraph, context.commits);
  const commitSummary = context.commits
    .slice(0, 18)
    .map((commit) => `- ${commit.date} ${commit.sha.slice(0, 7)} ${commit.author}: ${commit.title} (${commit.files.slice(0, 4).join(", ") || "no files"})`)
    .join("\n");
  const runSummary = context.runs
    .slice(0, 16)
    .map((run) => `- ${run.createdAt} [${run.status}] ${run.branchName}: ${run.prompt}`)
    .join("\n");

  if (kind === "repo-historian") {
    return [
      "Return JSON only with this exact shape:",
      '{ "title": "Repo historian", "summary": "short summary", "synopsis": "2-4 sentences", "sections": [{"title":"string","detail":"string"}], "notableCommits": [{"sha":"string","title":"string","author":"string","date":"string"}] }',
      "",
      "Task: explain why this subsystem/repo likely looks the way it does by reading the recent history and structural signals.",
      "Focus on architectural drift, repeated themes, and how the current shape may have emerged.",
      "",
      `Project: ${project.name}`,
      "Dependency summary:",
      dependencySummary,
      "",
      "Recent commits:",
      commitSummary || "(no recent commits found)",
      "",
      "Recent BuildWarden runs:",
      runSummary || "(no runs found)",
    ].join("\n");
  }

  if (kind === "codebase-mood") {
    return [
      "Return JSON only with this exact shape:",
      '{ "title": "Codebase mood", "summary": "short summary", "overallScore": 0, "posture": "string", "sections": [{"label":"string","score":0,"summary":"string"}], "findings": [{"title":"string","detail":"string","filePath":"string|null"}], "nextMoves": ["string"] }',
      "",
      "Task: assess whether this codebase feels brittle, overabstracted, under-tested, or inconsistent, and explain why.",
      "Use the provided dependency and history evidence. Be concrete and opinionated.",
      "",
      `Project: ${project.name}`,
      "Dependency summary:",
      dependencySummary,
      "",
      "Recent commits:",
      commitSummary || "(no recent commits found)",
    ].join("\n");
  }

  return [
    "Return JSON only with this exact shape:",
    '{ "title": "Curiosity mode", "summary": "short summary", "themes": [{"title":"string","whyItMatters":"string","evidence":["string"]}], "suggestedPrompts": ["string"] }',
    "",
    "Task: identify confusing, interesting, or potentially high-leverage areas worth exploring next in this repository.",
    "Surface surprising themes, hidden coupling, or unexplained design pockets.",
    "",
    `Project: ${project.name}`,
    "Dependency summary:",
    dependencySummary,
    "",
    "Recent commits:",
    commitSummary || "(no recent commits found)",
    "",
    "Recent BuildWarden runs:",
    runSummary || "(no runs found)",
  ].join("\n");
}

type InsightRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is InsightRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const records = (value: unknown): InsightRecord[] => Array.isArray(value) ? value.filter(isRecord) : [];
const textValue = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const textValues = (value: unknown): string[] => Array.isArray(value) ? value.map(textValue).filter(Boolean) : [];
const titledDetails = (value: unknown) => records(value)
  .map((entry) => ({ title: textValue(entry.title), detail: textValue(entry.detail) }))
  .filter((entry) => entry.title && entry.detail);

type ParsedInsight = { title: string; summary: string; data: ProjectInsightData };

const parseHistorianInsight = (parsed: InsightRecord): ParsedInsight => ({
  title: textValue(parsed.title) || "Repo historian",
  summary: textValue(parsed.summary) || "Repository history summary generated.",
  data: {
    synopsis: textValue(parsed.synopsis) || "No synopsis returned.",
    sections: titledDetails(parsed.sections),
    notableCommits: records(parsed.notableCommits).map((entry) => ({
      sha: textValue(entry.sha), title: textValue(entry.title),
      author: textValue(entry.author), date: textValue(entry.date),
    })).filter((commit) => commit.sha && commit.title),
  },
});

const parseMoodInsight = (parsed: InsightRecord): ParsedInsight => ({
  title: textValue(parsed.title) || "Codebase mood",
  summary: textValue(parsed.summary) || "Codebase mood generated.",
  data: {
    overallScore: clampReviewScore(parsed.overallScore),
    posture: textValue(parsed.posture) || "Mixed",
    sections: records(parsed.sections).map((entry) => ({
      label: textValue(entry.label), score: clampReviewScore(entry.score), summary: textValue(entry.summary),
    })).filter((entry) => entry.label && entry.summary),
    findings: records(parsed.findings).map((entry) => ({
      title: textValue(entry.title), detail: textValue(entry.detail), filePath: textValue(entry.filePath) || null,
    })).filter((entry) => entry.title && entry.detail),
    nextMoves: textValues(parsed.nextMoves),
  },
});

const parseCuriosityInsight = (parsed: InsightRecord): ParsedInsight => ({
  title: textValue(parsed.title) || "Curiosity mode",
  summary: textValue(parsed.summary) || "Curiosity scan generated.",
  data: {
    themes: records(parsed.themes).map((entry) => ({
      title: textValue(entry.title), whyItMatters: textValue(entry.whyItMatters), evidence: textValues(entry.evidence),
    })).filter((entry) => entry.title && entry.whyItMatters),
    suggestedPrompts: textValues(parsed.suggestedPrompts),
  },
});

export function parseProjectInsightAiResponse(kind: ProjectInsightKind, raw: string): ParsedInsight {
  const normalized = normalizeJsonResponse(raw).slice(0, MAX_PROJECT_INSIGHT_PROMPT_CHARS * 2);
  let parsed: InsightRecord = {};
  try {
    const value: unknown = JSON.parse(normalized);
    if (isRecord(value)) parsed = value;
  } catch {
    // Invalid model output uses the same defaults as an empty object.
  }
  if (kind === "repo-historian") return parseHistorianInsight(parsed);
  if (kind === "codebase-mood") return parseMoodInsight(parsed);
  return parseCuriosityInsight(parsed);
}

export function buildDependencySummaryText(dependencyGraph: DependencyGraphSnapshot, commits: RepoCommitInfo[]): string {
  const metrics = [...buildModuleMetrics(dependencyGraph, commits).values()];
  const averageInbound = metrics.length === 0 ? 0 : Math.round((metrics.reduce((sum, entry) => sum + entry.inbound, 0) / metrics.length) * 10) / 10;
  const topGravity = [...metrics]
    .sort((left, right) => right.gravityScore - left.gravityScore || right.inbound - left.inbound)
    .slice(0, 6)
    .map((node) => `- ${node.path} (gravity ${String(node.gravityScore)}, inbound ${String(node.inbound)}, outbound ${String(node.outbound.size)})`)
    .join("\n");
  const hotspots = [...buildHotspotMap(commits).values()]
    .sort((left, right) => right.commitCount - left.commitCount)
    .slice(0, 5)
    .map((item) => {
      const ownerSuffix = item.ownerLabel ? `, owner ${item.ownerLabel}` : "";
      return `- ${item.path} (${String(item.commitCount)} recent commits${ownerSuffix})`;
    })
    .join("\n");
  return [
    `Total modules: ${String(metrics.length)}`,
    `Total edges: ${String(metrics.reduce((sum, entry) => sum + entry.outbound.size, 0))}`,
    `Average inbound references: ${String(averageInbound)}`,
    "Top dependency gravity:",
    topGravity || "- none",
    "Recent hotspots:",
    hotspots || "- none",
  ]
    .join("\n")
    .slice(0, MAX_PROJECT_INSIGHT_PROMPT_CHARS);
}

function buildModuleMetrics(dependencyGraph: DependencyGraphSnapshot, commits: RepoCommitInfo[]) {
  const hotspotMap = buildHotspotMap(commits);
  const metrics = new Map<
    string,
    {
      path: string;
      inbound: number;
      outbound: Set<string>;
      gravityScore: number;
      hotspotCommits: number;
    }
  >();
  const ensureMetric = (path: string) => {
    const normalizedPath = normalizeProjectInsightRepoPath(path);
    const existing = metrics.get(normalizedPath);
    if (existing) {
      return existing;
    }
    const hotspot = hotspotMap.get(normalizedPath);
    const created = {
      path: normalizedPath,
      inbound: 0,
      outbound: new Set<string>(),
      gravityScore: 0,
      hotspotCommits: hotspot?.commitCount ?? 0,
    };
    metrics.set(normalizedPath, created);
    return created;
  };

  for (const module of dependencyGraph.modules) {
    const source = ensureMetric(module.source);
    for (const dependency of module.dependencies) {
      const resolved = dependency.resolved ? ensureMetric(dependency.resolved) : null;
      if (!resolved || resolved.path === source.path) {
        continue;
      }
      source.outbound.add(resolved.path);
      resolved.inbound += 1;
    }
  }

  for (const metric of metrics.values()) {
    metric.gravityScore = metric.inbound * 3 + metric.outbound.size + Math.min(metric.hotspotCommits, 12);
  }
  return metrics;
}

function buildHotspotMap(commits: RepoCommitInfo[]): Map<string, RepoFileHotspot> {
  const byFile = new Map<string, RepoFileHotspot & { ownerCounts: Map<string, number> }>();
  for (const commit of commits) {
    for (const file of commit.files) {
      const existing =
        byFile.get(file) ??
        {
          path: file,
          commitCount: 0,
          ownerLabel: null,
          ownerCounts: new Map<string, number>(),
        };
      existing.commitCount += 1;
      existing.ownerCounts.set(commit.author, (existing.ownerCounts.get(commit.author) ?? 0) + 1);
      byFile.set(file, existing);
    }
  }
  for (const entry of byFile.values()) {
    entry.ownerLabel =
      [...entry.ownerCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  }
  return new Map(
    [...byFile.entries()].map(([path, value]) => [
      path,
      {
        path,
        commitCount: value.commitCount,
        ownerLabel: value.ownerLabel,
      },
    ]),
  );
}
