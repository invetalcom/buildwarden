import { existsSync, mkdirSync } from "node:fs";
import { getChatWorkspacePath } from "../chat-workspace";
import { SessionTitleService, type TitleGenerationInput } from "../session-titles";
import { AppService } from "./app-service";

/** Generates and renames run and chat titles. */
export class TitleService extends AppService<"modelText" | "providerRuntime" | "runEvents"> {
  sessionTitleServiceInstance?: SessionTitleService;

  get sessionTitles(): SessionTitleService {
    return this.sessionTitleServiceInstance ??= new SessionTitleService(
      this.db,
      (input) => this.generateSessionTitle(input),
      (kind, id) => {
        const event = { runId: id, type: "status" as const, title: "Title updated", content: "", metadata: { sessionTitle: true }, createdAt: new Date().toISOString() };
        if (kind === "run") this.services.runEvents.emitEvent(event);
        else this.services.runEvents.emitChatEvent(id, event);
      },
      (error) => this.logControllerWarn("Could not generate a conversation title.", { error }),
    );
  }

  private async generateSessionTitle(input: TitleGenerationInput): Promise<string> {
    const run = input.kind === "run" ? this.db.getRun(input.id) : null;
    const chat = input.kind === "chat" ? this.db.getChat(input.id) : null;
    const parent = run ?? (chat?.runId ? this.db.getRun(chat.runId) : null);
    const project = parent ? this.db.getProject(parent.projectId) : null;
    const cwd = parent && existsSync(parent.worktreePath) ? parent.worktreePath : project?.repoPath ?? getChatWorkspacePath(this.db.getFilePath(), input.id);
    if (!project) mkdirSync(cwd, { recursive: true });
    const context = await this.services.modelText.resolveModelInvocationContext(input.modelId);
    input.signal.throwIfAborted();
    using _titleCliStart = this.services.providerRuntime.reserveProviderCliStart(context.provider.providerType);
    return await this.services.modelText.askModelForUtilityText(cwd, context, {
      purpose: "session-title", prompt: input.prompt, systemPrompt: input.systemPrompt,
      maxTokens: 500, temperature: 0.2, usageProjectId: project?.id, signal: input.signal,
    });
  }

  async renameRunTitle(id: string, title: string): Promise<void> { this.sessionTitles.rename("run", id, title); }

  async regenerateRunTitle(id: string): Promise<void> { await this.sessionTitles.regenerate("run", id); }

  async renameChatTitle(id: string, title: string): Promise<void> { this.sessionTitles.rename("chat", id, title); }

  async regenerateChatTitle(id: string): Promise<void> { await this.sessionTitles.regenerate("chat", id); }
}
