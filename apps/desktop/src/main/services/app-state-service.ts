import { APP_SETTING_KEYS, type AppSnapshot } from "@buildwarden/shared";
import { logInfo } from "../logger";
import { AppService } from "./app-service";
import { SELECTED_CHAT_KEY, SELECTED_PROJECT_KEY, SELECTED_RUN_KEY } from "./app-service-constants";

const parseProjectOrderSetting = (raw: string | undefined): string[] => {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [];
  } catch {
    return [];
  }
};

/** Builds the app snapshot and maintains the selected and ordered projects, runs and chats. */
export class AppStateService extends AppService {
  private applyProjectOrder(snapshot: AppSnapshot): AppSnapshot {
    const order = parseProjectOrderSetting(snapshot.settings[APP_SETTING_KEYS.projectOrder]);
    if (order.length === 0 || snapshot.projects.length <= 1) {
      return snapshot;
    }
    const priorityById = new Map(order.map((projectId, index) => [projectId, index]));
    const projects = [...snapshot.projects].sort((left, right) => {
      const leftPriority = priorityById.get(left.project.id);
      const rightPriority = priorityById.get(right.project.id);
      if (leftPriority != null && rightPriority != null) {
        return leftPriority - rightPriority;
      }
      if (leftPriority != null) {
        return -1;
      }
      if (rightPriority != null) {
        return 1;
      }
      return 0;
    });
    return { ...snapshot, projects };
  }

  async getSnapshot(): Promise<AppSnapshot> {
    const settings = this.db.getSettings();
    return this.applyProjectOrder(this.db.getSnapshot(
      settings[SELECTED_PROJECT_KEY] ?? null,
      settings[SELECTED_RUN_KEY] ?? null,
      settings[SELECTED_CHAT_KEY] ?? null,
    ));
  }

  async refreshSnapshot(): Promise<AppSnapshot> {
    return this.getSnapshot();
  }

  async selectProject(projectId: string): Promise<void> {
    const project = this.db.getProject(projectId);
    this.db.touchProject(project.id);
    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.db.deleteSetting(SELECTED_RUN_KEY);
    this.db.deleteSetting(SELECTED_CHAT_KEY);
  }

  async reorderProjects(projectIds: string[]): Promise<void> {
    const knownProjectIds = new Set(this.db.listProjects().map((project) => project.id));
    const normalized = projectIds.filter((projectId, index) => knownProjectIds.has(projectId) && projectIds.indexOf(projectId) === index);
    if (normalized.length === 0) {
      throw new Error("Project order update did not include any valid projects.");
    }
    this.db.setSetting(APP_SETTING_KEYS.projectOrder, JSON.stringify(normalized));
    logInfo("Updated custom sidebar project order.", {
      projectCount: normalized.length,
      projectIds: normalized,
    });
  }

  restoreSelectionAfterDeletion(previousSelection: Record<string, string>): void {
    const restoreExisting = (
      key: string,
      lookup: (id: string) => unknown,
    ) => {
      const previousId = previousSelection[key];
      if (previousId) {
        try {
          lookup(previousId);
          this.db.setSetting(key, previousId);
          return;
        } catch {
          /* The previously selected object was part of the deletion cascade. */
        }
      }
      this.db.deleteSetting(key);
    };

    restoreExisting(SELECTED_PROJECT_KEY, (id) => this.db.getProject(id));
    restoreExisting(SELECTED_RUN_KEY, (id) => this.db.getRun(id));
    restoreExisting(SELECTED_CHAT_KEY, (id) => this.db.getChat(id));
  }

  /**
   * Runs a background loop action that internally moves the renderer's project/run
   * selection (createRun / followUpRunInternal do) and restores the previous
   * selection afterwards, including on failure.
   */
  async withPreservedRunSelection<T>(action: () => Promise<T>): Promise<T> {
    const settings = this.db.getSettings();
    const previousProjectId = settings[SELECTED_PROJECT_KEY];
    const previousRunId = settings[SELECTED_RUN_KEY];
    try {
      return await action();
    } finally {
      if (previousRunId) {
        this.db.setSetting(SELECTED_RUN_KEY, previousRunId);
      } else {
        this.db.deleteSetting(SELECTED_RUN_KEY);
      }
      if (previousProjectId) {
        this.db.setSetting(SELECTED_PROJECT_KEY, previousProjectId);
      } else {
        this.db.deleteSetting(SELECTED_PROJECT_KEY);
      }
    }
  }
}
