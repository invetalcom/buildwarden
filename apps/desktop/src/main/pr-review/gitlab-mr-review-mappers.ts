import type {
  ProjectForgeActivityItem,
  ProjectForgeChangedFileStatus,
  ProjectForgeChangedFileSummary,
  ProjectForgeCommitSummary,
  ProjectForgeRequestDetails,
  ProjectForgeRequestState,
  ProjectForgeRequestSummary,
  ProjectForgeReviewThread,
  ProjectForgeReviewThreadComment,
  ProjectPrMrDiffComment,
  RunForgeCheck,
} from "@buildwarden/shared";
import type { ForgeRequestStatusResult, GitlabDiffRefs } from "./pr-review-types";
import { isRecord, recordBoolean, recordNumber, recordObject, recordString } from "./pr-review-utils";

export const gitlabRequestState = (state: ProjectForgeRequestState | undefined): "opened" | "closed" | "merged" | "all" => {
  if (state === "closed" || state === "merged" || state === "all") {
    return state;
  }
  return "opened";
};

export const mapGitlabRequestSummary = (record: Record<string, unknown>): ProjectForgeRequestSummary | null => {
  const number = recordNumber(record, "iid");
  const title = recordString(record, "title");
  const url = recordString(record, "web_url");
  if (!number || !title || !url) {
    return null;
  }
  const author = recordObject(record, "author");
  return {
    provider: "gitlab",
    number,
    title,
    url,
    state: recordString(record, "state") ?? "unknown",
    draft: recordBoolean(record, "draft") || recordBoolean(record, "work_in_progress"),
    author: author ? (recordString(author, "username") ?? recordString(author, "name")) : null,
    sourceBranch: recordString(record, "source_branch") ?? "",
    targetBranch: recordString(record, "target_branch") ?? "",
    createdAt: recordString(record, "created_at"),
    updatedAt: recordString(record, "updated_at"),
  };
};

export const gitlabUserSummary = (record: Record<string, unknown> | null): ProjectForgeActivityItem["author"] => {
  if (!record) {
    return null;
  }
  const username = recordString(record, "username") ?? recordString(record, "name");
  if (!username) {
    return null;
  }
  return {
    username,
    name: recordString(record, "name"),
    avatarUrl: recordString(record, "avatar_url"),
    webUrl: recordString(record, "web_url"),
  };
};

export const gitlabLabels = (record: Record<string, unknown>): string[] => {
  const labels = record.labels;
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      return isRecord(entry) ? recordString(entry, "name") : null;
    })
    .filter((entry): entry is string => Boolean(entry));
};

export const mapGitlabRequestDetails = (record: Record<string, unknown>): ProjectForgeRequestDetails | null => {
  const summary = mapGitlabRequestSummary(record);
  if (!summary) {
    return null;
  }
  const changesCount = recordString(record, "changes_count");
  return {
    ...summary,
    description: recordString(record, "description") ?? "",
    authorUser: gitlabUserSummary(recordObject(record, "author")),
    labels: gitlabLabels(record),
    additions: null,
    deletions: null,
    changedFiles: changesCount ? Number(changesCount.replace(/\+$/g, "")) || null : null,
    commentCount: recordNumber(record, "user_notes_count"),
    reviewCommentCount: null,
  };
};

export const firstLine = (value: string) => value.split(/\r?\n/, 1)[0]?.trim() || value.trim();

export const mapGitlabCommitSummary = (record: Record<string, unknown>): ProjectForgeCommitSummary | null => {
  const sha = recordString(record, "id");
  const message = recordString(record, "message") ?? recordString(record, "title") ?? "";
  if (!sha) {
    return null;
  }
  return {
    sha,
    shortSha: recordString(record, "short_id") ?? sha.slice(0, 8),
    title: recordString(record, "title") ?? firstLine(message),
    message,
    authorName: recordString(record, "author_name"),
    authorEmail: recordString(record, "author_email"),
    authorUser: null,
    committerName: recordString(record, "committer_name"),
    committedAt: recordString(record, "committed_date") ?? recordString(record, "created_at"),
    authoredAt: recordString(record, "authored_date"),
    url: recordString(record, "web_url"),
    commentCount: null,
  };
};

export const gitlabChangedFileStatus = (record: Record<string, unknown>): ProjectForgeChangedFileStatus => {
  if (recordBoolean(record, "new_file")) return "added";
  if (recordBoolean(record, "deleted_file")) return "removed";
  if (recordBoolean(record, "renamed_file")) return "renamed";
  return "modified";
};

