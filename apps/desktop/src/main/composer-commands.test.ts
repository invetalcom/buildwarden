import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import {
  filterComposerCommandDescriptors,
  listComposerCommandsForProvider,
  mergeComposerCommandDescriptors,
  parseLeadingComposerCommand,
  resolveComposerCommandPrompt,
  type ComposerCommandDescriptor,
} from "@buildwarden/shared";

const tempDirs: string[] = [];
const dbs: BuildWardenDatabase[] = [];

const makeDb = async () => {
  const dir = mkdtempSync(join(tmpdir(), "buildwarden-composer-commands-"));
  tempDirs.push(dir);
  const db = new BuildWardenDatabase(join(dir, "buildwarden.sqlite"));
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

describe("provider composer commands", () => {
  it("filters native commands by provider", () => {
    expect(listComposerCommandsForProvider("codex-cli", "run").map((command) => command.command)).toEqual(["/plan", "/goal"]);
    expect(listComposerCommandsForProvider("claude-code", "run").map((command) => command.command)).toEqual(["/plan"]);
    expect(listComposerCommandsForProvider("cursor-agent", "run").map((command) => command.command)).toEqual(["/plan"]);
    expect(listComposerCommandsForProvider("ai-sdk", "run")).toEqual([]);
  });

  it("maps /plan to plan mode for supported providers", () => {
    const resolved = resolveComposerCommandPrompt("/plan inspect auth flow", "codex-cli", "run");

    expect(resolved.unsupportedCommand).toBeUndefined();
    expect(resolved.mode).toBe("plan");
    expect(resolved.prompt).toBe("inspect auth flow");
  });

  it("maps /plan to plan mode for Cursor Agent", () => {
    const resolved = resolveComposerCommandPrompt("/plan review auth flow", "cursor-agent", "run");

    expect(resolved.unsupportedCommand).toBeUndefined();
    expect(resolved.mode).toBe("plan");
    expect(resolved.prompt).toBe("review auth flow");
  });

  it("parses /goal as run goal with optional prompt on the next line", () => {
    const resolved = resolveComposerCommandPrompt("/goal Improve auth flow\nReview the login controller", "codex-cli", "follow-up");

    expect(resolved.unsupportedCommand).toBeUndefined();
    expect(resolved.goalText).toBe("Improve auth flow");
    expect(resolved.prompt).toBe("Review the login controller");
  });

  it("leaves unsupported slash commands untouched for provider-native handling", () => {
    const resolved = resolveComposerCommandPrompt("/goal Improve auth flow", "claude-code", "follow-up");

    expect(resolved.unsupportedCommand).toBe("/goal");
    expect(resolved.prompt).toBe("/goal Improve auth flow");
  });

  it("parses provider command names with namespaces", () => {
    const parsed = parseLeadingComposerCommand("/project:review auth flow");

    expect(parsed).toEqual({
      command: "/project:review",
      argument: "auth flow",
    });
  });

  it("merges live provider commands without overriding BuildWarden command effects", () => {
    const nativePlan: ComposerCommandDescriptor = {
      id: "codex-cli:plan-native",
      command: "/plan",
      label: "plan",
      description: "Native plan command",
      providerType: "codex-cli",
      effect: "native-prompt",
      supportsRun: true,
      supportsFollowUp: true,
      argumentHint: "<task>",
    };
    const merged = mergeComposerCommandDescriptors(
      [...listComposerCommandsForProvider("codex-cli", "run"), nativePlan],
      "run",
    );
    const plan = merged.find((command) => command.command === "/plan");

    expect(plan?.effect).toBe("set-run-mode");
    expect(plan?.argumentHint).toBe("<task>");
  });

  it("filters live command descriptors by token or label", () => {
    const commands = [
      {
        id: "codex-cli:permissions",
        command: "/permissions",
        label: "Permissions",
        description: "Review permissions.",
        providerType: "codex-cli",
        effect: "native-prompt",
        supportsRun: true,
        supportsFollowUp: true,
      },
      {
        id: "codex-cli:review",
        command: "/review",
        label: "Review",
        description: "Review changes.",
        providerType: "codex-cli",
        effect: "native-prompt",
        supportsRun: true,
        supportsFollowUp: true,
      },
    ] as const satisfies readonly ComposerCommandDescriptor[];

    expect(filterComposerCommandDescriptors(commands, "/per").map((command) => command.command)).toEqual(["/permissions"]);
    expect(filterComposerCommandDescriptors(commands, "view").map((command) => command.command)).toEqual(["/review"]);
  });

  it("persists run-scoped goals", async () => {
    const db = await makeDb();
    const project = db.addProject({
      repoPath: "C:\\repo",
      defaultBranch: "main",
      resolvedName: "Repo",
    });
    const provider = db.addProviderAccount({
      providerType: "codex-cli",
      label: "Codex",
      apiBaseUrl: null,
      apiKeyRef: "",
      configJson: "{}",
    });
    const model = db.addModel({
      providerAccountId: provider.id,
      modelId: "gpt-5.3-codex",
      displayName: "Codex",
      config: {},
      capabilities: {},
      enabled: true,
    });

    const run = db.createRun({
      projectId: project.id,
      providerAccountId: provider.id,
      modelId: model.id,
      harnessType: "codex-app-server",
      mode: "code",
      workspaceType: "worktree",
      prompt: "Review login",
      goalText: "Improve auth flow",
      branchName: "main",
      worktreePath: "C:\\repo",
    });

    expect(db.getRun(run.id).goalText).toBe("Improve auth flow");

    db.updateRunConfiguration(run.id, { goalText: null });

    expect(db.getRun(run.id).goalText).toBeNull();
  });
});
