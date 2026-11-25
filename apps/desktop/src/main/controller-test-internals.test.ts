import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import { describe, expect, it, vi } from "vitest";
import { AppController } from "./app-controller";
import { internalsOf, serviceOf } from "./controller-test-internals";
import { HostEventBus } from "./host-events";

describe("controller test internals", () => {
  it("refuses a member that several services have and reaches it through its service", async () => {
    const root = mkdtempSync(join(tmpdir(), "buildwarden-internals-"));
    const db = new BuildWardenDatabase(join(root, "buildwarden.sqlite"));
    await db.init();
    try {
      const controller = new AppController(db, { readSecret: async () => null, saveSecret: async () => undefined, deleteSecret: async () => undefined }, root,
        { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
        { killForRunId: () => {} }, new HostEventBus());
      const internals = internalsOf<Record<string, unknown>>(controller);
      expect(() => internals.onRunEnded).toThrow("Several services");
      expect(() => { internals.onRunEnded = vi.fn(); }).toThrow("Several services");
      expect(internals.gitService).toBeDefined();

      const lab = vi.spyOn(serviceOf(controller, "projectLab"), "onRunEnded").mockResolvedValue();
      expect(serviceOf(controller, "runForge").onRunEnded).not.toBe(lab);
    } finally {
      await db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
