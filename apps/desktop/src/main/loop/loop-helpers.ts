import type {
  ProjectForgeActivityItem,
  ProjectForgeReviewThread,
  ProjectLoopIterationRecord,
  ProjectLoopRecord,
  ProjectRecord,
} from "@buildwarden/shared";
import { normalizeJsonResponse } from "../json-response";

/** Marker appended to every comment the loop posts so its own replies are never treated as new feedback. */
export const LOOP_COMMENT_MARKER = "_(BuildWarden Loop automated reply)_";

/** Relative directory inside a run workspace where the agent stores UI review screenshots. */
export const LOOP_UI_REVIEW_DIR = ".buildwarden/ui-review";
export const LOOP_UI_REVIEW_MANIFEST = `${LOOP_UI_REVIEW_DIR}/manifest.json`;

/** Bounded feedback cycles per iteration before the UI gate falls back to manual approval. */
export const LOOP_MAX_AI_UI_REVIEW_ROUNDS = 3;
/** Bounded feedback cycles per iteration for manual UI approvals to avoid endless loops. */
export const LOOP_MAX_MANUAL_UI_REVIEW_ROUNDS = 8;
/** Bounded comment-addressing rounds per PR. */
export const LOOP_MAX_COMMENT_ROUNDS = 12;
/** Maximum inline findings the AI PR review posts per PR. */
export const LOOP_MAX_PR_REVIEW_FINDINGS = 12;
/** Character budget for the PR diff passed to the AI PR reviewer. */
export const LOOP_PR_REVIEW_DIFF_CHAR_LIMIT = 30_000;

export interface LoopPlanIteration {
  title: string;
  objective: string;
}

export interface LoopPlan {
  summary: string;
  iterations: LoopPlanIteration[];
}

export interface LoopUiManifestPage {
  name: string;
  file: string;
  description: string | null;
}