export const mapGitlabChangedFileSummary = (record: Record<string, unknown>): ProjectForgeChangedFileSummary | null => {
  const path = recordString(record, "new_path") ?? recordString(record, "old_path");
  if (!path) {
    return null;
  }
  return {
    path,
    oldPath: recordString(record, "old_path"),
    status: gitlabChangedFileStatus(record),
    additions: null,
    deletions: null,
    patchAvailable: Boolean(recordString(record, "diff")) && !recordBoolean(record, "too_large"),
    commentCount: 0,
  };
};

export const activityTimestamp = (item: ProjectForgeActivityItem): string => item.createdAt ?? item.updatedAt ?? "";

export const sortActivity = (items: ProjectForgeActivityItem[]) =>
  [...items].sort((left, right) => activityTimestamp(left).localeCompare(activityTimestamp(right)));

export const onlyRecords = (items: unknown[]): Record<string, unknown>[] =>
  items.filter((entry): entry is Record<string, unknown> => isRecord(entry));

export const extractGitlabDiffRefs = (record: Record<string, unknown>): GitlabDiffRefs | null => {
  const baseSha = recordString(record, "base_sha") ?? recordString(record, "base_commit_sha");
  const startSha = recordString(record, "start_sha") ?? recordString(record, "start_commit_sha");
  const headSha = recordString(record, "head_sha") ?? recordString(record, "head_commit_sha");
  if (!baseSha || !startSha || !headSha) {
    return null;
  }
  return { baseSha, startSha, headSha };
};

export const gitlabThreadComment = (note: Record<string, unknown>): ProjectForgeReviewThreadComment => {
  const id = recordNumber(note, "id") ?? crypto.randomUUID();
  return {
    id: `gitlab-discussion-note-${String(id)}`,
    providerCommentId: String(id),
    body: recordString(note, "body") ?? "",
    author: gitlabUserSummary(recordObject(note, "author")),
    createdAt: recordString(note, "created_at"),
    updatedAt: recordString(note, "updated_at"),
    url: null,
  };
};

export const buildGitlabReviewThread = (
  discussion: Record<string, unknown>,
  notesList: Record<string, unknown>[],
  fallbackIndex: number,
): ProjectForgeReviewThread | null => {
  const positionedNote = notesList.find((note) => recordObject(note, "position"));
  const position = positionedNote ? recordObject(positionedNote, "position") : null;
  if (!position) {
    return null;
  }
  const path = recordString(position, "new_path") ?? recordString(position, "old_path");
  const oldLine = recordNumber(position, "old_line");
  const newLine = recordNumber(position, "new_line");
  if (!path || (!oldLine && !newLine)) {
    return null;
  }
  return {
    id: `gitlab-thread-${recordString(discussion, "id") ?? String(fallbackIndex)}`,
    providerThreadId: recordString(discussion, "id") ?? String(fallbackIndex),
    replyToCommentId: null,
    provider: "gitlab",
    path,
    oldPath: recordString(position, "old_path"),
    side: newLine ? "new" : "old",
    oldLineNumber: oldLine,
    newLineNumber: newLine,
    commitSha: recordString(position, "head_sha"),
    diffHunk: null,
    resolved: recordBoolean(discussion, "resolved") || notesList.some((note) => recordBoolean(note, "resolved")),
    comments: notesList.map(gitlabThreadComment),
  };
};

export const quoteDiffPath = (path: string) => path.replace(/\\/g, "/");

export const gitlabDiffRowToUnifiedDiff = (row: Record<string, unknown>): string | null => {
  const oldPath = recordString(row, "old_path") ?? recordString(row, "new_path") ?? "unknown";
  const newPath = recordString(row, "new_path") ?? oldPath;
  const diff = recordString(row, "diff") ?? "";
  if (!diff.trim()) return null;
  if (diff.startsWith("diff --git")) return diff.trimEnd();
  const renamed = recordBoolean(row, "renamed_file") && oldPath !== newPath;
  const oldDisplay = recordBoolean(row, "new_file") ? "/dev/null" : `a/${quoteDiffPath(oldPath)}`;
  const newDisplay = recordBoolean(row, "deleted_file") ? "/dev/null" : `b/${quoteDiffPath(newPath)}`;
  const header = [
    `diff --git a/${quoteDiffPath(oldPath)} b/${quoteDiffPath(newPath)}`,
    recordBoolean(row, "new_file") ? "new file mode 100644" : null,
    recordBoolean(row, "deleted_file") ? "deleted file mode 100644" : null,
    renamed ? `rename from ${quoteDiffPath(oldPath)}` : null,
    renamed ? `rename to ${quoteDiffPath(newPath)}` : null,
    `--- ${oldDisplay}`,
    `+++ ${newDisplay}`,
  ].filter((line): line is string => Boolean(line));
  return `${header.join("\n")}\n${diff.trimEnd()}`;
};

