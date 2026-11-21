import type {
  ProjectForgeActivityItem,
  ProjectForgeProvider,
  ProjectForgeRequestSummary,
  ProjectForgeReviewThread,
  RunForgeCheck,
  RunForgeRequestSummary,
} from "./index";

/** What a watched PR/MR can wake its run for. */
export type PrWatchTriggerKind = "checks" | "feedback" | "conflicts";

export interface PrWatchOptions {
  checks: boolean;
  feedback: boolean;
  conflicts: boolean;
}

export const DEFAULT_PR_WATCH_OPTIONS: PrWatchOptions = { checks: true, feedback: true, conflicts: true };

export type PrWatchStatus =
  /** Polling the PR/MR between turns. */
  | "watching"
  /** A wake turn is running, or its result is being pushed and answered. */
  | "working"
  /** Stopped by a problem the user has to look at. Resume starts watching again. */
  | "paused"
  | "ended";

export type PrWatchEndReason = "merged" | "closed" | "stopped" | "moved" | "unlinked";

/** Wakes allowed while the PR/MR head stays on the same commit. */
export const PR_WATCH_MAX_ATTEMPTS_PER_HEAD = 2;
/** Wakes allowed per watch, until the user resumes it. */
export const PR_WATCH_MAX_WAKES = 5;
/** Instructions a project can append to every wake prompt. */
export const PR_WATCH_INSTRUCTIONS_MAX_CHARS = 4_000;

export type PrWatchVerdict = "valid" | "incorrect" | "intentional" | "already-fixed" | "needs-user" | "no-action";
export const PR_WATCH_VERDICTS: readonly PrWatchVerdict[] = ["valid", "incorrect", "intentional", "already-fixed", "needs-user", "no-action"];

/** One comment, or one review thread, the agent is asked to triage. Refs are local to one wake. */
export interface PrWatchFeedbackItem {
  ref: string;
  kind: "thread" | "conversation";
  /** Review thread to reply in. Null for conversation comments. */
  threadId: string | null;
  replyToCommentId: string | null;
  path: string | null;
  line: number | null;
  /** Comments that are new since the last wake. Marked handled once the wake finishes. */
  commentIds: string[];
  author: string | null;
  /** Short quote of the newest comment, used to anchor a conversation reply. */
  excerpt: string;
}

export interface PrWatchPendingWake {
  id: string;
  triggers: PrWatchTriggerKind[];
  /** PR/MR head the agent was woken on. */
  headSha: string | null;
  /** Keys marked handled when the wake finishes, so the same event never wakes the run twice. */
  handledKeys: string[];
  feedback: PrWatchFeedbackItem[];
  /** A missing report gets one correction turn. */
  repairRequested: boolean;
  startedAt: string;
}

export interface PrWatchWakeResult {
  finishedAt: string;
  triggers: PrWatchTriggerKind[];
  pushed: boolean;
  replies: number;
  replyErrors: string[];
  verdicts: Partial<Record<PrWatchVerdict, number>>;
  /** Comments the agent left for the user, as "ref: excerpt". */
  needsUser: string[];
  /** The agent's final answer, shortened. */
  summary: string | null;
}

export interface PrWatchAttention {
  id: string;
  message: string;
  createdAt: string;
}

/** Tries allowed for a reply the host rejected, before it is left to the user. */
export const PR_WATCH_REPLY_ATTEMPTS = 3;

/** A reply the host has not accepted yet. Later polls send it again. */
export interface PrWatchUndeliveredReply {
  ref: string;
  /** Review thread to reply in. Null posts to the request's conversation. */
  threadId: string | null;
  replyToCommentId: string | null;
  body: string;
  attempts: number;
  lastError: string;
  /** The host may have accepted it: it is looked for on the request before any resend. */
  uncertain?: boolean;
}

