import { readTrackedProjectFiles } from "@buildwarden/git-service";
import {
  APP_SETTING_KEYS,
  type AssistProjectForgeIssueInput,
  buildForgeIssueContextAttachment,
  buildForgeIssueRunPrompt,
  type ChatAttachmentPayload,
  type CommentProjectForgeIssueInput,
  type CreateProjectForgeIssueInput,
  descriptionClosesForgeIssue,
  type ForgeIssueReference,
  forgeIssueWorkLinkTargetId,
  type GetProjectForgeIssueDetailsInput,
  type GetProjectForgeIssueImageInput,
  type ListProjectForgeIssuesInput,
  parseProjectForgeIssueAutomationHandledSetting,
  parseProjectForgeIssueLinksSetting,
  parseProjectForgeIssuePreferencesSetting,
  PROJECT_FORGE_ISSUE_LINK_LIMIT,
  type ProjectForgeIssueActionResult,
  type ProjectForgeIssueAssistResult,
  type ProjectForgeIssueAutomationHandled,
  type ProjectForgeIssueDetailsResult,
  type ProjectForgeIssueImageResult,
  type ProjectForgeIssueMetadataResult,
  type ProjectForgeIssuesResult,
  type ProjectForgeIssueSummary,
  type ProjectForgeIssueWorkLink,
  type ProjectForgeIssueWorkLinkKind,
  type ProjectForgePrMonitorConfig,
  type ProjectForgeRequestNotificationPayload,
  type ProjectRecord,
  type ProjectTaskRecord,
  type RunRecord,
  serializeProjectForgeIssueAutomationHandledSetting,
  serializeProjectForgeIssueLinksSetting,
  type UpdateProjectForgeIssueInput,
} from "@buildwarden/shared";
import { buildForgeIssueAssistPrompt, parseForgeIssueTriage } from "../forge-issues/forge-issue-assist";
import { handledMissingFromPass, planForgeIssueAutomation } from "../forge-issues/forge-issue-automation";
import { ForgeIssueService, isSingleForgeIssueReadError } from "../forge-issues/forge-issue-service";
import { getHarnessTypeForProvider } from "../harness-adapters";
import { AppService } from "./app-service";
import { projectForgeTokenSecretKey } from "./forge-request-policy";

/** Connects GitHub and GitLab issues with tasks, runs and automations. */
export class ForgeIssueActions extends AppService<"activeWorkers" | "forgeRequests" | "modelText" | "runLifecycle"> {
  private forgeIssueServiceInstance?: ForgeIssueService;

  get forgeIssues(): ForgeIssueService {
    return this.forgeIssueServiceInstance ??= new ForgeIssueService({
      resolveContext: (projectId) => this.services.forgeRequests.resolveProjectPrReviewRemoteContext(projectId),
      readToken: (projectId) => this.secrets.readSecret(projectForgeTokenSecretKey(projectId)),
      getRepoPath: (projectId) => this.db.getProject(projectId).repoPath,
      listLinks: (projectId) => this.listForgeIssueLinks(projectId),
      onIssuesObserved: (projectId, issues) => this.syncForgeIssueTasks(projectId, issues),
    });
  }

  async listProjectForgeIssues(projectId: string, input?: ListProjectForgeIssuesInput): Promise<ProjectForgeIssuesResult> {
    return this.forgeIssues.listIssues(projectId, input);
  }

  async getProjectForgeIssueDetails(projectId: string, input: GetProjectForgeIssueDetailsInput): Promise<ProjectForgeIssueDetailsResult> {
    return this.forgeIssues.getIssueDetails(projectId, input);
  }

  async getProjectForgeIssueImage(projectId: string, input: GetProjectForgeIssueImageInput): Promise<ProjectForgeIssueImageResult> {
    return this.forgeIssues.getIssueImage(projectId, input);
  }

  async getProjectForgeIssueMetadata(projectId: string): Promise<ProjectForgeIssueMetadataResult> {
    return this.forgeIssues.getMetadata(projectId);
  }

  async createProjectForgeIssue(projectId: string, input: CreateProjectForgeIssueInput): Promise<ProjectForgeIssueActionResult> {
    return this.forgeIssues.createIssue(projectId, input);
  }

  async updateProjectForgeIssue(projectId: string, input: UpdateProjectForgeIssueInput): Promise<ProjectForgeIssueActionResult> {
    return this.forgeIssues.updateIssue(projectId, input);
  }

