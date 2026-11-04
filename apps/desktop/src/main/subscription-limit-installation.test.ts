import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderAccountRecord } from "@buildwarden/shared";
import { installedSubscriptionTargets } from "./subscription-limit-installation";

const provider = (id: string, providerType: ProviderAccountRecord["providerType"], config: Record<string, unknown>) =>
  ({ id, providerType, label: id, configJson: JSON.stringify(config) }) as ProviderAccountRecord;

describe("installed subscription providers", () => {
  it("returns no targets when no supported executable exists, even with saved connections", () => {
    expect(installedSubscriptionTargets([], () => false)).toEqual([]);
    expect(installedSubscriptionTargets([provider("stale", "codex-cli", { codexBinaryPath: "missing-codex" })], () => false)).toEqual([]);
  });
  it("discovers default CLIs without requiring a saved provider account or login", () => {
    const binary = join(homedir(), ".local", "bin", process.platform === "win32" ? "codex.exe" : "codex");
    const targets = installedSubscriptionTargets([], (path) => path === binary);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ id: "codex-cli", providerType: "codex-cli", config: { codexBinaryPath: binary } });
  });
  it("accepts custom executable locations and skips broken configurations before deduplicating", () => {
    const codex = join(tmpdir(), "custom-codex.exe");
    const claude = join(tmpdir(), "custom-claude.exe");
    const cursor = join(tmpdir(), "custom-cursor.exe");
    const providers = [provider("broken", "codex-cli", { codexBinaryPath: "missing-codex" }),
      provider("working", "codex-cli", { codexBinaryPath: codex }),
      provider("claude", "claude-code", { claudeBinaryPath: claude }),
      provider("cursor", "cursor-agent", { cursorBinaryPath: cursor })];
    expect(installedSubscriptionTargets(providers, (path) => [codex, claude, cursor].includes(path)).map((target) => target.id)).toEqual(["working", "claude", "cursor"]);
  });
});
