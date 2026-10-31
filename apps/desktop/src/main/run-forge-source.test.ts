import { afterEach, expect, it, vi } from "vitest";
import { GitService } from "@buildwarden/git-service";
import type { ProjectPrReviewProvider } from "./pr-review/pr-review-types";
import { resolveRunForgeSourceRepository } from "./run-forge-source";

afterEach(() => vi.restoreAllMocks());

it.each([
  [{ "branch.feature.pushRemote": "fork", "remote.pushDefault": "other", "branch.feature.remote": "upstream" }, "fork"],
  [{ "remote.pushDefault": "fork", "branch.feature.remote": "upstream" }, "fork"],
  [{ "branch.feature.remote": "upstream" }, "upstream"],
  [{}, "origin"],
] satisfies Array<[Record<string, string>, string]>)("resolves publishing identity from branch configuration %j", async (config, expectedRemote) => {
  const values: Record<string, string> = config;
  const remote = vi.fn(async () => "git@github.com:contributor/repo.git");
  vi.spyOn(GitService.prototype, "createGitClient").mockReturnValue({
    getConfig: vi.fn(async (key: string) => ({ value: values[key] ?? null })), remote,
  } as unknown as ReturnType<GitService["createGitClient"]>);
  const getSourceRepository = vi.fn(async () => "contributor/repo");
  const provider = { getSourceRepository } as unknown as ProjectPrReviewProvider;
  await expect(resolveRunForgeSourceRepository(new GitService(), "repo", "feature", provider)).resolves.toBe("contributor/repo");
  expect(remote).toHaveBeenCalledWith(["get-url", "--push", expectedRemote]);
  expect(getSourceRepository).toHaveBeenCalledWith("https://github.com/contributor/repo");
});

it("does not guess origin when a configured publishing remote cannot be read", async () => {
  vi.spyOn(GitService.prototype, "createGitClient").mockReturnValue({
    getConfig: vi.fn(async () => ({ value: "missing-fork" })),
    remote: vi.fn(async () => { throw new Error("No such remote"); }),
  } as unknown as ReturnType<GitService["createGitClient"]>);
  const getSourceRepository = vi.fn();
  await expect(resolveRunForgeSourceRepository(new GitService(), "repo", "feature", { getSourceRepository } as unknown as ProjectPrReviewProvider)).rejects.toThrow("No such remote");
  expect(getSourceRepository).not.toHaveBeenCalled();
});
