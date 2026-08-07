import {
  APP_SETTING_KEYS,
  getAiSdkProviderFamilyFromConfigJson,
  type AppSnapshot,
  type HarnessType,
  type ModelExecutionProfile,
  type ProjectSnapshot,
  type ProviderType,
  type RunRecord,
  type UnifiedProviderFamily,
} from "@buildwarden/shared";
import {
  PROVIDER_TYPE_LABELS,
  buildModelExecutionProfile,
  harnessTypeForProvider,
  isRunDisplayStatusActive,
  parseSearchTerms,
  recentRunOrderTimestamp,
  resolveRunDisplayStatus,
  runMatchesSearch,
} from "@buildwarden/renderer/logic";

/**
 * Flat, phone-friendly views over the snapshot.
 *
 * The desktop sidebar renders a project tree with several parallel run buckets. A phone list has
 * no room for that, so runs are flattened, deduplicated and filtered by intent ("what needs me",
 * "what is running") instead of by which snapshot array they arrived in.
 */

export interface RunListItem {
  run: RunRecord;
  project: ProjectSnapshot;
}

export const RUN_FILTERS = ["attention", "active", "all", "done", "for-later"] as const;
export type RunFilter = (typeof RUN_FILTERS)[number];

export const RUN_FILTER_LABELS: Record<RunFilter, string> = {
  attention: "Needs me",
  active: "Running",
  all: "All",
  done: "Finished",
  "for-later": "For later",
};

const collectProjectRuns = (project: ProjectSnapshot): RunRecord[] => {
  const byId = new Map<string, RunRecord>();
  for (const run of [...project.activeRuns, ...project.runs, ...project.recentRuns, ...project.forLaterRuns]) {
    if (!byId.has(run.id)) byId.set(run.id, run);
  }
  return [...byId.values()];
};

export const flattenRuns = (projects: readonly ProjectSnapshot[]): RunListItem[] =>
  projects
    .flatMap((project) => collectProjectRuns(project).map((run) => ({ run, project })))
    .sort((left, right) => recentRunOrderTimestamp(right.run) - recentRunOrderTimestamp(left.run));

export const isActiveRun = (run: RunRecord): boolean =>
  isRunDisplayStatusActive(resolveRunDisplayStatus(run.status, run.orchestrationStatus ?? null));

/** A run that cannot progress without the user: a pending question or an orchestration escalation. */
export const needsAttention = (run: RunRecord): boolean =>
  Boolean(run.pendingUserInputRequest) || run.orchestrationStatus === "attention";

export const matchesRunFilter = (run: RunRecord, filter: RunFilter): boolean => {
  const forLater = run.listVisibility === "for-later";
  switch (filter) {
    case "attention":
      return needsAttention(run) && !forLater;
    case "active":
      return isActiveRun(run) && !forLater;
    case "done":
      return !isActiveRun(run) && !forLater;
    case "for-later":
      return forLater;
    case "all":
      return !forLater;
  }
};

/**
 * Prompt/goal matching reuses the desktop search semantics; branch, summary and project name are
 * additionally searchable because on a phone they are often all the user remembers.
 */
export const runMatchesQuery = (item: RunListItem, terms: string[]): boolean => {
  if (terms.length === 0) return true;
  if (runMatchesSearch(item.run, terms)) return true;
  const extra = [item.run.branchName, item.run.summary ?? "", item.project.project.name].join("\n").toLocaleLowerCase();
  return terms.every((term) => extra.includes(term));
};

export const filterRuns = (items: readonly RunListItem[], filter: RunFilter, query: string): RunListItem[] => {
  const terms = parseSearchTerms(query);
  return items.filter((item) => matchesRunFilter(item.run, filter) && runMatchesQuery(item, terms));
};

export const countRunsNeedingAttention = (projects: readonly ProjectSnapshot[]): number =>
  flattenRuns(projects).filter((item) => needsAttention(item.run)).length;

export const findProject = (snapshot: AppSnapshot, projectId: string | null): ProjectSnapshot | null =>
  (projectId ? snapshot.projects.find((entry) => entry.project.id === projectId) : null) ?? null;

/** The project a fresh session should land on: the last selected one, else the first. */
export const defaultProjectId = (snapshot: AppSnapshot): string | null =>
  (snapshot.selectedProjectId && snapshot.projects.some((entry) => entry.project.id === snapshot.selectedProjectId)
    ? snapshot.selectedProjectId
    : snapshot.projects[0]?.project.id) ?? null;

export const modelLabel = (snapshot: AppSnapshot, modelId: string | null | undefined): string => {
  if (!modelId) return "—";
  const model = snapshot.models.find((entry) => entry.id === modelId);
  return model?.displayName || model?.modelId || modelId;
};

export interface RunModelOption {
  modelId: string;
  label: string;
  providerAccountId: string;
  providerType: ProviderType;
  providerLabel: string;
  harnessType: HarnessType;
  providerFamily: UnifiedProviderFamily | null;
  executionProfile: ModelExecutionProfile;
}

/** Every enabled model paired with the provider wiring `createRun` needs. */
export const runModelOptions = (snapshot: AppSnapshot): RunModelOption[] =>
  snapshot.models.flatMap((model) => {
    const account = snapshot.providerAccounts.find((entry) => entry.id === model.providerAccountId);
    if (!account || model.enabled === 0) return [];
    const providerFamily = account.providerType === "ai-sdk" ? getAiSdkProviderFamilyFromConfigJson(account.configJson) : null;
    return [{
      modelId: model.id,
      label: model.displayName || model.modelId,
      providerAccountId: account.id,
      providerType: account.providerType,
      providerLabel: account.label || PROVIDER_TYPE_LABELS[account.providerType],
      harnessType: harnessTypeForProvider(account.providerType),
      providerFamily,
      executionProfile: buildModelExecutionProfile(account.providerType, providerFamily, model.modelId, model.configJson),
    }];
  });

/** Last used model when it is still configured, otherwise the first available one. */
export const defaultRunModel = (snapshot: AppSnapshot): RunModelOption | null => {
  const options = runModelOptions(snapshot);
  const lastUsed = snapshot.settings[APP_SETTING_KEYS.lastUsedRunModelId];
  return options.find((option) => option.modelId === lastUsed) ?? options[0] ?? null;
};
