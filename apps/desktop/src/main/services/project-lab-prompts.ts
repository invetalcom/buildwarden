import type { ProjectLabMode, ProjectRecord, RunProjectLabInput } from "@buildwarden/shared";
import { AppService } from "./app-service";

export const PROJECT_LAB_MODE_LABELS: Record<ProjectLabMode, string> = {
  "new-feature": "New feature",
  bugfix: "Bugfix",
  refactoring: "Refactoring",
  "rfc-only": "RFC only",
};

/** Writes the briefs and prompts Project Lab gives to its agents. */
export class ProjectLabPrompts extends AppService<"projectInsights"> {
  async buildProjectLabRepoBrief(project: ProjectRecord, baseBranch: string): Promise<string> {
    const tasks = this.db.listProjectTasks(project.id).slice(0, 5);
    const insights = this.db.listProjectInsights(project.id).slice(0, 4);
    const recentRuns = this.db
      .listRunsForProject(project.id)
      .filter((run) => run.kind === "standard")
      .slice(0, 6);
    const recentCommits = (await this.services.projectInsights.readRecentCommitInfo(project.repoPath, 18, project.kind === "git" ? baseBranch : undefined)).slice(0, 8);

    return [
      `Repository path: ${project.repoPath}`,
      `Base branch: ${baseBranch}`,
      "",
      "Recent tasks:",
      tasks.length ? tasks.map((task) => `- ${task.title}: ${task.prompt}`).join("\n") : "- none",
      "",
      "Recent project insights:",
      insights.length ? insights.map((insight) => `- ${insight.title}: ${insight.summary}`).join("\n") : "- none",
      "",
      "Recent standard runs:",
      recentRuns.length ? recentRuns.map((run) => `- [${run.status}] ${run.prompt}`).join("\n") : "- none",
      "",
      "Recent commits:",
      recentCommits.length ? recentCommits.map((commit) => `- ${commit.date} ${commit.title}`).join("\n") : "- none",
    ].join("\n");
  }

  /**
   * Earlier Lab threads the agent must not repeat: recent ones of every mode that did not fail, and
   * every recent one of the chosen mode. Their generated implementation prompts are left out: they
   * are mostly this same boilerplate.
   */
  buildProjectLabPriorWorkBrief(projectId: string, mode: ProjectLabMode, excludedThreadId?: string): string {
    const threads = this.db.listProjectLabThreads(projectId).filter((thread) => thread.id !== excludedThreadId);
    const recent = new Set(threads.filter((thread) => thread.status !== "failed").slice(0, 20).map((thread) => thread.id));
    const sameMode = new Set(threads.filter((thread) => thread.mode === mode).slice(0, 12).map((thread) => thread.id));
    const prior = threads.filter((thread) => recent.has(thread.id) || sameMode.has(thread.id));
    if (prior.length === 0) return "None yet.";
    const clip = (text: string | null | undefined, limit: number) => {
      const flat = (text ?? "").replace(/\s+/g, " ").trim();
      return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
    };
    return [
      "Do not repeat, extend or lightly rephrase any of these unless the user direction asks to revisit one. Pick a different area, risk or angle, or say that nothing distinct is worth doing.",
      ...prior.map((thread) => {
        const title = thread.title.trim() || `${PROJECT_LAB_MODE_LABELS[thread.mode]} Project Lab run`;
        const summary = clip(thread.summary, 320);
        const outcome = clip(thread.outcome, 320);
        return [
          `- [${thread.status}, ${PROJECT_LAB_MODE_LABELS[thread.mode]}] ${title}`,
          summary ? ` Summary: ${summary}` : "",
          outcome && outcome !== summary ? ` Outcome: ${outcome}` : "",
        ].join("");
      }),
    ].join("\n");
  }

