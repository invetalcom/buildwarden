export interface WorkspaceRevision {
  /** Git tree ID or folder content digest. A commit of the same tree preserves validity. */
  fingerprint: string;
  head: string | null;
}

export interface VerificationCommandResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunVerificationRecord {
  runId: string;
  status: "running" | "passed" | "failed" | "stale" | "cancelled" | "unavailable";
  revision: WorkspaceRevision | null;
  commands: string[];
  results: VerificationCommandResult[];
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface RunVerificationState {
  record: RunVerificationRecord | null;
  status: RunVerificationRecord["status"] | "not-run" | "unconfigured";
  currentRevision: WorkspaceRevision | null;
  commands: string[];
  requiredBeforePublish: boolean;
  reason: string | null;
}

export const parseRevisionVerificationPolicy = (raw: string | undefined): Record<string, boolean> => {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, enabled]) => typeof enabled === "boolean"));
  } catch { return {}; }
};

export const verificationMatches = (record: RunVerificationRecord, revision: WorkspaceRevision, commands: string[]): boolean =>
  record.revision?.fingerprint === revision.fingerprint && JSON.stringify(record.commands) === JSON.stringify(commands);