export interface PrWatchRecord {
  runId: string;
  projectId: string;
  prUrl: string;
  prNumber: number;
  provider: ProjectForgeProvider;
  status: PrWatchStatus;
  options: PrWatchOptions;
  /** Why the watch paused or ended, or the latest note while watching. */
  message: string | null;
  endReason: PrWatchEndReason | null;
  wakeCount: number;
  attemptsOnHead: number;
  attemptHeadSha: string | null;
  lastCheckedAt: string | null;
  lastWakeAt: string | null;
  pending: PrWatchPendingWake | null;
  lastResult: PrWatchWakeResult | null;
  /** Shown in the attention inbox until acknowledged. */
  attention: PrWatchAttention | null;
  /** Absent in watches saved before replies were retried. */
  undeliveredReplies?: PrWatchUndeliveredReply[];
  /** Replies the watch gave up on, as "ref: reason", newest last. Kept for the life of the watch. */
  failedReplies?: string[];
  createdAt: string;
  updatedAt: string;
}

/** What clients render. The pending wake's comment list stays in the host. */
export type PrWatchView = Omit<PrWatchRecord, "pending"> & {
  pending: Pick<PrWatchPendingWake, "triggers" | "startedAt"> | null;
};

export const toPrWatchView = (record: PrWatchRecord): PrWatchView => ({
  ...record,
  pending: record.pending ? { triggers: record.pending.triggers, startedAt: record.pending.startedAt } : null,
});

export const isPrWatchActive = (watch: Pick<PrWatchRecord, "status"> | null | undefined): boolean =>
  watch?.status === "watching" || watch?.status === "working";

export interface StartPrWatchInput {
  /** The PR/MR the user confirmed. Starting fails when the run's link changed since. */
  prUrl: string;
  options?: Partial<PrWatchOptions>;
  /** Moves the watch here when another run already watches this PR/MR. */
  takeOver?: boolean;
}

export type RunForgeLinkSource = "auto" | "user" | "none";

export interface RunPrWatchCandidate {
  request: ProjectForgeRequestSummary;
  watchable: boolean;
  /** Why the request cannot be watched from this run. */
  reason: string | null;
  /** Another run already watching this request. */
  watchedByRunId: string | null;
}

export interface RunPrWatchCandidates {
  /** Branch checked out in the run's workspace. Null when it cannot be read. */
  workspaceBranch: string | null;
  linked: RunForgeRequestSummary | null;
  linkSource: RunForgeLinkSource;
  candidates: RunPrWatchCandidate[];
  /** Set when the requests could not be listed; the linked request is still shown. */
  error: string | null;
}

/** Appended to every comment BuildWarden posts, so a watch never treats its own replies as feedback. */
export const PR_WATCH_REPLY_MARKER = "<!-- buildwarden:pr-watch -->";

export const isPrWatchReply = (body: string | null | undefined): boolean => Boolean(body?.includes(PR_WATCH_REPLY_MARKER));

export const prWatchRequestLabel = (provider: ProjectForgeProvider): "PR" | "MR" => (provider === "gitlab" ? "MR" : "PR");

const FAILED_CHECK_STATUSES: ReadonlySet<RunForgeCheck["status"]> = new Set(["failure"]);
const PENDING_CHECK_STATUSES: ReadonlySet<RunForgeCheck["status"]> = new Set(["queued", "running"]);
const EXCERPT_CHARS = 280;