  buildProjectLabOpportunityInstruction(input: RunProjectLabInput, mode: ProjectLabMode): string {
    const userDirection = input.topic?.trim() ? `User direction: ${input.topic.trim()}` : null;
    const modeLabel = PROJECT_LAB_MODE_LABELS[mode];
    if (input.topic?.trim()) {
      return [
        `Chosen Project Lab mode: ${modeLabel}.`,
        userDirection,
        "Honor the user direction, but frame the work through the chosen mode unless the user explicitly asked for a different kind of outcome.",
      ]
        .filter(Boolean)
        .join(" ");
    }

    if (mode === "new-feature") {
      return [
        "Chosen Project Lab mode: New feature.",
        "Find one concrete new user-facing product feature or workflow capability, then implement the smallest useful slice.",
        "Do not default to internal cleanup unless it directly enables the feature.",
      ].join(" ");
    }
    if (mode === "bugfix") {
      return [
        "Chosen Project Lab mode: Bugfix.",
        "Look for one concrete bug or vulnerability supported by repository evidence, with priority on security issues, authorization/authentication mistakes, null/undefined/null-pointer failures, data-loss risks, race conditions, invalid state handling, and reliability failures.",
        "Do not make a change just to produce output. Do not implement cosmetic cleanup, broad refactoring, dependency upgrades, naming changes, or speculative improvements.",
        "If the inspected code looks sound and you cannot identify a defensible bug, make no code changes and explain what you inspected.",
      ].join(" ");
    }
    if (mode === "refactoring") {
      return [
        "Chosen Project Lab mode: Refactoring.",
        "Find one focused refactor that reduces complexity, coupling, duplication, or maintenance cost, then implement it with a clear safety check.",
      ].join(" ");
    }
    return [
      "Chosen Project Lab mode: RFC only.",
      "Find one larger opportunity and write an RFC only. Do not edit code.",
      "The RFC should include motivation, proposal, alternatives, risks, rollout, and open questions.",
    ].join(" ");
  }

  buildProjectLabModeBrief(mode: ProjectLabMode): string {
    if (mode === "new-feature") {
      return [
        "Mode requirements:",
        "- Prioritize a new capability that a developer using BuildWarden would notice.",
        "- Keep the implementation small enough for one worktree.",
        "- Update relevant UI, wiring, tests, and docs when needed.",
      ].join("\n");
    }
    if (mode === "bugfix") {
      return [
        "Mode requirements:",
        "- Prioritize security defects, auth/permission mistakes, null/undefined/null-pointer risks, data corruption/loss, race conditions, invalid state transitions, broken error handling, or reliability failures.",
        "- Require concrete evidence from the code path before changing files.",
        "- State the suspected failure mode before implementing.",
        "- Prefer a regression test or targeted validation that would catch the bug.",
        "- If no defensible bug is found, leave the worktree unchanged and summarize the inspected areas.",
      ].join("\n");
    }
    if (mode === "refactoring") {
      return [
        "Mode requirements:",
        "- Prioritize code health, architecture, cohesion, or simplification.",
        "- Avoid sweeping rewrites; choose a bounded refactor with a clear safety net.",
        "- Preserve behavior unless the user direction says otherwise.",
      ].join("\n");
    }
    return [
      "Mode requirements:",
      "- Produce an RFC only.",
      "- Do not edit files.",
      "- Include concrete next implementation steps, but leave execution for a future run.",
    ].join("\n");
  }

  async buildProjectLabImplementationPrompt(input: RunProjectLabInput, project: ProjectRecord, mode: ProjectLabMode, threadId: string, baseBranch: string): Promise<string> {
    const repoBrief = await this.buildProjectLabRepoBrief(project, baseBranch);
    const priorWorkBrief = this.buildProjectLabPriorWorkBrief(project.id, mode, threadId);
    const opportunityInstruction = this.buildProjectLabOpportunityInstruction(input, mode);
    const modeBrief = this.buildProjectLabModeBrief(mode);
    const agentObjective =
      mode === "bugfix"
        ? "Your job is to inspect this project, identify exactly one concrete bug or vulnerability for the selected mode, and implement a narrowly scoped fix only when the evidence supports it."
        : "Your job is to inspect this project, identify exactly one worthwhile improvement for the selected mode, and implement it directly in this workspace.";

    return [
      "You are BuildWarden Project Lab's implementation agent.",
      agentObjective,
      "Do not ask for a discussion round or wait for approval. Make a small, reviewable change.",
      "If the project evidence shows there is no safe distinct change worth making, make no code changes and explain why in the final answer.",
      "",
      `Project: ${project.name}`,
      opportunityInstruction,
      "",
      "Repository brief:",
      repoBrief,
      "",
      modeBrief,
      "",
      "Earlier Project Lab work:",
      priorWorkBrief,
      "",
      "Execution requirements:",
      "- Start by inspecting the relevant code before choosing the exact change.",
      "- State the opportunity you selected in the run output before or while implementing.",
      "- Keep changes tightly scoped to one feature, bugfix, or refactor.",
      "- Run appropriate validation when available, or inspect changed files carefully when validation is not practical.",
      "- Finish with a concise summary of what changed, why it was worth doing, and how it was checked.",
    ].join("\n");
  }
}
