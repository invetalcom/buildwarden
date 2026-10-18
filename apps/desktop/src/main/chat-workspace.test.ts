import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { getChatWorkspacePath, removeChatWorkspace } from "./chat-workspace";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("removes only the named app-owned chat workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "buildwarden-chat-workspace-"));
  roots.push(root);
  const database = join(root, "state.sqlite");
  const workspace = getChatWorkspacePath(database, "chat-123");
  const sibling = getChatWorkspacePath(database, "chat-456");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(sibling);
  writeFileSync(join(workspace, "image.png"), "fixture");
  writeFileSync(database, "database fixture");
  await removeChatWorkspace(database, "chat-123");
  expect(existsSync(workspace)).toBe(false);
  expect(existsSync(sibling)).toBe(true);
  expect(existsSync(database)).toBe(true);
  await removeChatWorkspace(database, "chat-123");
});

it("rejects paths that could escape the app-owned workspace", async () => {
  for (const id of ["", ".", "..", "../project", "a/b", "a\\b", "C:\\project"]) {
    await expect(removeChatWorkspace(join(tmpdir(), "state.sqlite"), id)).rejects.toThrow("Invalid chat workspace id");
  }
});
