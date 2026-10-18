import { resolve } from "node:path";
import { getResponseSourceText, type RunExecutionRequest } from "@buildwarden/shared";

const normalizedDirectory = (path: string) => {
  const directory = resolve(path);
  return process.platform === "win32" ? directory.toLowerCase() : directory;
};

/** Claude/Cursor sessions are scoped to their original cwd. Start a fresh session
 * with conversation history when older chats move into an app-owned workspace. */
export const prepareChatWorkspaceSession = (request: RunExecutionRequest): RunExecutionRequest => {
  if (request.providerType !== "claude-code" && request.providerType !== "cursor-agent") return request;
  const runtime = request.providerSessionRuntime;
  if (!runtime && !request.previousResponseId) return request;
  if (runtime?.cwd && normalizedDirectory(runtime.cwd) === normalizedDirectory(request.worktreePath)) return request;
  const history = (request.priorChatMessages ?? []).map((message) =>
    `${message.role}: ${getResponseSourceText({ content: message.content })}`,
  ).join("\n\n");
  return {
    ...request,
    providerSessionRuntime: null,
    previousResponseId: null,
    prompt: history ? `This chat moved to a new workspace. Use the prior conversation below as context.\n\n<prior_conversation>\n${history}\n</prior_conversation>\n\n${request.prompt}` : request.prompt,
  };
};
