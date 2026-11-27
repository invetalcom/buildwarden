import type { AcpAgentSessionImportInput, AcpAgentSessionList, ProviderAccountRecord, RunRecord } from "@buildwarden/shared";
import { loadAcpProvider } from "../provider-modules";
import { AppService } from "./app-service";
import { SELECTED_PROJECT_KEY, SELECTED_RUN_KEY } from "./app-service-constants";

const IMPORTED_TITLE_MAX_LENGTH = 120;

const providerConfig = (provider: ProviderAccountRecord): Record<string, unknown> => {
  try {
    return JSON.parse(provider.configJson || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

/**
 * Sessions an ACP agent saved on its own (`session/list`), and their import as runs. An imported
 * run holds the conversation the agent replays, works on the project's own checkout, where the
 * session was made, and continues the agent's session on its next message.
 */
export class AcpSessionService extends AppService<"runEvents"> {
  private acpProvider(providerAccountId: string): ProviderAccountRecord {
    const provider = this.db.getProviderAccount(providerAccountId);
    if (provider.providerType !== "acp") throw new Error("Only ACP agents can list their sessions.");
    return provider;
  }

  async listAcpAgentSessions(providerAccountId: string, projectId: string): Promise<AcpAgentSessionList> {
    const provider = this.acpProvider(providerAccountId);
    const project = this.db.getProject(projectId);
    const acp = await loadAcpProvider();
    const listed = await acp.listAcpSessions({ cwd: project.repoPath, config: providerConfig(provider) });
    const imported = new Set(this.importedSessionIds(provider.id));
    return { supported: listed.supported, sessions: listed.sessions.map((session) => ({ ...session, imported: imported.has(session.sessionId) })) };
  }

  /** Session ids this provider's runs already continue, so the list can mark them. */
  private importedSessionIds(providerAccountId: string): string[] {
    return this.db.listProviderAccountResumeCursors(providerAccountId, "run")
      .map((entry) => entry.resumeCursor?.sessionId)
      .filter((sessionId): sessionId is string => typeof sessionId === "string");
  }

  async importAcpAgentSession(input: AcpAgentSessionImportInput): Promise<RunRecord> {
    const provider = this.acpProvider(input.providerAccountId);
    const project = this.db.getProject(input.projectId);
    const sessionId = input.sessionId.trim();
    if (!sessionId) throw new Error("Choose a session to import.");
    const model = this.db.listModels().find((entry) => entry.providerAccountId === provider.id && Boolean(entry.enabled));
    if (!model) throw new Error(`Add a model for ${provider.label} before importing its sessions.`);
    const acp = await loadAcpProvider();
    const transcript = await acp.readAcpSessionTranscript({ cwd: project.repoPath, sessionId, config: providerConfig(provider) });
    const firstUser = transcript.messages.find((message) => message.role === "user")?.text;
    const label = input.title?.trim() || firstUser?.split("\n")[0]?.trim() || `Agent session ${sessionId.slice(0, 12)}`;
    const branchName = project.kind === "folder" ? "project-folder" : await this.gitService.getCurrentBranch(project.repoPath);
    let run = this.db.createRun({
      projectId: project.id,
      providerAccountId: provider.id,
      modelId: model.id,
      harnessType: "acp",
      mode: "code",
      workspaceType: "local",
      workspaceVcs: project.kind === "folder" ? "folder" : "git",
      prompt: firstUser ?? label,
      branchName,
      worktreePath: project.repoPath,
    });
    try {
      const messages = transcript.messages.length > 0 ? transcript.messages : [{ role: "user" as const, text: label }];
      let prompts = 0;
      for (const message of messages) {
        if (message.role === "user") {
          await this.services.runEvents.appendRunEvent(run.id, "log", prompts === 0 ? "Initial command" : "Follow-up", message.text, {
            source: "user", commandType: prompts === 0 ? "initial" : "follow-up", mode: "code",
            modelId: model.id, providerAccountId: provider.id, importedFromAgentSession: true,
          });
          prompts += 1;
        } else {
          await this.services.runEvents.appendRunEvent(run.id, "output", "Agent output", message.text, { provider: "acp", importedFromAgentSession: true });
        }
      }
      const content = transcript.loaded
        ? `Imported the agent's session from ${provider.label}. The next message continues that session.`
        : `${provider.label} cannot replay saved sessions, so its conversation is not shown here. The next message continues the agent's session if the agent can resume it.`;
      await this.services.runEvents.appendRunEvent(run.id, "status", "Agent session imported", content, { importedAgentSessionId: sessionId });
      this.db.upsertProviderSessionRuntime({
        ownerId: run.id, ownerKind: "run", providerAccountId: provider.id, providerType: "acp", harnessType: "acp",
        status: "ready", cwd: project.repoPath, modelId: model.modelId, runtimeMode: "code",
        resumeCursor: { sessionId }, runtimePayload: { sessionType: "run" },
      });
      const lastAnswer = [...transcript.messages].reverse().find((message) => message.role === "assistant")?.text ?? null;
      run = this.db.updateRunStatus(run.id, "completed", { summary: lastAnswer });
      this.db.renameSessionTitle("run", run.id, label.length <= IMPORTED_TITLE_MAX_LENGTH ? label : `${label.slice(0, IMPORTED_TITLE_MAX_LENGTH - 1)}…`);
    } catch (error) {
      this.db.deleteRun(run.id);
      throw error;
    }
    this.db.touchProject(project.id);
    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.db.setSetting(SELECTED_RUN_KEY, run.id);
    this.services.runEvents.emitEvent({ runId: run.id, type: "status", title: "Agent session imported", content: sessionId, metadata: {}, createdAt: new Date().toISOString() });
    return this.db.getRun(run.id);
  }
}
