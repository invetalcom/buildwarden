import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { BuildWardenDatabase } from "@buildwarden/db";
import type { GitService } from "@buildwarden/git-service";
import type { NetworkProxyRuntimeConfig, PendingRunRewind, RunRecord, RunRewindInput, RunRewindResult, RunTurnRestorePoint } from "@buildwarden/shared";
import { logWarn } from "./logger";

/** Treats missing or malformed event metadata as absent evidence for native rewind. */
const metadata = (json: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
};

/**
 * Rewinds to the boundary before a selected prompt and returns that prompt for editing.
 * Detaches provider cursors durably before touching native history or files. The journal
 * allows the same operation to resume after failure; file recovery can be explicitly
 * downgraded to conversation-only. The controller must serialize access and block new work.
 */
export async function executeRunRewind(options: {
  db: BuildWardenDatabase;
  git: GitService;
  run: RunRecord;
  input: RunRewindInput;
  assertSafe: () => void;
  beforeRestoreFiles?: () => void;
  networkProxy?: NetworkProxyRuntimeConfig;
}): Promise<RunRewindResult> {
  const { db, git, run, input, assertSafe } = options;
  const point = db.getRunTurnRestorePoint(run.id, input.restorePointId);
  if (!point) throw new Error("This prompt restore point is no longer available.");
  const steps = db.getRunSteps(run.id);
  const boundary = steps.findIndex((step) => step.id === point.stepId);
  if (boundary < 0) throw new Error("The selected prompt is no longer in active history.");
  const restoreFiles = input.mode === "conversation-and-files";
  if (restoreFiles && (!point.filesAvailable || point.patch === null || !point.headSha)) {
    throw new Error("This prompt has no file snapshot. Choose conversation only.");
  }
  let operation = db.getPendingRunRewind(run.id);
  if (operation && operation.input.restorePointId !== input.restorePointId) {
    throw new Error("Finish the pending rewind before selecting another prompt or mode.");
  }
  if (operation && operation.input.mode !== input.mode) {
    if (input.mode !== "conversation") throw new Error("A pending conversation rewind cannot be changed to restore files.");
    // Explicit recovery escape: retain the current files when a file restore cannot be retried.
    operation.input = input;
    db.savePendingRunRewind(operation);
  }
  if (restoreFiles) {
    assertSafe();
    if (await git.getHeadCommitSha(run.worktreePath) !== point.headSha) {
      throw new Error("The workspace has new commits since this prompt. Choose conversation only or revert those commits with Git first.");
    }
  }
  if (!operation) {
    operation = {
      id: randomUUID(), input, createdAt: new Date().toISOString(), stage: "prepared", providerStrategy: "fresh-session",
      session: db.getProviderAccountSessionRuntime(run.id, "run", run.providerAccountId),
    };
    db.beginRunRewind(operation);
    await db.flushDurable();
  }
  if (operation.stage === "prepared") {
    await prepareProviderRewind(db, operation, point, boundary, steps.slice(boundary), options.networkProxy);
    operation.stage = "provider-ready";
    db.savePendingRunRewind(operation);
    await db.flushDurable();
  }
  if (restoreFiles && operation.stage !== "files-restored") {
    options.beforeRestoreFiles?.();
    const safetyPatchPath = join(dirname(db.getFilePath()), "restore-backups", `${run.id}-${operation.id}-${Date.now()}.patch`);
    const pending = operation;
    const restored = await git.restorePromptRestorePatch(run.worktreePath, point.patch!, {
      expectedHeadSha: point.headSha,
      safetyPatchPath,
      assertSafe: () => {
        assertSafe();
        // The Git service has written the backup before invoking this guard and resetting files.
        if (existsSync(safetyPatchPath)) pending.safetyPatchPath ??= safetyPatchPath;
        db.savePendingRunRewind(pending);
      },
    });
    if (restored.safetyPatchPath) operation.safetyPatchPath ??= restored.safetyPatchPath;
    operation.stage = "files-restored";
    db.savePendingRunRewind(operation);
    await db.flushDurable();
  }
  const promptMetadata = metadata(steps[boundary]!.metadataJson);
  const attachments = Array.isArray(promptMetadata.attachments) ? promptMetadata.attachments as RunRewindResult["attachments"] : [];
  db.completeRunRewind(operation, point);
  await db.flushDurable();
  return { prompt: point.prompt, attachments, providerStrategy: operation.providerStrategy,
    ...(operation.safetyPatchPath ? { safetyPatchPath: operation.safetyPatchPath } : {}) };
}

/**
 * Reuses a Codex session only when the recorded native boundary and pre-turn session agree.
 * Missing boundaries and unsupported/ambiguous RPC failures keep all stale cursors detached,
 * so the next turn rebuilds retained history in a fresh session. An active native turn
 * leaves the rewind pending instead of allowing file restoration underneath it.
 */
async function prepareProviderRewind(
  db: BuildWardenDatabase,
  operation: PendingRunRewind,
  point: RunTurnRestorePoint,
  boundary: number,
  discarded: ReturnType<BuildWardenDatabase["getRunSteps"]>,
  networkProxy?: NetworkProxyRuntimeConfig,
): Promise<void> {
  const session = operation.session;
  operation.session = null;
  if (session?.providerType !== "codex-cli" || !session.providerAccountId) return;
  const threadId = session.resumeCursor?.threadId;
  const promptAccount = metadata(discarded[0]!.metadataJson).providerAccountId;
  if (typeof threadId !== "string" || promptAccount !== session.providerAccountId) return;
  // Find the native boundary within this prompt, never a later prompt if this one failed to start.
  const nextPrompt = discarded.findIndex((step, index) => index > 0 && metadata(step.metadataJson).source === "user");
  const turnSteps = nextPrompt < 0 ? discarded : discarded.slice(0, nextPrompt);
  const native = turnSteps.map((step) => metadata(step.metadataJson).providerTurn)
    .find((value): value is { threadId: string; turnId: string } => Boolean(value && typeof value === "object" &&
      "threadId" in value && value.threadId === threadId && "turnId" in value && typeof value.turnId === "string"));
  if (!native) return;
  const previous = point.providerSession;
  if (boundary > 0 && (!previous || previous.providerAccountId !== session.providerAccountId || previous.resumeCursor?.threadId !== threadId)) return;
  try {
    const provider = db.getProviderAccount(session.providerAccountId);
    if (provider.providerType !== "codex-cli") return;
    const { rewindCodexConversation, withCodexAccountClient } = await import("@buildwarden/provider-codex-cli");
    await withCodexAccountClient({ config: metadata(provider.configJson), cwd: session.cwd, networkProxy },
      (client) => rewindCodexConversation(client, threadId, native.turnId));
    operation.session = previous ?? session;
    operation.providerStrategy = "native";
  } catch (error) {
    if (error instanceof Error && error.message.includes("still active")) throw error;
    // Even an ambiguous transport failure is safe: every old resume cursor was detached durably.
    logWarn("Native rewind unavailable; the next turn will rebuild retained conversation in a fresh session.", { runId: operation.input.runId, error });
  }
}
