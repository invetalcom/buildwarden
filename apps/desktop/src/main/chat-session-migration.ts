import { resolve } from "node:path";
import type { ProviderSessionRuntimeRecord, RunExecutionRequest } from "@buildwarden/shared";
import { renderBudgetedConversation } from "./provider-context-handoff";

const normalizedDirectory = (path: string) => {
  const directory = resolve(path);
  return process.platform === "win32" ? directory.toLowerCase() : directory;
};

/** Providers whose chat follow-ups continue a native session instead of replaying history. */
const NATIVE_SESSION_PROVIDERS = new Set<RunExecutionRequest["providerType"]>(["claude-code", "cursor-agent", "codex-cli"]);
/** Claude/Cursor sessions are additionally scoped to the cwd they were created in. */
const CWD_SCOPED_PROVIDERS = new Set<RunExecutionRequest["providerType"]>(["claude-code", "cursor-agent"]);

/**
 * Whether a stored session can be resumed from `worktreePath`. Claude/Cursor sessions cannot
 * follow a chat that moved into an app-owned workspace; a session without a runtime record
 * (legacy response id only) cannot prove where it lives.
 */
export const sessionMatchesWorkspace = (
  providerType: RunExecutionRequest["providerType"],
  runtime: Pick<ProviderSessionRuntimeRecord, "cwd"> | null | undefined,
  worktreePath: string,
): boolean =>
  !CWD_SCOPED_PROVIDERS.has(providerType) ||
  Boolean(runtime?.cwd && normalizedDirectory(runtime.cwd) === normalizedDirectory(worktreePath));

/**
 * A native-session provider that cannot continue its own session (none exists for this account,
 * or a Claude/Cursor chat moved into an app-owned workspace) starts a fresh session. That session
 * has never seen the conversation, so the prior messages travel inside the prompt.
 */
export const prepareChatWorkspaceSession = (request: RunExecutionRequest): RunExecutionRequest => {
  if (!NATIVE_SESSION_PROVIDERS.has(request.providerType)) return request;
  const runtime = request.providerSessionRuntime;
  const hasSession = Boolean(runtime || request.previousResponseId);
  const sessionMoved = hasSession && !sessionMatchesWorkspace(request.providerType, runtime, request.worktreePath);
  if (hasSession && !sessionMoved) return request;
  const history = renderBudgetedConversation(request.priorChatMessages ?? []);
  if (!history) {
    return hasSession ? { ...request, providerSessionRuntime: null, previousResponseId: null } : request;
  }
  const reason = sessionMoved
    ? "This chat moved to a new workspace."
    : "This chat continues in a new provider session (the model or provider changed).";
  return {
    ...request,
    providerSessionRuntime: null,
    previousResponseId: null,
    prompt: `${reason} Use the prior conversation below as context.\n\n<prior_conversation>\n${history}\n</prior_conversation>\n\n${request.prompt}`,
  };
};
