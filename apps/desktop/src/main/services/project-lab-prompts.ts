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

  buildProjectLabAvoidanceBrief(projectId: string, excludedThreadId?: string): string {
    const priorThreads = this.db
      .listProjectLabThreads(projectId)
      .filter((thread) => thread.id !== excludedThreadId)
      .filter((thread) => thread.status !== "failed")
      .slice(0, 20);

    if (priorThreads.length === 0) {
      return "No prior Project Lab topics yet.";
    }

    return [
      "Avoid repeating or lightly rephrasing these existing Project Lab topics unless the user explicitly asked to revisit one:",
      ...priorThreads.map((thread) => {
        const summary = thread.summary.trim() ? ` - ${thread.summary.trim()}` : "";
        const outcome = thread.outcome?.trim() ? ` Outcome: ${thread.outcome.trim().slice(0, 280)}` : "";
        const implementation = thread.implementationPrompt?.trim()
          ? ` Implementation: ${thread.implementationPrompt.trim().slice(0, 280)}`
          : "";
        return `- [${thread.status}] ${thread.title}${summary}${outcome}${implementation}`;
      }),
      "",
      "Choose a substantially different code area, risk, feature, or refactoring angle. If no distinct idea is worth pursuing, say so instead of duplicating prior work.",
    ].join("\n");
  }

  buildProjectLabSameModePriorWorkBrief(projectId: string, mode: ProjectLabMode, excludedThreadId?: string): string {
    const priorThreads = this.db
      .listProjectLabThreads(projectId)
      .filter((thread) => thread.id !== excludedThreadId)
      .filter((thread) => thread.mode === mode)
      .slice(0, 12);

    if (priorThreads.length === 0) {
      return `No previous ${PROJECT_LAB_MODE_LABELS[mode]} Project Lab runs yet.`;
    }

    return [
      `Previous ${PROJECT_LAB_MODE_LABELS[mode]} Project Lab runs. Treat these as already explored or worked on:`,
      ...priorThreads.map((thread) => {
        const topic = thread.title.trim() || `${PROJECT_LAB_MODE_LABELS[thread.mode]} Project Lab run`;
        const summary = thread.summary.trim() ? ` Summary: ${thread.summary.trim().slice(0, 320)}` : "";
        const outcome = thread.outcome?.trim() ? ` Outcome: ${thread.outcome.trim().slice(0, 320)}` : "";
        const implementation = thread.implementationPrompt?.trim()
          ? ` Worked-on implementation: ${thread.implementationPrompt.trim().slice(0, 520)}`
          : "";
        return `- [${thread.status}] Topic: ${topic}.${summary}${outcome}${implementation}`;
      }),
      "",
      "Do not implement, fix, refactor, or lightly rephrase any topic listed above unless the user explicitly asked to revisit it. Otherwise pick a genuinely different area and value/risk, or explicitly conclude that there is no distinct same-mode opportunity worth starting.",
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
    const avoidanceBrief = this.buildProjectLabAvoidanceBrief(project.id, threadId);
    const sameModePriorWorkBrief = this.buildProjectLabSameModePriorWorkBrief(project.id, mode, threadId);
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
      "Existing Project Lab topics to avoid:",
      avoidanceBrief,
      "",
      "Previous same-mode Project Lab work to avoid:",
      sameModePriorWorkBrief,
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
