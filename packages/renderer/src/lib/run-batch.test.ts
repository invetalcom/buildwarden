/** @vitest-environment happy-dom */
import { beforeEach, expect, it, vi } from "vitest";
import { ComposerDraftStore, composerDraftKey } from "./composer-draft-store";
import { startRunBatch } from "./run-batch";

const key = composerDraftKey("batch-host", "project", "project-1");
const store = () => new ComposerDraftStore(() => localStorage, { get: vi.fn(), put: vi.fn(), remove: vi.fn() });
beforeEach(() => localStorage.clear());

it("persists accepted models before a later failure and retries only remaining models after restart", async () => {
  const initial = store();
  initial.setPrompt(key, "Build this");
  const createRun = vi.fn(async (model: string) => {
    if (model === "b") throw new Error("Provider unavailable");
    return `run-${model}`;
  });
  await expect(startRunBatch(["a", "b", "c"], createRun, initial.prepareRunBatch(key, "same-request"))).rejects.toThrow("Retry will start only the remaining models");
  expect(createRun.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  const restarted = store();
  expect(restarted.getSnapshot(key).prompt).toBe("Build this");
  createRun.mockReset().mockImplementation(async (model) => `run-${model}`);
  await expect(startRunBatch(["a", "b", "c"], createRun, restarted.prepareRunBatch(key, "same-request"))).resolves.toBe("run-c");
  expect(createRun.mock.calls.map(([id]) => id)).toEqual(["b", "c"]);
  restarted.clearSubmitted(key, restarted.getSnapshot(key));
  expect(localStorage.getItem(key)).toBeNull();
  expect(store().prepareRunBatch(key, "same-request").acceptedModelIds).toEqual([]);
});

it("does not skip models for different launch inputs or another project", async () => {
  const drafts = store();
  drafts.setPrompt(key, "First");
  drafts.prepareRunBatch(key, "first-inputs").recordAccepted("a");
  const createRun = vi.fn(async () => "new-run");
  await startRunBatch(["a"], createRun, drafts.prepareRunBatch(key, "changed-inputs"));
  await startRunBatch(["a"], createRun, drafts.prepareRunBatch(composerDraftKey("batch-host", "project", "project-2"), "changed-inputs"));
  expect(createRun).toHaveBeenCalledTimes(2);
});

it("retries a model when no run was accepted and handles removed model configuration", async () => {
  const drafts = store();
  drafts.setPrompt(key, "Work");
  await expect(startRunBatch(["a"], async () => null, drafts.prepareRunBatch(key, "request"))).rejects.toThrow("no longer available");
  expect(drafts.prepareRunBatch(key, "request").acceptedModelIds).toEqual([]);
  await expect(startRunBatch(["a"], async () => "run-a", drafts.prepareRunBatch(key, "request"))).resolves.toBe("run-a");
});