  async commentProjectForgeIssue(projectId: string, input: CommentProjectForgeIssueInput): Promise<ProjectForgeIssueActionResult> {
    return this.forgeIssues.commentIssue(projectId, input);
  }

  async assistProjectForgeIssue(projectId: string, input: AssistProjectForgeIssueInput): Promise<ProjectForgeIssueAssistResult> {
    const project = this.db.getProject(projectId);
    const modelId = input.modelId?.trim();
    if (!modelId) throw new Error("Select a model first.");
    if (input.kind !== "summary" && input.kind !== "triage" && input.kind !== "reply") throw new Error("Unsupported issue assistance.");
    const modelContext = await this.services.modelText.resolveModelInvocationContext(modelId);
    const { thread, context } = await this.forgeIssues.getIssueThread(projectId, input.issueNumber);

    let labels: ProjectForgeIssueMetadataResult["labels"] = [];
    let otherIssues: Array<{ number: number; title: string }> = [];
    let files: string[] = [];
    if (input.kind === "triage") {
      // Each source is optional: triage still helps with only some of them.
      const [metadata, titles, tracked] = await Promise.allSettled([
        this.forgeIssues.getMetadata(projectId),
        this.forgeIssues.listOpenIssueTitles(projectId),
        readTrackedProjectFiles(project.repoPath),
      ]);
      if (metadata.status === "fulfilled") labels = metadata.value.labels;
      if (titles.status === "fulfilled") otherIssues = titles.value;
      if (tracked.status === "fulfilled") files = tracked.value;
    }

    let run: { prompt: string; summary: string | null; status: string; pullRequestUrl: string | null } | null = null;
    if (input.kind === "reply" && input.runId) {
      const record = this.db.getRun(input.runId);
      if (record.projectId !== projectId) throw new Error("The selected run does not belong to this project.");
      run = {
        prompt: record.prompt,
        summary: record.summary,
        status: record.status,
        pullRequestUrl: this.db.getRunForgeRequestCache(record.id)?.summary?.url ?? null,
      };
    }

    const prompt = buildForgeIssueAssistPrompt(input.kind, {
      repoLabel: context.repoLabel,
      thread,
      availableLabels: labels,
      otherIssues,
      files,
      instructions: input.instructions,
      run,
    });
    let raw: string;
    try {
      raw = await this.services.modelText.askModelForText(project.repoPath, modelContext, { ...prompt, usageProjectId: project.id });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`The selected model could not answer. Try again or switch models. Detail: ${msg}`);
    }
    if (!raw.trim()) throw new Error("The model returned an empty response.");
    if (input.kind !== "triage") return { kind: input.kind, text: raw.trim(), triage: null };
    return {
      kind: "triage",
      text: "",
      triage: parseForgeIssueTriage(raw, {
        labels: labels.map((label) => label.name),
        currentLabels: thread.issue.labels.map((label) => label.name),
        issueNumbers: new Map(otherIssues.filter((issue) => issue.number !== thread.issue.number).map((issue) => [issue.number, issue.title])),
        files: files.length > 0 ? new Set(files) : null,
      }),
    };
  }

  /** New issues and new comments since the previous check, as notifications. Needs a saved token. */
  async collectProjectForgeIssueNotifications(config: ProjectForgePrMonitorConfig): Promise<ProjectForgeRequestNotificationPayload[]> {
    const notifications = await this.forgeIssues.collectNotifications(config.projectId);
    return notifications.map(({ kind, issue }) => ({
      projectId: config.projectId,
      prUrl: issue.url,
      projectName: config.projectName,
      repoLabel: config.repoLabel,
      title: `#${String(issue.number)} ${issue.title}`,
      author: kind === "new-issue" ? issue.author : null,
      providerLabel: "Issue" as const,
      headline: kind === "new-comment" ? "New issue comment" : "New issue",
    }));
  }

  /** Links of a project whose run, chat, or task still exists; stale ones are dropped from storage. */
  private listForgeIssueLinks(projectId: string): ProjectForgeIssueWorkLink[] {
    const all = parseProjectForgeIssueLinksSetting(this.db.getSettings()[APP_SETTING_KEYS.projectForgeIssueLinks]);
    const links = all[projectId] ?? [];
    if (links.length === 0) return [];
    const existing = new Map<ProjectForgeIssueWorkLinkKind, Set<string>>();
    const idsOf = (kind: ProjectForgeIssueWorkLinkKind): Set<string> => {
      let ids = existing.get(kind);
      if (!ids) {
        if (kind === "run") ids = new Set(this.db.listRunsForProject(projectId, true).map((run) => run.id));
        else if (kind === "task") ids = new Set(this.db.listProjectTasks(projectId).map((task) => task.id));
        else ids = new Set(this.db.listChats().map((chat) => chat.id));
        existing.set(kind, ids);
      }
      return ids;
    };
    const alive = links.filter((link) => idsOf(link.kind).has(forgeIssueWorkLinkTargetId(link)));
    if (alive.length !== links.length) this.writeForgeIssueLinks({ ...all, [projectId]: alive });
    return alive;
  }

  private writeForgeIssueLinks(links: Record<string, ProjectForgeIssueWorkLink[]>): void {
    const serialized = serializeProjectForgeIssueLinksSetting(links);
    if (serialized === "{}") {
      this.db.deleteSetting(APP_SETTING_KEYS.projectForgeIssueLinks);
    } else {
      this.db.setSetting(APP_SETTING_KEYS.projectForgeIssueLinks, serialized);
    }
  }

  /**
   * Remembers that a run, chat, or task was started for an issue. The reference comes from a client,
   * so a malformed one is ignored instead of failing the run, chat, or task it came with.
   */
  recordForgeIssueLink(
    reference: Pick<ForgeIssueReference, "number" | "url" | "title"> | undefined,
    projectId: string,
    kind: ProjectForgeIssueWorkLinkKind,
    targetId: string,
  ): void {
    if (!reference || typeof reference !== "object" || !projectId) return;
    if (typeof reference.number !== "number" || !Number.isInteger(reference.number) || reference.number <= 0) return;
    try {
      this.db.getProject(projectId);
      const all = parseProjectForgeIssueLinksSetting(this.db.getSettings()[APP_SETTING_KEYS.projectForgeIssueLinks]);
      const link: ProjectForgeIssueWorkLink = {
        kind,
        issueNumber: reference.number,
        issueUrl: typeof reference.url === "string" ? reference.url : "",
        issueTitle: typeof reference.title === "string" ? reference.title.slice(0, 300) : "",
        createdAt: new Date().toISOString(),
        ...(kind === "run" ? { runId: targetId } : kind === "chat" ? { chatId: targetId } : { taskId: targetId }),
      };
      this.writeForgeIssueLinks({ ...all, [projectId]: [...(all[projectId] ?? []), link].slice(-PROJECT_FORGE_ISSUE_LINK_LIMIT) });
    } catch (error) {
      this.logControllerWarn("Could not record the issue a run, chat, or task was started for.", { projectId, kind, error });
    }
  }

  /**
   * Adds `Closes #N` to a PR/MR description for a run that was started from an issue,
   * unless the description already closes that issue. Naming the issue is not enough: the default
   * description quotes the run prompt ("Fix issue #N"), which closes nothing. Plan-only runs change no code and close nothing.
   */
  withForgeIssueClosingReference(run: RunRecord, description: string): string {
    if (run.mode !== "code") return description;
    const link = this.findForgeIssueLinkForRun(run);
    if (!link) return description;
    return descriptionClosesForgeIssue(description, { number: link.issueNumber, url: link.issueUrl })
      ? description
      : `${description}\n\nCloses #${String(link.issueNumber)}`;
  }

  /** Issue a run was started for, if any. */
  findForgeIssueLinkForRun(run: Pick<RunRecord, "id" | "projectId">): ProjectForgeIssueWorkLink | null {
    const links = parseProjectForgeIssueLinksSetting(this.db.getSettings()[APP_SETTING_KEYS.projectForgeIssueLinks])[run.projectId] ?? [];
    return links.find((link) => link.kind === "run" && link.runId === run.id) ?? null;
  }

  /** Issue a Task Board entry was created for, if any. */
  findForgeIssueReferenceForTask(projectId: string, taskId: string | null | undefined): Pick<ForgeIssueReference, "number" | "url" | "title"> | undefined {
    if (!taskId) return undefined;
    const links = parseProjectForgeIssueLinksSetting(this.db.getSettings()[APP_SETTING_KEYS.projectForgeIssueLinks])[projectId] ?? [];
    const link = links.find((entry) => entry.kind === "task" && entry.taskId === taskId);
    return link ? { number: link.issueNumber, url: link.issueUrl, title: link.issueTitle } : undefined;
  }

  /** Marks Task Board tasks done once the issue they track is closed on the Git host. */
  private syncForgeIssueTasks(projectId: string, issues: ProjectForgeIssueSummary[]): void {
    const closed = new Set(issues.filter((issue) => issue.state === "closed").map((issue) => issue.number));
    if (closed.size === 0) return;
    try {
      const links = parseProjectForgeIssueLinksSetting(this.db.getSettings()[APP_SETTING_KEYS.projectForgeIssueLinks])[projectId] ?? [];
      for (const link of links) {
        if (link.kind !== "task" || !link.taskId || !closed.has(link.issueNumber)) continue;
        let task: ProjectTaskRecord;
        try {
          task = this.db.getProjectTask(link.taskId);
        } catch {
          continue;
        }
        if (task.status === "done") continue;
        const updated = this.db.updateProjectTask(task.id, { status: "done" });
        this.events.publish("task", { projectId: updated.projectId, taskId: updated.id, status: updated.status });
      }
    } catch (error) {
      this.logControllerWarn("Could not update tasks from their linked issues.", { projectId, error });
    }
  }

  private readonly forgeIssueAutomationCheckedAt = new Map<string, number>();
  private forgeIssueAutomationTickActive = false;

  /** The issue an automation was started for, as the prompt step's agent receives it. */
  async prepareForgeIssueAutomationContext(projectId: string, issueNumber: number): Promise<{
    prompt: string;
    attachment: ChatAttachmentPayload;
    reference: ForgeIssueReference;
  }> {
    const { thread, context } = await this.forgeIssues.getIssueThread(projectId, issueNumber, true);
    return {
      prompt: buildForgeIssueRunPrompt(thread.issue, "implement"),
      attachment: buildForgeIssueContextAttachment({
        repoLabel: context.repoLabel,
        issue: thread.issue,
        timeline: thread.timeline,
        linkedRequests: thread.linkedRequests,
        subIssues: thread.subIssues,
      }),
      reference: { projectId, provider: thread.issue.provider, number: thread.issue.number, url: thread.issue.url, title: thread.issue.title },
    };
  }

  /**
   * Starts a run for each open issue that carries a project's trigger label and has no run yet.
   * Runs keep shell approvals on: issue text is written by other people.
   */
  async runForgeIssueAutomationTick(): Promise<void> {
    if (this.services.activeWorkers.agentWorkersStopping || this.forgeIssueAutomationTickActive) return;
    this.forgeIssueAutomationTickActive = true;
    try {
      const preferences = parseProjectForgeIssuePreferencesSetting(this.db.getSettings()[APP_SETTING_KEYS.projectForgeIssuePreferences]);
      for (const [projectId, { automation }] of Object.entries(preferences)) {
        if (this.services.activeWorkers.agentWorkersStopping) break;
        if (!automation?.enabled) continue;
        const now = Date.now();
        if (now - (this.forgeIssueAutomationCheckedAt.get(projectId) ?? 0) < automation.intervalMinutes * 60_000) continue;
        this.forgeIssueAutomationCheckedAt.set(projectId, now);
        try {
          await this.startRunsForLabelledForgeIssues(projectId, automation);
        } catch (error) {
          this.logControllerWarn("Could not start runs for labelled issues.", { projectId, error });
        }
      }
    } catch (error) {
      // Nobody awaits the tick, so a rejection would end the app. The next tick tries again.
      this.logControllerError("Could not read the issue automations.", error);
    } finally {
      this.forgeIssueAutomationTickActive = false;
    }
  }

  private readForgeIssueAutomationHandled(projectId: string): ProjectForgeIssueAutomationHandled {
    const all = parseProjectForgeIssueAutomationHandledSetting(this.db.getSettings()[APP_SETTING_KEYS.projectForgeIssueAutomationHandled]);
    return all[projectId] ?? { issueNumbers: [], listReadAt: null };
  }

  private writeForgeIssueAutomationHandled(projectId: string, state: ProjectForgeIssueAutomationHandled): void {
    const all = parseProjectForgeIssueAutomationHandledSetting(this.db.getSettings()[APP_SETTING_KEYS.projectForgeIssueAutomationHandled]);
    // Never shortened here: a forgotten issue that still carries the label would get a second run.
    const next = { issueNumbers: [...state.issueNumbers], listReadAt: state.listReadAt };
    const current = all[projectId] ?? { issueNumbers: [], listReadAt: null };
    if (
      current.listReadAt === next.listReadAt
      && current.issueNumbers.length === next.issueNumbers.length
      && current.issueNumbers.every((issueNumber, index) => issueNumber === next.issueNumbers[index])
    ) {
      return;
    }
    const serialized = serializeProjectForgeIssueAutomationHandledSetting({ ...all, [projectId]: next });
    if (serialized === "{}") {
      this.db.deleteSetting(APP_SETTING_KEYS.projectForgeIssueAutomationHandled);
    } else {
      this.db.setSetting(APP_SETTING_KEYS.projectForgeIssueAutomationHandled, serialized);
    }
  }

  private async startRunsForLabelledForgeIssues(
    projectId: string,
    automation: { label: string; modelId: string; mode: "code" | "plan" },
  ): Promise<void> {
    let project: ProjectRecord;
    try {
      project = this.db.getProject(projectId);
    } catch {
      return;
    }
    if (project.kind !== "git") return;
    const { issues, pass } = await this.forgeIssues.listOpenIssuesWithLabel(projectId, automation.label);
    // Which issues were dealt with is remembered apart from the issue links: links are capped and vanish
    // with a deleted run, and neither may start a second run for the same labelling.
    const remembered = this.readForgeIssueAutomationHandled(projectId);
    // Reading a long list page by page can miss an issue that still carries the label. A handled issue is
    // forgotten only once it was read on its own and found closed or without the label.
    const missing = handledMissingFromPass(remembered.issueNumbers, pass);
    const confirmedUnlabelled = missing.length > 0 ? await this.forgeIssues.confirmLabelRemoved(projectId, automation.label, missing) : [];
    const plan = planForgeIssueAutomation({
      labelled: issues.map((issue) => issue.number),
      pass: pass ? { labelled: pass.labelled, startedAt: new Date(pass.startedAt).toISOString() } : null,
      confirmedUnlabelled,
      runs: this.listForgeIssueLinks(projectId).filter((link) => link.kind === "run").map((link) => ({ issueNumber: link.issueNumber, createdAt: link.createdAt })),
      handled: remembered.issueNumbers,
      listReadAt: remembered.listReadAt,
    });
    const handled = plan.handled;
    this.writeForgeIssueAutomationHandled(projectId, { issueNumbers: handled, listReadAt: plan.listReadAt });
    const pending = new Set(plan.pending);
    if (pending.size === 0) return;
    const model = this.db.getModel(automation.modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    // A few per check, so a mass-labelling does not launch dozens of agents at once.
    let started = 0;
    for (const issue of issues.filter((entry) => pending.has(entry.number))) {
      if (started >= 3 || this.services.activeWorkers.agentWorkersStopping) return;
      let loaded: Awaited<ReturnType<ForgeIssueService["getIssueThread"]>>;
      try {
        loaded = await this.forgeIssues.getIssueThread(projectId, issue.number, true);
      } catch (error) {
        if (!isSingleForgeIssueReadError(error)) throw error;
        // The issue stays pending, so a later check tries it again.
        this.logControllerWarn("Could not read a labelled issue.", { projectId, issueNumber: issue.number, error });
        continue;
      }
      const { thread, context } = loaded;
      // The issue may have been closed or unlabelled since the list was read.
      const wantedLabel = automation.label.trim().toLowerCase();
      if (thread.issue.state !== "open" || !thread.issue.labels.some((label) => label.name.trim().toLowerCase() === wantedLabel)) continue;
      await this.services.runLifecycle.createRun({
        projectId,
        providerAccountId: provider.id,
        modelId: model.id,
        harnessType: getHarnessTypeForProvider(provider.providerType),
        mode: automation.mode,
        yoloMode: false,
        workspaceType: "worktree",
        baseBranch: project.baseBranch,
        prompt: buildForgeIssueRunPrompt(thread.issue, automation.mode === "plan" ? "investigate" : "implement"),
        attachments: [buildForgeIssueContextAttachment({
          repoLabel: context.repoLabel,
          issue: thread.issue,
          timeline: thread.timeline,
          linkedRequests: thread.linkedRequests,
          subIssues: thread.subIssues,
        })],
        forgeIssue: { projectId, provider: thread.issue.provider, number: thread.issue.number, url: thread.issue.url, title: thread.issue.title },
      }, { background: true });
      started += 1;
      handled.push(issue.number);
      this.writeForgeIssueAutomationHandled(projectId, { issueNumbers: handled, listReadAt: plan.listReadAt });
      this.events.publish("forgeRequestNotification", {
        projectId,
        prUrl: thread.issue.url,
        projectName: project.name,
        repoLabel: context.repoLabel,
        title: `#${String(thread.issue.number)} ${thread.issue.title}`,
        author: null,
        providerLabel: "Issue",
        headline: `Run started for the "${automation.label}" label`,
      });
    }
  }
}
