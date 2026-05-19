import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EasycodeDatabase } from "@easycode/db";

const tempDirs: string[] = [];
const dbs: EasycodeDatabase[] = [];

const makeDb = async () => {
  const dir = mkdtempSync(join(tmpdir(), "easycode-provider-session-"));
  tempDirs.push(dir);
  const db = new EasycodeDatabase(join(dir, "easycode.sqlite"));
  await db.init();
  dbs.push(db);
  return db;
};

afterEach(async () => {
  for (const db of dbs.splice(0)) {
    await db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("provider session runtime persistence", () => {
  it("round-trips durable resume cursors and runtime payloads", async () => {
    const db = await makeDb();

    const saved = db.upsertProviderSessionRuntime({
      ownerId: "run-1",
      ownerKind: "run",
      providerType: "codex-cli",
      harnessType: "codex-app-server",
      status: "ready",
      cwd: "C:\\repo\\worktree",
      modelId: "gpt-5.3-codex",
      runtimeMode: "code",
      resumeCursor: { threadId: "thread-123" },
      runtimePayload: { sessionType: "run", previousResponseId: "thread-123" },
    });

    expect(saved.resumeCursor).toEqual({ threadId: "thread-123" });
    expect(saved.runtimePayload).toEqual({ sessionType: "run", previousResponseId: "thread-123" });

    const loaded = db.getProviderSessionRuntime("run-1", "run");
    expect(loaded?.providerType).toBe("codex-cli");
    expect(loaded?.resumeCursor).toEqual({ threadId: "thread-123" });
    expect(loaded?.status).toBe("ready");
  });

  it("updates existing owner bindings without losing createdAt", async () => {
    const db = await makeDb();
    const first = db.upsertProviderSessionRuntime({
      ownerId: "chat-1",
      ownerKind: "chat",
      providerType: "claude-code",
      harnessType: "claude-code",
      status: "ready",
      cwd: "C:\\Users\\me",
      modelId: "sonnet",
      runtimeMode: "ask",
      resumeCursor: { resume: "session-a" },
    });

    const second = db.upsertProviderSessionRuntime({
      ownerId: "chat-1",
      ownerKind: "chat",
      providerType: "claude-code",
      harnessType: "claude-code",
      status: "running",
      cwd: "C:\\Users\\me",
      modelId: "opus",
      runtimeMode: "ask",
      resumeCursor: { resume: "session-b" },
    });

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.modelId).toBe("opus");
    expect(second.resumeCursor).toEqual({ resume: "session-b" });
  });
});