const excerpt = (body: string): string => {
  const text = body.replace(/\s+/g, " ").trim();
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}…` : text;
};

export interface PrWatchFeedbackSource {
  ref: string;
  item: PrWatchFeedbackItem;
  /** Earlier comments in the thread are context; `isNew` marks what to triage. */
  comments: Array<{ author: string | null; body: string; isNew: boolean }>;
}

export interface PrWatchTriggerScan {
  triggers: PrWatchTriggerKind[];
  failedChecks: RunForgeCheck[];
  conflicts: boolean;
  feedback: PrWatchFeedbackSource[];
  handledKeys: string[];
}

// Scoped to the request: two requests from one branch share head commits, but not their events.
export const prWatchChecksKey = (number: number, headSha: string | null) => `checks:${String(number)}:${headSha ?? "unknown"}`;
export const prWatchConflictKey = (number: number, headSha: string | null) => `conflict:${String(number)}:${headSha ?? "unknown"}`;
export const prWatchCommentKey = (commentId: string) => `comment:${commentId}`;

/**
 * Finds what needs the agent on a watched PR/MR. Pure: `handled` holds the keys earlier wakes
 * already covered, so the same failure or comment never wakes the run twice.
 */
export const scanPrWatchTriggers = (input: {
  options: PrWatchOptions;
  summary: RunForgeRequestSummary;
  checks: readonly RunForgeCheck[];
  reviewThreads: readonly ProjectForgeReviewThread[] | null;
  activity: readonly ProjectForgeActivityItem[] | null;
  handled: ReadonlySet<string>;
}): PrWatchTriggerScan => {
  const { options, summary, handled } = input;
  const triggers: PrWatchTriggerKind[] = [];
  const handledKeys: string[] = [];
  let failedChecks: RunForgeCheck[] = [];
  let conflicts = false;
  const feedback: PrWatchFeedbackSource[] = [];

  // Wait for every check to finish, so one wake covers all failures of a commit.
  const checksSettled = !input.checks.some((check) => PENDING_CHECK_STATUSES.has(check.status));
  const checksKey = prWatchChecksKey(summary.number, summary.headSha);
  if (options.checks && checksSettled && !handled.has(checksKey)) {
    failedChecks = input.checks.filter((check) => FAILED_CHECK_STATUSES.has(check.status));
    if (failedChecks.length) {
      triggers.push("checks");
      handledKeys.push(checksKey);
    }
  }

  const conflictKey = prWatchConflictKey(summary.number, summary.headSha);
  if (options.conflicts && summary.mergeability === "conflicting" && !handled.has(conflictKey)) {
    conflicts = true;
    triggers.push("conflicts");
    handledKeys.push(conflictKey);
  }

  if (options.feedback) {
    let threadIndex = 0;
    for (const thread of input.reviewThreads ?? []) {
      if (thread.resolved === true) continue;
      const comments = thread.comments.filter((comment) => comment.body.trim() && !isPrWatchReply(comment.body));
      const fresh = comments.filter((comment) => !handled.has(prWatchCommentKey(comment.id)));
      if (!fresh.length) continue;
      threadIndex += 1;
      const ref = `T${String(threadIndex)}`;
      const newest = fresh.at(-1)!;
      feedback.push({
        ref,
        item: {
          ref,
          kind: "thread",
          threadId: thread.providerThreadId,
          replyToCommentId: thread.replyToCommentId,
          path: thread.path || null,
          line: thread.newLineNumber ?? thread.oldLineNumber,
          commentIds: fresh.map((comment) => comment.id),
          author: newest.author?.username ?? null,
          excerpt: excerpt(newest.body),
        },
        comments: comments.map((comment) => ({
          author: comment.author?.username ?? null,
          body: comment.body.trim(),
          isNew: fresh.includes(comment),
        })),
      });
      handledKeys.push(...fresh.map((comment) => prWatchCommentKey(comment.id)));
    }
    let conversationIndex = 0;
    for (const entry of input.activity ?? []) {
      // Diff comments belong to review threads above; state changes and events are not feedback.
      if (entry.kind !== "comment" && entry.kind !== "review") continue;
      const body = entry.body?.trim() ?? "";
      if (!body || isPrWatchReply(body) || handled.has(prWatchCommentKey(entry.id))) continue;
      conversationIndex += 1;
      const ref = `C${String(conversationIndex)}`;
      feedback.push({
        ref,
        item: {
          ref,
          kind: "conversation",
          threadId: null,
          replyToCommentId: null,
          path: null,
          line: null,
          commentIds: [entry.id],
          author: entry.author?.username ?? null,
          excerpt: excerpt(body),
        },
        comments: [{ author: entry.author?.username ?? null, body, isNew: true }],
      });
      handledKeys.push(prWatchCommentKey(entry.id));
    }
    if (feedback.length) triggers.push("feedback");
  }

  return { triggers, failedChecks, conflicts, feedback, handledKeys };
};

export interface PrWatchPromptInput {
  provider: ProjectForgeProvider;
  number: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string | null;
  failedChecks: ReadonlyArray<{ name: string; url: string | null; log: string | null }>;
  conflicts: boolean;
  feedback: readonly PrWatchFeedbackSource[];
  /** Project instructions, appended after the defaults. */
  instructions: string;
}

export const PR_WATCH_REPORT_FENCE = "pr-watch-report";

const quoteBlock = (text: string) => text.split(/\r?\n/).map((line) => `> ${line}`).join("\n");

type PrWatchWakeContent = Pick<PrWatchPromptInput, "provider" | "number" | "failedChecks" | "feedback" | "conflicts">;

const describeTriggers = (input: PrWatchWakeContent): string => {
  const parts: string[] = [];
  if (input.failedChecks.length) parts.push(`${String(input.failedChecks.length)} failed check${input.failedChecks.length === 1 ? "" : "s"}`);
  if (input.feedback.length) parts.push(`${String(input.feedback.length)} comment${input.feedback.length === 1 ? "" : "s"} to review`);
  if (input.conflicts) parts.push("merge conflicts");
  return parts.join(", ");
};

/** One-line description of a wake, for the run timeline and notices. */
export const describePrWatchWake = (input: PrWatchWakeContent): string =>
  `${prWatchRequestLabel(input.provider)} #${String(input.number)} needs attention: ${describeTriggers(input)}.`;

