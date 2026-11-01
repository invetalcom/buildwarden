import { parseGitRemoteToWebBase, type GitService } from "@buildwarden/git-service";
import type { ProjectPrReviewProvider } from "./pr-review/pr-review-types";

/** Resolve the run branch's publishing remote, independently of the checked-out branch. */
export async function resolveRunForgeSourceRepository(
  gitService: GitService,
  repoPath: string,
  branch: string,
  provider: Pick<ProjectPrReviewProvider, "getSourceRepository">,
): Promise<string | null> {
  const git = gitService.createGitClient(repoPath);
  const config = async (key: string) => (await git.getConfig(key)).value?.trim() || null;
  const remoteName = await config(`branch.${branch}.pushRemote`)
    ?? await config("remote.pushDefault")
    ?? await config(`branch.${branch}.remote`)
    ?? "origin";
  if (remoteName === ".") return null;
  const remoteUrl = await git.remote(["get-url", "--push", remoteName]);
  const remote = parseGitRemoteToWebBase(String(remoteUrl ?? ""));
  return remote ? provider.getSourceRepository(remote.webBaseUrl) : null;
}
