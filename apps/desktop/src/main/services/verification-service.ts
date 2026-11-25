import { resolve } from "node:path";
import {
  APP_SETTING_KEYS,
  parseProjectRunDefaultsSetting,
  parseRevisionVerificationPolicy,
  type RunRecord,
  type RunVerificationRecord,
  type RunVerificationState,
  verificationMatches,
} from "@buildwarden/shared";
import { verifyWorkspaceRevision } from "../revision-verification";
import { captureWorkspaceRevision } from "../workspace-revision";
import { AppService } from "./app-service";

/** Verifies run revisions with the project's commands. */
export class VerificationService extends AppService<"activeWorkers" | "runEvents" | "workspaceGuard"> {
  private readonly revisionChecks = new Map<string, Promise<RunVerificationRecord>>();

  async setProjectRevisionVerificationPolicy(projectId: string, enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("Verification policy must be a boolean.");
    this.db.setProjectRevisionVerificationPolicy(projectId, enabled);
  }

  async getRunVerification(runId: string): Promise<RunVerificationState> {
    const run = this.db.getRun(runId);
    const settings = this.db.getSettings();
    const commands = parseProjectRunDefaultsSetting(settings[APP_SETTING_KEYS.projectRunDefaults])[run.projectId]?.verificationCommands ?? [];
    const record = this.db.getRunVerification(runId);
    const state: RunVerificationState = {
      record, commands, currentRevision: null,
      requiredBeforePublish: parseRevisionVerificationPolicy(settings[APP_SETTING_KEYS.revisionVerificationPolicy])[run.projectId] === true,
      status: commands.length ? record?.status ?? "not-run" : "unconfigured", reason: record?.error ?? null,
    };
    if (!commands.length) return state;
    if (this.services.workspaceGuard.pendingManualVerifications.has(runId) || (record?.status === "running" && this.services.activeWorkers.runWorkers.has(runId))) {
      state.status = "running"; return state;
    }
    if (record?.status === "running") { state.status = "cancelled"; state.reason = "Verification was interrupted. Run it again."; }
    try {
      state.currentRevision = await captureWorkspaceRevision(this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, this.db.getProject(run.projectId)), run.workspaceVcs);
      if (record && state.status !== "unconfigured" && state.status !== "cancelled" && !verificationMatches(record, state.currentRevision, commands)) {
        state.status = "stale"; state.reason = "Workspace contents or verification commands changed since this check.";
      }
    } catch (error) { state.status = "unavailable"; state.reason = error instanceof Error ? error.message : String(error); }
    return state;
  }

  async verifyRunRevision(runId: string): Promise<RunVerificationState> {
    const run = this.db.getRun(runId);
    if (this.services.workspaceGuard.pendingManualVerifications.has(runId)) throw new Error("Verification is already running.");
    if (["queued", "preparing", "running"].includes(run.status)) throw new Error("Wait for the agent to finish before verifying.");
    const abort = new AbortController();
    const completion = this.services.workspaceGuard.serializeProjectBranchMutation(run.projectId, async () => {
      if (abort.signal.aborted) throw new Error("Verification cancelled.");
      this.services.workspaceGuard.manualVerifications.set(runId, { abort, completion });
      try {
        const current = this.db.getRun(runId);
        if (["queued", "preparing", "running"].includes(current.status)) throw new Error("Wait for the agent to finish before verifying.");
        if (this.db.listRunsForProject(run.projectId).some((other) => other.id !== runId && resolve(other.worktreePath) === resolve(current.worktreePath) && ["queued", "preparing", "running"].includes(other.status))) throw new Error("Another agent is using this workspace. Wait for it to finish.");
        const commands = parseProjectRunDefaultsSetting(this.db.getSettings()[APP_SETTING_KEYS.projectRunDefaults])[run.projectId]?.verificationCommands ?? [];
        if (!commands.length) throw new Error("Configure verification commands in project settings first.");
        const workspace = this.services.workspaceGuard.getEffectiveRunWorkspacePath(current, this.db.getProject(current.projectId));
        if (current.workspaceVcs === "git" && await this.gitService.getCurrentBranch(workspace) !== current.branchName) throw new Error("Check out the run branch before verifying it.");
        const record = await this.executeRevisionCheck(current, commands, abort.signal);
        const title = `Revision verification: ${record.status}`;
        await this.services.runEvents.appendRunEvent(runId, "status", title, record.error ?? commands.join("\n"), { revisionVerification: true, fingerprint: record.revision?.fingerprint, verificationStatus: record.status });
        this.services.runEvents.emitEvent({ runId, type: "status", title, content: record.error ?? "Verification evidence saved.", createdAt: new Date().toISOString() });
      } finally { this.services.workspaceGuard.manualVerifications.delete(runId); }
    });
    // Track queued requests separately so cancellation also works while a run start owns the lock.
    this.services.workspaceGuard.pendingManualVerifications.set(runId, { abort, completion });
    try { await completion; } finally { this.services.workspaceGuard.pendingManualVerifications.delete(runId); }
    return this.getRunVerification(runId);
  }

  async cancelRunVerification(runId: string): Promise<void> {
    this.db.getRun(runId);
    const manual = this.services.workspaceGuard.pendingManualVerifications.get(runId);
    manual?.abort.abort();
    this.services.activeWorkers.runWorkers.get(runId)?.verificationAbortController?.abort();
    if (manual) await manual.completion.catch(() => undefined);
    await this.revisionChecks.get(runId)?.catch(() => undefined);
  }

  async stopRevisionVerifications(): Promise<void> {
    for (const entry of this.services.workspaceGuard.pendingManualVerifications.values()) entry.abort.abort();
    for (const worker of this.services.activeWorkers.runWorkers.values()) worker.verificationAbortController?.abort();
    await Promise.allSettled([...this.services.workspaceGuard.pendingManualVerifications.values()].map((entry) => entry.completion));
    await Promise.allSettled([...this.revisionChecks.values()]);
  }

  async executeRevisionCheck(run: RunRecord, commands: string[], signal: AbortSignal): Promise<RunVerificationRecord> {
    const pending = verifyWorkspaceRevision({ runId: run.id, cwd: this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, this.db.getProject(run.projectId)), vcs: run.workspaceVcs, commands, signal, save: (record) => this.db.saveRunVerification(record) });
    this.revisionChecks.set(run.id, pending);
    try { return await pending; } finally { this.revisionChecks.delete(run.id); }
  }

  async requireVerifiedRevision(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
    const settings = this.db.getSettings();
    if (!parseRevisionVerificationPolicy(settings[APP_SETTING_KEYS.revisionVerificationPolicy])[run.projectId]) return;
    const commands = parseProjectRunDefaultsSetting(settings[APP_SETTING_KEYS.projectRunDefaults])[run.projectId]?.verificationCommands ?? [];
    if (!commands.length) return;
    if (run.workspaceVcs === "git" && await this.gitService.getCurrentBranch(this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, this.db.getProject(run.projectId))) !== run.branchName) throw new Error("Check out the run branch before verifying and publishing it.");
    const state = await this.getRunVerification(runId);
    if (state.status !== "passed") throw new Error(`Current revision must pass verification before publishing (${state.status}). Run verification from the run detail screen.`);
  }
}