export const gitlabDiffRowsToUnifiedDiff = (rows: Record<string, unknown>[]): string => {
  return rows.map(gitlabDiffRowToUnifiedDiff).filter((section): section is string => Boolean(section)).join("\n");
};

export const toGitlabDiscussionPosition = (comment: ProjectPrMrDiffComment, refs: GitlabDiffRefs): Record<string, unknown> => {
  const position: Record<string, unknown> = {
    position_type: "text",
    base_sha: refs.baseSha,
    start_sha: refs.startSha,
    head_sha: refs.headSha,
    old_path: comment.oldPath || comment.newPath,
    new_path: comment.newPath || comment.oldPath,
  };

  if (comment.changeType === "normal") {
    if (!comment.oldLineNumber || !comment.newLineNumber) {
      throw new Error("A draft comment could not be mapped to a GitLab context line.");
    }
    position.old_line = comment.oldLineNumber;
    position.new_line = comment.newLineNumber;
    return position;
  }

  if (comment.side === "old") {
    if (!comment.oldLineNumber) {
      throw new Error("A draft comment could not be mapped to a GitLab old diff line.");
    }
    position.old_line = comment.oldLineNumber;
  } else {
    if (!comment.newLineNumber) {
      throw new Error("A draft comment could not be mapped to a GitLab new diff line.");
    }
    position.new_line = comment.newLineNumber;
  }

  return position;
};

export const gitlabCheckStatus = (status: string | null): RunForgeCheck["status"] => {
  switch (status?.toLowerCase()) {
    case "created":
    case "waiting_for_resource":
    case "preparing":
    case "scheduled":
    case "pending": return "queued";
    case "canceling":
    case "running": return "running";
    case "success": return "success";
    case "skipped":
    case "manual": return "skipped";
    case "canceled": return "cancelled";
    default: return "failure";
  }
};

