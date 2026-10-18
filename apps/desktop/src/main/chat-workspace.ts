import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isPathInsideRoot } from "./run-workspace-file";

export const getChatWorkspacePath = (databasePath: string, chatId: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(chatId)) throw new Error("Invalid chat workspace id.");
  const root = resolve(dirname(databasePath), "chat-workspaces");
  const workspace = resolve(root, chatId);
  if (workspace === root || !isPathInsideRoot(root, workspace)) throw new Error("Invalid chat workspace path.");
  return workspace;
};

export const removeChatWorkspace = async (databasePath: string, chatId: string): Promise<void> => {
  const workspace = getChatWorkspacePath(databasePath, chatId);
  // Only this validated app-owned child directory is removed, never a project or the provider's old cwd.
  await rm(workspace, { recursive: true, force: true });
};