/** The prompt that wakes a run for its watched PR/MR. */
export const buildPrWatchPrompt = (input: PrWatchPromptInput): string => {
  const label = prWatchRequestLabel(input.provider);
  const head = input.headSha ? ` (head ${input.headSha.slice(0, 7)})` : "";
  const sections: string[] = [
    `[PR watch] ${label} #${String(input.number)} "${input.title}"${head} needs attention: ${describeTriggers(input)}.`,
    `Branch: ${input.sourceBranch} -> ${input.targetBranch}. You are working in this branch's workspace.`,
  ];

  if (input.failedChecks.length) {
    sections.push([
      "## Failed checks",
      "Find the cause of each failure and fix it. If a failure is flaky or unrelated to this branch, say so instead of changing code.",
      ...input.failedChecks.map((check) => [
        `- ${check.name}${check.url ? `: ${check.url}` : ""}`,
        check.log ? `\n  Last lines of the log:\n\`\`\`text\n${check.log}\n\`\`\`` : "",
      ].join("")),
    ].join("\n"));
  }

  if (input.conflicts) {
    sections.push([
      "## Merge conflicts",
      `The ${label} conflicts with ${input.targetBranch}. Merge ${input.targetBranch} into this branch, resolve the conflicts so both sides keep their intent, and commit the merge. Do not rebase, because that rewrites pushed history.`,
    ].join("\n"));
  }

  if (input.feedback.length) {
    sections.push([
      "## Review comments",
      "Review every comment below. For each one, decide:",
      "- valid: the problem is real and should be fixed",
      "- incorrect: the comment is wrong or based on a misreading",
      "- intentional: the code is deliberately written this way",
      "- already-fixed: an earlier commit already handles it",
      "- needs-user: a product or design decision you should not make alone",
      "- no-action: nothing to answer, such as an approval, thanks, or an automated status message",
      "",
      "Check each claim against the code before deciding. Do not accept a comment just because a reviewer wrote it, and do not reject one without evidence.",
      "Fix each valid comment in its own commit, with a message that says what the reviewer asked for. If two comments need the same change, make one commit and report it for both.",
      "",
      ...input.feedback.map((source) => {
        const { item } = source;
        const where = item.kind === "thread"
          ? `${item.path ?? "file"}${item.line ? `:${String(item.line)}` : ""}`
          : "conversation";
        const comments = source.comments.map((comment) => {
          const tag = source.comments.length > 1 ? (comment.isNew ? " (new)" : " (earlier)") : "";
          return `@${comment.author ?? "unknown"}${tag}:\n${quoteBlock(comment.body)}`;
        });
        return [`### ${item.ref} · ${where}`, ...comments].join("\n");
      }),
    ].join("\n"));
  }

  sections.push([
    "## How to finish",
    "Commit every change. Do not push: BuildWarden pushes all commits together when you finish, then posts your replies.",
    "Do not merge, close, or force-push the request, and do not resolve review threads.",
    "Run the relevant validation before you finish.",
    ...(input.feedback.length ? [
      "",
      `End your final message with a fenced \`${PR_WATCH_REPORT_FENCE}\` block holding a JSON array with one entry per comment above:`,
      `\`\`\`${PR_WATCH_REPORT_FENCE}`,
      '[{"item": "T1", "verdict": "valid", "commits": ["<sha>"], "reply": "What you changed."}]',
      "```",
      "Write each reply for the reviewer, factual and brief:",
      "- valid: what you changed; the commit link is added automatically",
      "- incorrect: why it does not apply, pointing to the code that shows it",
      "- intentional: why it was done this way",
      "- already-fixed: which commit fixed it",
      "- needs-user and no-action: leave reply empty, and explain needs-user items in your message instead",
    ] : []),
  ].join("\n"));

  const instructions = input.instructions.trim();
  if (instructions) sections.push(`## Project instructions\n${instructions}`);
  return sections.join("\n\n");
};