export const gitlabDurationMs = (record: Record<string, unknown>): number | null => {
  const seconds = recordNumber(record, "duration");
  if (seconds != null && seconds >= 0) return Math.round(seconds * 1000);
  const startedAt = recordString(record, "started_at");
  const finishedAt = recordString(record, "finished_at");
  if (!startedAt || !finishedAt) return null;
  const value = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

export const gitlabRequestHeadSha = (
  requestPayload: Record<string, unknown> | null,
  previousStatus: ForgeRequestStatusResult | null,
): string | null => {
  if (!requestPayload) {
    return previousStatus?.headSha ?? null;
  }
  const diffRefs = recordObject(requestPayload, "diff_refs");
  return recordString(requestPayload, "sha") ?? recordString(diffRefs ?? {}, "head_sha");
};

export const gitlabRequestStateFromPayload = (
  requestPayload: Record<string, unknown> | null,
  previousStatus: ForgeRequestStatusResult | null,
): ForgeRequestStatusResult["state"] => {
  if (!requestPayload) {
    return previousStatus?.state ?? "open";
  }
  const rawState = recordString(requestPayload, "state")?.toLowerCase();
  if (rawState === "merged" || rawState === "closed") {
    return rawState;
  }
  return "open";
};

export const gitlabMergeabilityFromPayload = (
  requestPayload: Record<string, unknown> | null,
  previousStatus: ForgeRequestStatusResult | null,
): ForgeRequestStatusResult["mergeability"] => {
  if (!requestPayload) {
    return previousStatus?.mergeability ?? "unknown";
  }
  const detailedStatus = (
    recordString(requestPayload, "detailed_merge_status") ??
    recordString(requestPayload, "merge_status") ??
    ""
  ).toLowerCase();
  if (recordBoolean(requestPayload, "has_conflicts") || detailedStatus.includes("conflict")) {
    return "conflicting";
  }
  if (["checking", "unchecked", "preparing", "approvals_syncing"].includes(detailedStatus)) {
    return "checking";
  }
  return ["mergeable", "can_be_merged"].includes(detailedStatus) ? "mergeable" : "unknown";
};

export const gitlabSupportedActions = (
  state: ForgeRequestStatusResult["state"],
  draft: boolean,
): ForgeRequestStatusResult["supportedActions"] => {
  if (state === "open") {
    return ["refresh", "open", draft ? "mark-ready" : "mark-draft", "merge", "close"];
  }
  return state === "closed" ? ["refresh", "open", "reopen"] : ["refresh", "open"];
};

export const gitlabReviewDecision = (
  approved: boolean,
  approvalsRequired: number,
  requestPayload: Record<string, unknown> | null,
  previousStatus: ForgeRequestStatusResult | null,
): ForgeRequestStatusResult["reviewDecision"] => {
  if (approved) {
    return "approved";
  }
  if (requestPayload) {
    return approvalsRequired > 0 ? "review-required" : "none";
  }
  return previousStatus?.reviewDecision ?? "none";
};

export const appendGitlabStandaloneNotes = (
  notes: unknown[],
  activity: ProjectForgeActivityItem[],
  noteIds: Set<string>,
): void => {
  for (const entry of onlyRecords(notes)) {
    const id = recordNumber(entry, "id");
    if (recordString(entry, "type") === "DiffNote") {
      continue;
    }
    if (id) {
      noteIds.add(String(id));
    }
    const system = recordBoolean(entry, "system");
    activity.push({
      id: `${system ? "gitlab-system-note" : "gitlab-note"}-${String(id ?? activity.length)}`,
      provider: "gitlab",
      kind: system ? "event" : "comment",
      title: system ? (recordString(entry, "body") ?? "updated the merge request") : "commented",
      body: system ? null : recordString(entry, "body"),
      state: system ? "system_note" : null,
      path: null,
      line: null,
      url: null,
      createdAt: recordString(entry, "created_at"),
      updatedAt: recordString(entry, "updated_at"),
      author: gitlabUserSummary(recordObject(entry, "author")),
    });
  }
};

export const appendGitlabDiscussions = (
  discussions: unknown[],
  activity: ProjectForgeActivityItem[],
  reviewThreads: ProjectForgeReviewThread[],
  noteIds: Set<string>,
): void => {
  for (const discussion of onlyRecords(discussions)) {
    const notesList = Array.isArray(discussion.notes) ? onlyRecords(discussion.notes) : [];
    const reviewThread = buildGitlabReviewThread(discussion, notesList, activity.length);
    if (reviewThread) {
      reviewThreads.push(reviewThread);
    }
    for (const note of notesList) {
      const id = recordNumber(note, "id");
      if (id && noteIds.has(String(id))) {
        continue;
      }
      const position = recordObject(note, "position");
      const path = position ? (recordString(position, "new_path") ?? recordString(position, "old_path")) : null;
      const line = position ? (recordNumber(position, "new_line") ?? recordNumber(position, "old_line")) : null;
      const isDiffNote = Boolean(path || line);
      activity.push({
        id: `gitlab-discussion-note-${String(id ?? activity.length)}`,
        provider: "gitlab",
        kind: isDiffNote ? "diff-comment" : "comment",
        title: isDiffNote ? "commented on the diff" : "commented",
        body: recordString(note, "body"),
        state: null,
        path,
        line,
        url: null,
        createdAt: recordString(note, "created_at"),
        updatedAt: recordString(note, "updated_at"),
        author: gitlabUserSummary(recordObject(note, "author")),
        commitSha: position ? recordString(position, "head_sha") : null,
        resolved: recordBoolean(note, "resolved") || recordBoolean(discussion, "resolved"),
      });
    }
  }
};

export const appendGitlabStateEvents = (stateEvents: unknown[], activity: ProjectForgeActivityItem[]): void => {
  for (const entry of onlyRecords(stateEvents)) {
    const id = recordNumber(entry, "id");
    const state = recordString(entry, "state");
    activity.push({
      id: `gitlab-state-${String(id ?? activity.length)}`,
      provider: "gitlab",
      kind: "state",
      title: state ? `${state} this merge request` : "changed state",
      body: null,
      state,
      path: null,
      line: null,
      url: null,
      createdAt: recordString(entry, "created_at"),
      updatedAt: null,
      author: gitlabUserSummary(recordObject(entry, "user")),
    });
  }
};

export const buildGitlabActivity = (notes: unknown[], discussions: unknown[], stateEvents: unknown[]) => {
  const noteIds = new Set<string>();
  const activity: ProjectForgeActivityItem[] = [];
  const reviewThreads: ProjectForgeReviewThread[] = [];
  appendGitlabStandaloneNotes(notes, activity, noteIds);
  appendGitlabDiscussions(discussions, activity, reviewThreads, noteIds);
  appendGitlabStateEvents(stateEvents, activity);
  return { activity, reviewThreads };
};