export interface LoopAiUiVerdict {
  verdict: "approve" | "request-changes";
  feedback: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

export const parseLoopPlan = (raw: string): LoopPlan | null => {
  try {
    const parsed = JSON.parse(normalizeJsonResponse(raw)) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const rawIterations = Array.isArray(parsed.iterations)
      ? parsed.iterations
      : Array.isArray(parsed.prs)
        ? parsed.prs
        : Array.isArray(parsed.steps)
          ? parsed.steps
          : [];
    const iterations = rawIterations
      .map((entry): LoopPlanIteration | null => {
        if (typeof entry === "string") {
          const title = entry.trim();
          return title ? { title: title.slice(0, 160), objective: title } : null;
        }
        if (!isRecord(entry)) {
          return null;
        }
        const title = readString(entry, "title") ?? readString(entry, "name");
        const objective =
          readString(entry, "objective") ?? readString(entry, "description") ?? readString(entry, "details") ?? title;
        if (!title || !objective) {
          return null;
        }
        return { title: title.slice(0, 160), objective };
      })
      .filter((entry): entry is LoopPlanIteration => entry !== null)
      .slice(0, 12);
    if (iterations.length === 0) {
      return null;
    }
    const summary = readString(parsed, "summary") ?? readString(parsed, "plan") ?? "";
    return { summary, iterations };
  } catch {
    return null;
  }
};

export const parseLoopUiManifest = (raw: string): LoopUiManifestPage[] | null => {
  try {
    const parsed = JSON.parse(normalizeJsonResponse(raw)) as unknown;
    const rawPages = isRecord(parsed) ? parsed.pages : Array.isArray(parsed) ? parsed : null;
    if (!Array.isArray(rawPages)) {
      return null;
    }
    return rawPages
      .map((entry): LoopUiManifestPage | null => {
        if (!isRecord(entry)) {
          return null;
        }
        const name = readString(entry, "name") ?? readString(entry, "page") ?? readString(entry, "title");
        const file = readString(entry, "file") ?? readString(entry, "screenshot") ?? readString(entry, "path");
        if (!name || !file) {
          return null;
        }
        return {
          name: name.slice(0, 160),
          file,
          description: readString(entry, "description"),
        };
      })
      .filter((entry): entry is LoopUiManifestPage => entry !== null)
      .slice(0, 24);
  } catch {
    return null;
  }
};

const LOOP_UI_APPROVE_VERDICTS = new Set(["approve", "approved", "ok", "pass", "lgtm"]);
const LOOP_UI_CHANGE_VERDICTS = new Set([
  "request-changes",
  "request_changes",
  "requestchanges",
  "changes-requested",
  "changes_requested",
  "changes",
  "reject",
  "rejected",
  "fail",
  "failed",
]);

export const parseLoopAiUiVerdict = (raw: string): LoopAiUiVerdict | null => {
  try {
    const parsed = JSON.parse(normalizeJsonResponse(raw)) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const verdictRaw = (readString(parsed, "verdict") ?? readString(parsed, "decision") ?? "").toLowerCase();
    const feedback = readString(parsed, "feedback") ?? readString(parsed, "reason") ?? "";
    // Exact allowlists only: substring checks would classify "not approved" /
    // "disapproved" as approvals.
    if (LOOP_UI_APPROVE_VERDICTS.has(verdictRaw)) {
      return { verdict: "approve", feedback };
    }
    if (LOOP_UI_CHANGE_VERDICTS.has(verdictRaw)) {
      return { verdict: "request-changes", feedback: feedback || "The reviewer requested changes without details." };
    }
    return null;
  } catch {
    return null;
  }
};

const uiScreenshotInstructionBlock = (loop: ProjectLoopRecord): string =>
  [
    "UI screenshot requirement (mandatory when your changes affect any UI):",
    `- After implementing and validating, determine every UI page/view/screen that is visually affected by your code changes.`,
    "- Start the application yourself (dev server, desktop app, or whatever this project uses) and capture one screenshot per affected page using your own tooling and computer-use capabilities (headless browser, CLI screenshot tools, etc.). No screenshot configuration is provided; figure out the best way yourself.",
    `- Save the screenshots as PNG files inside \`${LOOP_UI_REVIEW_DIR}/\` in the workspace root.`,
    `- Write a manifest to \`${LOOP_UI_REVIEW_MANIFEST}\` with the exact shape: {"pages":[{"name":"<page name>","file":"<file name inside ${LOOP_UI_REVIEW_DIR}>","description":"<what changed on this page>"}]}`,
    '- If your changes do not affect any UI, still write the manifest as {"pages":[]}.',
    `- Never commit the \`.buildwarden\` directory; leave it as untracked working-tree files.`,
    ...(loop.uiReviewInstructions?.trim()
      ? ["- Additional user instructions for screenshot capture:", loop.uiReviewInstructions.trim()]
      : []),
  ].join("\n");

export const buildLoopPlanPrompt = (project: ProjectRecord, loop: ProjectLoopRecord): string =>
  [
    "You are the planning agent of a BuildWarden Loop: an automated pipeline that implements a user request as one or more sequential pull/merge requests.",
    "Inspect this repository first, then produce an implementation plan. Do not modify any files.",
    "",
    `Project: ${project.name}`,
    `Target branch for all PRs: ${loop.baseBranch}`,
    "",
    "User request:",
    loop.prompt,
    "",
    "Planning rules:",
    "- Decide how this request is implemented best: as one PR when it is cohesive and reviewable, or as multiple sequential PRs when splitting reduces risk or review size.",
    "- Each iteration must leave the codebase working and be independently mergeable into the target branch.",
    "- Later iterations may build on earlier ones; they are implemented strictly one after another, each starting only after the previous PR was merged.",
    "- Keep the plan as small as reasonably possible (1-6 iterations for most requests).",
    "",
    "Return STRICT JSON only, no markdown fences, no commentary, with exactly this shape:",
    '{"summary":"<2-4 sentence overall plan summary>","iterations":[{"title":"<short PR title>","objective":"<precise, self-contained implementation instructions for this PR>"}]}',
  ].join("\n");

export const buildLoopIterationPrompt = (args: {
  project: ProjectRecord;
  loop: ProjectLoopRecord;
  iteration: ProjectLoopIterationRecord;
  allIterations: ProjectLoopIterationRecord[];
  planSummary: string | null;
}): string => {
  const { project, loop, iteration, allIterations, planSummary } = args;
  const planLines = allIterations.map(
    (entry) =>
      `${String(entry.iterationIndex + 1)}. ${entry.title}${entry.id === iteration.id ? "  <-- YOU IMPLEMENT THIS ONE" : entry.status === "merged" ? " (already merged)" : ""}`,
  );
  return [
    "You are the implementation agent of a BuildWarden Loop: an automated pipeline that turns a user request into merged pull/merge requests.",
    "Implement exactly one plan iteration in this workspace. BuildWarden will commit remaining changes, push the branch, and open the PR afterwards - focus on a complete, high-quality implementation.",
    "",
    `Project: ${project.name}`,
    `Loop: ${loop.name}`,
    `PR target branch: ${iteration.targetBranch ?? loop.baseBranch}`,
    "",
    "Overall user request:",
    loop.prompt,
    "",
    ...(planSummary?.trim() ? ["Overall plan summary:", planSummary.trim(), ""] : []),
    "Full plan (iterations are implemented and merged one by one):",
    ...planLines,
    "",
    `Your iteration (${String(iteration.iterationIndex + 1)}/${String(allIterations.length)}): ${iteration.title}`,
    "Iteration objective:",
    iteration.objective,
    "",
    "Execution requirements:",
    "- Inspect the relevant code before changing it and follow the repository's conventions.",
    "- Implement the objective completely; do not leave TODOs for later iterations unless the plan explicitly assigns them.",
    "- Run the project's validation (build, tests, lint) when available and fix what your change broke.",
    "- Stay within this iteration's scope; later iterations handle the rest of the plan.",
    "- You may commit your work; anything left uncommitted is committed automatically afterwards.",
    "- Finish with a concise summary of what you changed and how you verified it.",
    "",
    uiScreenshotInstructionBlock(loop),
  ].join("\n");
};

export const buildLoopUiFixPrompt = (
  loop: ProjectLoopRecord,
  feedbackItems: Array<{ pageName: string; feedback: string }>,
): string =>
  [
    "UI review feedback for your last implementation in this workspace. Address every point, then re-capture screenshots.",
    "",
    "Feedback per page:",
    ...feedbackItems.map((item) => `- ${item.pageName}: ${item.feedback}`),
    "",
    "After fixing the issues:",
    `- Re-capture a fresh screenshot for EVERY page listed above (and any other page your fixes now affect) and overwrite the files under \`${LOOP_UI_REVIEW_DIR}/\`.`,
    `- Rewrite \`${LOOP_UI_REVIEW_MANIFEST}\` so it lists the current set of affected pages with their updated screenshots.`,
    "- Do not commit the `.buildwarden` directory.",
    ...(loop.uiReviewInstructions?.trim() ? ["- Screenshot capture notes from the user:", loop.uiReviewInstructions.trim()] : []),
  ].join("\n");

export const buildLoopAiUiReviewPrompt = (args: {
  loop: ProjectLoopRecord;
  iteration: ProjectLoopIterationRecord;
  page: { name: string; description: string | null; relativeImagePath: string };
  diffExcerpt: string;
}): string =>
  [
    "You are the UI review agent of a BuildWarden Loop. Another agent implemented a change in this workspace and captured a screenshot of an affected UI page.",
    `Open and inspect the screenshot image file at \`${args.page.relativeImagePath}\` (relative to the workspace root). You can read image files directly.`,
    "Also consider the related code changes below. Judge whether the page looks correct, coherent, and ready to ship: layout, alignment, spacing, contrast, obvious rendering bugs, broken content.",
    "",
    `Loop request: ${args.loop.prompt}`,
    `Iteration: ${args.iteration.title}`,
    `Page: ${args.page.name}`,
    ...(args.page.description ? [`What changed on this page (per the implementer): ${args.page.description}`] : []),
    "",
    "Code diff excerpt for context:",
    args.diffExcerpt || "(diff unavailable)",
    "",
    "Return STRICT JSON only, no markdown fences:",
    '{"verdict":"approve"|"request-changes","feedback":"<empty when approving, otherwise concrete instructions on what to change>"}',
  ].join("\n");

export const buildLoopCommentsFixPrompt = (args: {
  loop: ProjectLoopRecord;
  iteration: ProjectLoopIterationRecord;
  prUrl: string;
  threads: Array<{
    path: string | null;
    line: number | null;
    comments: Array<{ author: string | null; body: string }>;
  }>;
  generalComments: Array<{ author: string | null; body: string }>;
}): string => {
  const lines: string[] = [
    "New review feedback arrived on the pull/merge request for your implementation in this workspace.",
    `PR/MR: ${args.prUrl}`,
    "Address every actionable point below with code changes in this workspace. If a comment is a question or does not require a change, note that in your final summary instead.",
    "Do not push or comment on the PR yourself; BuildWarden commits, pushes, and replies automatically afterwards.",
    "",
  ];
  if (args.threads.length > 0) {
    lines.push("Review threads on the diff:");
    for (const [index, thread] of args.threads.entries()) {
      lines.push(`Thread ${String(index + 1)}${thread.path ? ` - ${thread.path}${thread.line ? `:${String(thread.line)}` : ""}` : ""}:`);
      for (const comment of thread.comments) {
        lines.push(`  ${comment.author ?? "reviewer"}: ${comment.body}`);
      }
    }
    lines.push("");
  }
  if (args.generalComments.length > 0) {
    lines.push("General PR comments:");
    for (const comment of args.generalComments) {
      lines.push(`- ${comment.author ?? "reviewer"}: ${comment.body}`);
    }
    lines.push("");
  }
  lines.push("Finish with a concise summary of what you changed for each point.");
  return lines.join("\n");
};

export interface LoopPrReviewFinding {
  path: string;
  /** Line number in the NEW version of the file; null when the finding is not tied to a specific line. */
  line: number | null;
  severity: "high" | "medium" | "low";
  comment: string;
}

export interface LoopPrReviewResult {
  summary: string;
  findings: LoopPrReviewFinding[];
}

export const buildLoopPrReviewPrompt = (args: {
  loop: ProjectLoopRecord;
  iteration: ProjectLoopIterationRecord;
  prUrl: string;
  diff: string;
}): string =>
  [
    "You are the code review agent of a BuildWarden Loop. Another agent implemented the change below and opened a pull/merge request.",
    "Review the diff like a strict human reviewer: correctness bugs, regressions, security issues, missing validation, scope violations, and misleading naming. You may open files in this workspace for context.",
    "Only report findings that genuinely need a change; do not pad the review. An empty findings list is a valid result.",
    "",
    `Loop request: ${args.loop.prompt}`,
    `Iteration: ${args.iteration.title}`,
    `Iteration objective: ${args.iteration.objective}`,
    `PR/MR: ${args.prUrl}`,
    "",
    "Unified diff of the PR:",
    args.diff || "(diff unavailable)",
    "",
    "Return STRICT JSON only, no markdown fences:",
    '{"summary":"<1-3 sentence overall verdict>","findings":[{"path":"<file path from the diff>","line":<line number in the NEW file version that appears as an added or context line in the diff, or null>,"severity":"high"|"medium"|"low","comment":"<concrete, actionable review comment>"}]}',
    `Report at most ${String(LOOP_MAX_PR_REVIEW_FINDINGS)} findings. Only use line numbers that are visible in the diff's new side, otherwise set line to null.`,
  ].join("\n");

export const parseLoopPrReviewResult = (raw: string): LoopPrReviewResult | null => {
  try {
    const parsed = JSON.parse(normalizeJsonResponse(raw)) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const findings = rawFindings
      .map((entry): LoopPrReviewFinding | null => {
        if (!isRecord(entry)) {
          return null;
        }
        const path = readString(entry, "path") ?? readString(entry, "file");
        const comment = readString(entry, "comment") ?? readString(entry, "detail") ?? readString(entry, "message");
        if (!path || !comment) {
          return null;
        }
        const lineRaw = entry.line;
        const line = typeof lineRaw === "number" && Number.isInteger(lineRaw) && lineRaw > 0 ? lineRaw : null;
        const severityRaw = (readString(entry, "severity") ?? "medium").toLowerCase();
        const severity = severityRaw === "high" || severityRaw === "low" ? severityRaw : "medium";
        return { path, line, severity, comment };
      })
      .filter((entry): entry is LoopPrReviewFinding => entry !== null)
      .slice(0, LOOP_MAX_PR_REVIEW_FINDINGS);
    const summary = readString(parsed, "summary") ?? "";
    if (!summary && findings.length === 0) {
      return null;
    }
    return { summary, findings };
  } catch {
    return null;
  }
};

export const buildLoopAuditPrompt = (args: {
  project: ProjectRecord;
  loop: ProjectLoopRecord;
  iterations: ProjectLoopIterationRecord[];
}): string =>
  [
    "You are the audit agent of a BuildWarden Loop. All planned pull/merge requests for the user request below have been merged.",
    "Inspect the repository state and write a short final audit. Do not modify any files.",
    "",
    `Project: ${args.project.name}`,
    "User request:",
    args.loop.prompt,
    "",
    "Merged iterations:",
    ...args.iterations.map(
      (iteration) => `- ${iteration.title}${iteration.prUrl ? ` (${iteration.prUrl})` : ""} [${iteration.status}]`,
    ),
    "",
    "Return concise Markdown with sections: Outcome, Risks / Follow-ups, Verification Suggestions. Keep it under 300 words.",
  ].join("\n");

export type NormalizedForgeRequestState = "open" | "merged" | "closed";

export const normalizeForgeRequestState = (state: string): NormalizedForgeRequestState => {
  const normalized = state.trim().toLowerCase();
  if (normalized === "merged") {
    return "merged";
  }
  if (normalized === "open" || normalized === "opened" || normalized === "locked") {
    return "open";
  }
  return "closed";
};

export interface LoopActionableFeedback {
  threads: Array<{
    thread: ProjectForgeReviewThread;
    newComments: ProjectForgeReviewThread["comments"];
  }>;
  generalComments: ProjectForgeActivityItem[];
  /** All comment ids that were considered, to be added to the processed set. */
  seenCommentIds: string[];
}

/**
 * Extracts review feedback the loop has not addressed yet: unresolved diff threads with new
 * non-loop comments plus new top-level comments. The loop's own replies carry
 * {@link LOOP_COMMENT_MARKER} and are ignored.
 */
export const extractLoopActionableFeedback = (
  reviewThreads: ProjectForgeReviewThread[],
  activity: ProjectForgeActivityItem[],
  processedCommentIds: ReadonlySet<string>,
): LoopActionableFeedback => {
  const seenCommentIds: string[] = [];
  const threads: LoopActionableFeedback["threads"] = [];

  for (const thread of reviewThreads) {
    if (thread.resolved === true) {
      for (const comment of thread.comments) {
        seenCommentIds.push(comment.id);
      }
      continue;
    }
    const newComments = thread.comments.filter(
      (comment) => !processedCommentIds.has(comment.id) && !comment.body.includes(LOOP_COMMENT_MARKER),
    );
    for (const comment of thread.comments) {
      seenCommentIds.push(comment.id);
    }
    if (newComments.length > 0) {
      threads.push({ thread, newComments });
    }
  }

  const generalComments = activity.filter((item) => {
    if (item.kind !== "comment" || !item.body?.trim()) {
      return false;
    }
    if (processedCommentIds.has(item.id) || item.body.includes(LOOP_COMMENT_MARKER)) {
      seenCommentIds.push(item.id);
      return false;
    }
    seenCommentIds.push(item.id);
    return true;
  });

  return { threads, generalComments, seenCommentIds };
};

export const parseProcessedCommentIds = (json: string): Set<string> => {
  try {
    const parsed = JSON.parse(json || "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
};

export const serializeProcessedCommentIds = (ids: ReadonlySet<string>): string => JSON.stringify([...ids]);