export const PR_WATCH_REPORT_REPAIR_PROMPT = [
  `Your last message did not include a readable \`${PR_WATCH_REPORT_FENCE}\` block, so BuildWarden cannot answer the reviewers.`,
  "Do not change any files. Reply with only the report: a fenced block holding a JSON array with one entry per comment,",
  'each with "item", "verdict", "commits" (for valid fixes), and "reply".',
].join(" ");

export interface PrWatchReportEntry {
  item: string;
  verdict: PrWatchVerdict;
  commits: string[];
  reply: string;
}

const REPORT_BLOCK = new RegExp(`\`\`\`${PR_WATCH_REPORT_FENCE}[^\\n]*\\n([\\s\\S]*?)\`\`\``, "g");
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

/** Reads the agent's report. Null when no block parses; entries that do not validate are dropped. */
export const parsePrWatchReport = (text: string, refs: readonly string[]): PrWatchReportEntry[] | null => {
  const blocks = [...text.matchAll(REPORT_BLOCK)];
  const raw = blocks.at(-1)?.[1];
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : null;
  if (!list) return null;
  const known = new Set(refs.map((ref) => ref.toUpperCase()));
  const entries = new Map<string, PrWatchReportEntry>();
  for (const value of list) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const item = typeof record.item === "string" ? record.item.trim().toUpperCase() : "";
    const verdict = typeof record.verdict === "string" ? record.verdict.trim().toLowerCase().replace(/[\s_]+/g, "-") : "";
    if (!known.has(item) || !PR_WATCH_VERDICTS.includes(verdict as PrWatchVerdict)) continue;
    const commits = (Array.isArray(record.commits) ? record.commits : typeof record.commit === "string" ? [record.commit] : [])
      .filter((sha): sha is string => typeof sha === "string" && COMMIT_SHA.test(sha.trim()))
      .map((sha) => sha.trim());
    entries.set(item, { item, verdict: verdict as PrWatchVerdict, commits, reply: typeof record.reply === "string" ? record.reply.trim() : "" });
  }
  return [...entries.values()];
};

/** The comment BuildWarden posts for one report entry. Null when nothing should be posted. */
export const formatPrWatchReply = (
  entry: Pick<PrWatchReportEntry, "verdict" | "reply">,
  item: Pick<PrWatchFeedbackItem, "kind" | "excerpt" | "author">,
  commits: readonly string[],
): string | null => {
  if (entry.verdict === "needs-user" || entry.verdict === "no-action" || !entry.reply) return null;
  // A fix is only claimed with a commit on the branch to show for it.
  if (entry.verdict === "valid" && !commits.length) return null;
  const parts: string[] = [];
  if (item.kind === "conversation") parts.push(`${quoteBlock(item.excerpt)}${item.author ? `\n> — @${item.author}` : ""}`);
  parts.push(entry.reply);
  if (entry.verdict === "valid" && commits.length) parts.push(`Fixed in ${commits.map((sha) => sha.slice(0, 12)).join(", ")}.`);
  parts.push(PR_WATCH_REPLY_MARKER);
  return parts.join("\n\n");
};

/** Reads the per-project instructions setting. Unknown shapes read as empty. */
export const parseProjectPrWatchInstructionsSetting = (raw: string | null | undefined): Record<string, string> => {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] =>
      Boolean(entry[0]) && typeof entry[1] === "string" && Boolean(entry[1].trim())));
  } catch {
    return {};
  }
};

export const PR_WATCH_STATUS_LABELS: Record<PrWatchStatus, string> = {
  watching: "Watching",
  working: "Working",
  paused: "Paused",
  ended: "Ended",
};

export const PR_WATCH_TRIGGER_LABELS: Record<PrWatchTriggerKind, string> = {
  checks: "Failed checks",
  feedback: "Review comments",
  conflicts: "Merge conflicts",
};
