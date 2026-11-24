import {
  canReviewRunChanges,
  type RunDiffReviewFinding,
  type RunDiffReviewOptions,
  type RunDiffReviewResult,
  type RunRecord,
} from "@buildwarden/shared";
import { normalizeJsonResponse } from "../json-response";
import { clampReviewScore } from "../project-insights";
import { captureWorkspaceRevision } from "../workspace-revision";
import { AppService } from "./app-service";
import { MAX_DIFF_CHARS_FOR_REVIEW } from "./app-service-constants";

const parseReviewLineNumber = (value: unknown, fallbackReference: unknown): number | null => {
  let numericValue = Number.NaN;
  if (typeof value === "number") {
    numericValue = value;
  } else if (typeof value === "string") {
    numericValue = Number.parseInt(value.trim(), 10);
  }
  if (Number.isInteger(numericValue) && numericValue > 0) {
    return numericValue;
  }

  if (typeof fallbackReference !== "string") {
    return null;
  }

  const match = /\b(?:line|lines|L)?\s*(\d{1,7})\b/i.exec(fallbackReference);
  if (!match?.[1]) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/** Reviews run diffs and pull or merge request diffs with a model. */
export class DiffReviewService extends AppService<"modelText" | "runDetails" | "runEvents" | "verification" | "workspaceGuard"> {
  async analyzeRunDiff(runId: string, options?: RunDiffReviewOptions): Promise<RunDiffReviewResult> {
    const run = this.db.getRun(runId);

    if (!canReviewRunChanges(run)) {
      throw new Error("The agent must finish its turn before requesting an AI diff review.");
    }

    if (run.workspaceVcs === "git" && run.workspaceType === "worktree") {
      await this.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    if (run.workspaceVcs === "git" && !(await this.gitService.hasChanges(run.worktreePath))) {
      throw new Error("There are no changes to review for this run.");
    }

    const reviewedRevision = await captureWorkspaceRevision(run.worktreePath, run.workspaceVcs);
    const diffOutcome = await this.services.runDetails.getRunWorktreeDiff(run.id);
    if (diffOutcome.worktreeUnavailable) {
      throw new Error(diffOutcome.diffUnavailableReason || "Could not read the workspace diff.");
    }

    let diff = diffOutcome.diff;
    if (!diff.trim()) {
      throw new Error("There are no changes to review for this run.");
    }
    if (diff.length > MAX_DIFF_CHARS_FOR_REVIEW) {
      diff = `${diff.slice(0, MAX_DIFF_CHARS_FOR_REVIEW)}\n\n[Diff truncated for AI review - focus on highest-risk changes.]`;
    }

    const targetModelId = options?.modelId?.trim() || run.modelId;
    const context = await this.services.modelText.resolveModelInvocationContext(targetModelId);
    const prompt = this.buildRunDiffReviewPrompt(run, diff);

    try {
      const raw = await this.services.modelText.askModelForText(run.worktreePath, context, {
        prompt,
        systemPrompt: "You are a meticulous code reviewer. Return valid JSON only, with no markdown fences or extra commentary.",
        maxTokens: 1_400,
        temperature: 0.2,
        usageProjectId: run.projectId,
      });

      const currentRevision = await captureWorkspaceRevision(run.worktreePath, run.workspaceVcs);
      if (currentRevision.fingerprint !== reviewedRevision.fingerprint || currentRevision.head !== reviewedRevision.head) throw new Error("Workspace changed during review. Review the current revision again.");
      const verification = await this.services.verification.getRunVerification(runId);
      if (verification.status !== "unconfigured" && verification.currentRevision?.fingerprint !== reviewedRevision.fingerprint) throw new Error("Workspace changed while verifying the review result. Review again.");
      const result = { ...this.parseRunDiffReviewResult(raw), reviewedRevision, verificationStatus: verification.status };
      await this.services.runEvents.appendRunEvent(runId, "status", "Diff review completed", result.headline, { reviewedRevision, verificationStatus: verification.status });
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        [
          "Could not review the run diff via the configured provider.",
          "Try again, switch models, or review the diff manually.",
          `Detail: ${msg}`,
        ].join(" "),
      );
    }
  }

  async analyzeProjectPrMrDiff(
    projectId: string,
    input: { prUrl: string; diff: string; modelId?: string },
  ): Promise<RunDiffReviewResult> {
    const project = this.db.getProject(projectId);
    this.services.workspaceGuard.requireGitProject(project, "Pull and merge request review");
    let diff = input.diff.trim();
    if (!diff) {
      throw new Error("Load a PR/MR diff before running AI review.");
    }
    if (diff.length > MAX_DIFF_CHARS_FOR_REVIEW) {
      diff = `${diff.slice(0, MAX_DIFF_CHARS_FOR_REVIEW)}\n\n[Diff truncated for AI review - focus on highest-risk changes.]`;
    }
    const targetModelId = input.modelId?.trim();
    if (!targetModelId) {
      throw new Error("Select a model for PR/MR review.");
    }
    const context = await this.services.modelText.resolveModelInvocationContext(targetModelId);
    const prompt = this.buildPrMrDiffReviewPrompt(input.prUrl.trim() || "(unknown)", diff);

    try {
      const raw = await this.services.modelText.askModelForText(project.repoPath, context, {
        prompt,
        systemPrompt: "You are a meticulous code reviewer. Return valid JSON only, with no markdown fences or extra commentary.",
        maxTokens: 1_400,
        temperature: 0.2,
        usageProjectId: project.id,
      });

      return this.parseRunDiffReviewResult(raw);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(["Could not review the PR/MR diff via the configured provider.", "Try again or switch models.", `Detail: ${msg}`].join(" "));
    }
  }

  private buildRunDiffReviewPrompt(run: RunRecord, diff: string): string {
    const goal =
      "Simulate a demanding teammate reviewing this diff before PR. Focus on the comments they would likely leave on correctness, maintainability, missing tests, and surprising design choices.";
    const scoreLabel = "PR readiness";
    return [
      goal,
      "",
      "Return JSON only with exactly this shape:",
      '{',
      '  "headline": "short sentence",',
      '  "summary": "2-4 sentence review summary",',
      `  "scoreLabel": "${scoreLabel}",`,
      '  "score": 0,',
      '  "strengths": ["short bullet"],',
      '  "findings": [',
      '    {',
      '      "title": "short finding title",',
      '      "priority": "high|medium|low",',
      '      "filePath": "relative/path/or/null",',
      '      "lineNumber": 123,',
      '      "lineReference": "optional line/hunk reference or null",',
      '      "detail": "why this matters",',
      '      "recommendation": "specific next step or null"',
      "    }",
      "  ],",
      '  "nextSteps": ["short actionable suggestion"]',
      "}",
      "",
      "Rules:",
      "- Prefer concrete, code-review style findings over vague advice.",
      "- Mention missing tests when appropriate.",
      "- Keep strengths honest and short.",
      "- Use relative repo paths when you can infer them from the diff.",
      "- Set lineNumber to the exact changed new-file line number when the finding points at a specific added/modified line. For deletion-only findings, use the old-file line number. Use null only for whole-file or class-level findings.",
      "- Keep lineReference human-readable, such as \"line 88\" or \"lines 88-91\".",
      "- Score 100 = reviewer is likely happy to approve; 70 = some comments but probably acceptable; 40 = likely change request territory; 0 = major blockers.",
      "",
      "Original task:",
      run.prompt || "(no prompt available)",
      "",
      "Git diff of current uncommitted changes in the run workspace (staged + unstaged + untracked as patches):",
      diff || "(empty diff)",
    ].join("\n");
  }

  private buildPrMrDiffReviewPrompt(prUrl: string, diff: string): string {
    const goal =
      "Simulate a demanding reviewer: list the comments they would likely leave on this PR/MR (correctness, maintainability, tests, API/design surprises).";
    const scoreLabel = "PR readiness";
    return [
      goal,
      "",
      "Return JSON only with exactly this shape:",
      "{",
      '  "headline": "short sentence",',
      '  "summary": "2-4 sentence review summary",',
      `  "scoreLabel": "${scoreLabel}",`,
      '  "score": 0,',
      '  "strengths": ["short bullet"],',
      '  "findings": [',
      "    {",
      '      "title": "short finding title",',
      '      "priority": "high|medium|low",',
      '      "filePath": "relative/path/or/null",',
      '      "lineNumber": 123,',
      '      "lineReference": "optional line/hunk reference or null",',
      '      "detail": "why this matters",',
      '      "recommendation": "specific next step or null"',
      "    }",
      "  ],",
      '  "nextSteps": ["short actionable suggestion"]',
      "}",
      "",
      "Rules:",
      "- Prefer concrete, code-review style findings over vague advice.",
      "- Mention missing tests when appropriate.",
      "- Keep strengths honest and short.",
      "- Use relative repo paths when you can infer them from the diff.",
      "- Set lineNumber to the exact changed new-file line number when the finding points at a specific added/modified line. For deletion-only findings, use the old-file line number. Use null only for whole-file or class-level findings.",
      "- Keep lineReference human-readable, such as \"line 88\" or \"lines 88-91\".",
      "- Score 100 = reviewer is likely happy to approve; 70 = some comments but probably acceptable; 40 = likely change request territory; 0 = major blockers.",
      "",
      "PR/MR URL:",
      prUrl || "(unknown)",
      "",
      "Git diff (merge base to PR/MR head, produced locally via git fetch):",
      diff || "(empty diff)",
    ].join("\n");
  }

  private parseRunDiffReviewResult(raw: string): RunDiffReviewResult {
    const normalized = normalizeJsonResponse(raw);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(normalized) as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    const findingsRaw = Array.isArray(parsed.findings) ? parsed.findings : [];
    const findings: RunDiffReviewFinding[] = findingsRaw.map((entry) => {
      const record = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
      const priority = record.priority === "high" || record.priority === "medium" || record.priority === "low" ? record.priority : "medium";
      return {
        title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : "Review finding",
        priority,
        filePath: typeof record.filePath === "string" && record.filePath.trim() ? record.filePath.trim() : null,
        lineNumber: parseReviewLineNumber(record.lineNumber, record.lineReference),
        lineReference: typeof record.lineReference === "string" && record.lineReference.trim() ? record.lineReference.trim() : null,
        detail: typeof record.detail === "string" && record.detail.trim() ? record.detail.trim() : "The model did not provide details.",
        recommendation: typeof record.recommendation === "string" && record.recommendation.trim() ? record.recommendation.trim() : null,
      };
    });

    const strengths = Array.isArray(parsed.strengths)
      ? parsed.strengths.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
      : [];
    const nextSteps = Array.isArray(parsed.nextSteps)
      ? parsed.nextSteps.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
      : [];

    const fallbackHeadline = "Reviewer simulation ready";
    let fallbackSummary = "No concrete findings were returned. Review the diff manually before committing.";
    if (findings.length > 0) {
      fallbackSummary = `Generated ${String(findings.length)} review finding${findings.length === 1 ? "" : "s"} from the current diff.`;
    }

    return {
      headline: typeof parsed.headline === "string" && parsed.headline.trim() ? parsed.headline.trim() : fallbackHeadline,
      summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : fallbackSummary,
      scoreLabel:
        typeof parsed.scoreLabel === "string" && parsed.scoreLabel.trim()
          ? parsed.scoreLabel.trim()
          : "PR readiness",
      score: clampReviewScore(parsed.score),
      strengths,
      findings,
      nextSteps,
      generatedAt: new Date().toISOString(),
    };
  }
}
