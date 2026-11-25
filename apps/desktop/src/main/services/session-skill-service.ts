import type { IntegratedSkillMetadata, SkillImportInput, SkillSessionSnapshot } from "@buildwarden/shared";
import { SkillService } from "../skill-service";
import { AppService } from "./app-service";
import { ACTIVE_RUN_STATUSES } from "./app-service-constants";

/** Imports skills and selects them for runs and chats. */
export class SessionSkillService extends AppService<"activeWorkers"> {
  get skillService(): SkillService { return new SkillService(this.db); }

  async importSkill(input: SkillImportInput): Promise<IntegratedSkillMetadata> {
    return this.skillService.import(input);
  }

  async removeImportedSkill(skillId: string): Promise<void> {
    this.skillService.remove(skillId);
  }

  async getSessionSkills(kind: "run" | "chat", id: string): Promise<SkillSessionSnapshot | null> {
    if (kind !== "run" && kind !== "chat") throw new Error("Invalid session kind.");
    if (kind === "run") this.db.getRun(id); else this.db.getChat(id);
    return this.db.getSessionSkills(kind, id);
  }

  async setSessionSkills(kind: "run" | "chat", id: string, skillIds: string[] | null): Promise<void> {
    if (kind !== "run" && kind !== "chat") throw new Error("Invalid session kind.");
    if (kind === "run") {
      const run = this.db.getRun(id);
      if (this.services.activeWorkers.runWorkers.has(id) || ACTIVE_RUN_STATUSES.has(run.status)) throw new Error("Wait for the active run turn to finish before changing its skills.");
    } else {
      const chat = this.db.getChat(id);
      if (this.services.activeWorkers.chatWorkers.has(id) || ACTIVE_RUN_STATUSES.has(chat.status)) throw new Error("Wait for the active chat turn to finish before changing its skills.");
    }
    this.skillService.setSelection(kind, id, skillIds);
  }

  async listIntegratedSkills(): Promise<IntegratedSkillMetadata[]> {
    return this.skillService.list();
  }

  async getIntegratedSkillContent(skillId: string): Promise<string | null> {
    return this.skillService.content(skillId);
  }

  async prepareSessionSkills(kind: "run" | "chat", id: string, prompt: string, projectId?: string, recovery?: SkillSessionSnapshot): Promise<SkillSessionSnapshot> {
    try { return await this.skillService.prepare(kind, id, prompt, projectId, recovery); }
    catch (error) {
      const details = { errorMessage: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() };
      if (kind === "run") this.db.updateRunStatus(id, "failed", details);
      else this.db.updateChatStatus(id, "failed", details);
      throw error;
    }
  }
}
