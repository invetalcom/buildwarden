/**
 * Presentation-free logic shared between the desktop renderer UI and the mobile web UI
 * (`apps/web/src/mobile`). Everything re-exported here must stay free of JSX and of any
 * dependency on desktop components, so a second UI can reuse run/diff/status semantics
 * without reusing desktop templates.
 *
 * Consumed as `@buildwarden/renderer/logic`. Additive only — this file adds a second
 * entry point and never changes what `./index.ts` exposes to the desktop app.
 */

export {
  EMPTY_SNAPSHOT,
  buildModelExecutionProfile,
  buildRunReasoningInput,
  findProjectRun,
  harnessTypeForProvider,
  isRunContinuable,
  latestRunTokenUsage,
  pickProjectBranch,
  readRunTokenUsage,
  resolveRunModelConfiguration,
  resolveProviderComposerPrompt,
  snapshotContainsRunId,
  type RunReasoningInput,
} from "./components/app/app-model";

export {
  RUN_DISPLAY_STATUS_LABELS,
  isRunDisplayStatusActive,
  resolveRunDisplayStatus,
  runDisplayStatusTone,
  type RunDisplayStatus,
} from "./components/app/run-display-status";

export {
  buildActivityEntries,
  buildTimelineRenderItems,
  deriveRunSubagents,
  describeActivityDetail,
  describeToolTarget,
  getLatestPlanDecisionText,
  isRunCompletionStatus,
  readUserInputAnswers,
  readUserInputQuestions,
  shouldAutoCollapseReasoning,
  type ActivityEntry,
  type RunActivityRun,
  type RunActivityStep,
  type SingleActivityEntry,
  type SubagentActivityEntry,
  type TimelineRenderItem,
} from "./components/app/run-activity-model";

export { recentRunOrderTimestamp } from "./components/app/sidebar-run-ordering";

export {
  countChangedFilesInDiff,
  diffFileMatchesPath,
  diffFileMatchesQuery,
  looksLikeGitDiff,
  normalizeDiffPathSegment,
  parseGitDiffFiles,
  summarizeDiffStats,
  type GitDiffFileStat,
} from "./components/app/git-diff-utils";

export { PROVIDER_TYPE_LABELS } from "./components/app/provider-model-labels";
export type { ProjectPageTab } from "./components/app/project-page-tabs";
export {
  getStoredAttachmentRenderMode,
  getStoredAttachmentTextPreview,
  groupStoredAttachments,
  inferStoredAttachmentKind,
  type StoredAttachmentDisplayItem,
  type StoredAttachmentKind,
  type StoredAttachmentRenderMode,
} from "./components/app/stored-chat-attachment-utils";

export { deriveLatestRunPlanProgress, type DerivedRunPlanProgress } from "./lib/run-plan-progress";
export { parseSearchTerms, runMatchesSearch, type RunSearchFields } from "./lib/run-search";
export { bookmarkModelDisplay } from "./lib/bookmark-model";
export { APP_VERSION, APP_VERSION_DATE } from "./lib/app-build-meta";
export {
  buildRunForgeAgentPrompt,
  runForgeReadinessLabel,
  type RunForgeAgentAction,
} from "./components/app/run-forge-ui";
