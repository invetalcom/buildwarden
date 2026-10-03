import type { RunVerificationRecord, WorkspaceRevision } from "@buildwarden/shared";
import { runProjectVerificationCommands } from "./project-verification";
import { captureWorkspaceRevision } from "./workspace-revision";

export const verifyWorkspaceRevision = async (input: {
  runId: string; cwd: string; vcs: "git" | "folder"; commands: string[]; signal?: AbortSignal;
  save: (record: RunVerificationRecord) => void;
}): Promise<RunVerificationRecord> => {
  const record: RunVerificationRecord = {
    runId: input.runId, commands: [...input.commands], status: "running", revision: null,
    results: [], startedAt: new Date().toISOString(), finishedAt: null, error: null,
  };
  input.save(record);
  try {
    if (!input.commands.length) throw new Error("Configure verification commands in project settings first.");
    const before: WorkspaceRevision = await captureWorkspaceRevision(input.cwd, input.vcs);
    record.revision = before; input.save(record);
    if (input.signal?.aborted) { record.status = "cancelled"; }
    else {
      record.results = await runProjectVerificationCommands(input.cwd, input.commands, undefined, input.signal);
      const after = await captureWorkspaceRevision(input.cwd, input.vcs);
      record.status = input.signal?.aborted ? "cancelled"
        : before.fingerprint !== after.fingerprint ? "stale"
        : record.results.length === input.commands.length && record.results.every((result) => result.ok) ? "passed" : "failed";
      if (record.status === "stale") record.error = "Workspace contents changed during verification. Run verification again.";
    }
  } catch (error) {
    record.status = input.signal?.aborted ? "cancelled" : "unavailable";
    record.error = error instanceof Error ? error.message : String(error);
  }
  record.finishedAt = new Date().toISOString(); input.save(record);
  return record;
};
