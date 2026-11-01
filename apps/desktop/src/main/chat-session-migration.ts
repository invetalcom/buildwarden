import { resolve } from "node:path";
import { getResponseSourceText, type RunExecutionRequest } from "@buildwarden/shared";

const normalizedDirectory = (path: string) => {
  const directory = resolve(path);
  return process.platform === "win32" ? directory.toLowerCase() : directory;
};

/** Providers whose chat follow-ups continue a native session instead of replaying history. */
const NATIVE_SESSION_PROVIDERS = new Set<RunExecutionRequest["providerType"]>(["claude-code", "cursor-agent", "codex-cli"]);
/** Claude/Cursor sessions are additionally scoped to the cwd they were created in. */
const CWD_SCOPED_PROVIDERS = new Set<RunExecutionRequest["providerType"]>(["claude-code", "cursor-agent"]);

const HISTORY_BUDGET = 48_000;

/** Newest messages first within the budget, always keeping the opening message, in original order. */
const renderHistory = (messages: ReadonlyArray<{ role: string; content: string }>): string => {
  const lines = messages.map((message) => `${message.role}: ${getResponseSourceText({ content: message.content })}`);
  const kept = new Set<number>();
  let remaining = HISTORY_BUDGET;
  const tryKeep = (index: number) => {
    const line = lines[index];
    if (line === undefined || kept.has(index) || line.length + 2 > remaining) return;
    kept.add(index);
    remaining -= line.length + 2;
  };
  tryKeep(0);
  for (let index = lines.length - 1; index > 0; index--) tryKeep(index);
  const parts: string[] = [];
  lines.forEach((line, index) => {
    if (kept.has(index)) {
      parts.push(line);
    } else if (parts.at(-1) !== "[... earlier messages omitted ...]") {
      parts.push("[... earlier messages omitted ...]");
    }
  });
  return parts.join("\n\n");
};

/**
 * A native-session provider that cannot continue its own session (none exists for this account,
 * or a Claude/Cursor chat moved into an app-owned workspace) starts a fresh session. That session
 * has never seen the conversation, so the prior messages travel inside the prompt.
 */
export const prepareChatWorkspaceSession = (request: RunExecutionRequest): RunExecutionRequest => {
  if (!NATIVE_SESSION_PROVIDERS.has(request.providerType)) return request;
  const runtime = request.providerSessionRuntime;
  const hasSession = Boolean(runtime || request.previousResponseId);
  const sessionMoved = hasSession && CWD_SCOPED_PROVIDERS.has(request.providerType) &&
    !(runtime?.cwd && normalizedDirectory(runtime.cwd) === normalizedDirectory(request.worktreePath));
  if (hasSession && !sessionMoved) return request;
  const history = renderHistory(request.priorChatMessages ?? []);
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
