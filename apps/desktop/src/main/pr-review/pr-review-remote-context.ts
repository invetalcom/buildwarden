import type { ProjectRecord } from "@buildwarden/shared";
import { parseGitRemoteToWebBase } from "@buildwarden/git-service";
import type { GitService } from "@buildwarden/git-service";
import type { ProjectPrReviewRemoteContext } from "./pr-review-types";

const trimSlashes = (value: string): string => {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "/") {
    start += 1;
  }
  while (end > start && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(start, end);
};

const normalizeProjectPath = (pathName: string): string => {
  const trimmed = trimSlashes(pathName);
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
};

export const resolveProjectPrReviewRemoteContext = async (
  project: ProjectRecord,
  gitService: GitService,
): Promise<ProjectPrReviewRemoteContext> => {
  const git = gitService.createGitClient(project.repoPath);
  const remoteOutput = await git.remote(["get-url", "origin"]);
  const remote = parseGitRemoteToWebBase(String(remoteOutput ?? ""));
  if (!remote) {
    throw new Error('Could not interpret "origin" as a GitHub or GitLab remote URL.');
  }

  const remoteUrl = new URL(remote.webBaseUrl);
  const repoLabel = normalizeProjectPath(remoteUrl.pathname);
  if (!repoLabel) {
    throw new Error('Could not resolve the repository path from "origin".');
  }

  if (remote.provider === "github") {
    const [owner, repo, ...rest] = repoLabel.split("/");
    if (!owner || !repo || rest.length > 0) {
      throw new Error("GitHub repositories must look like github.com/owner/repo.");
    }
    return {
      provider: "github",
      webBaseUrl: remote.webBaseUrl,
      repoLabel,
      apiBaseUrl: "https://api.github.com",
      github: { owner, repo },
    };
  }

  return {
    provider: "gitlab",
    webBaseUrl: remote.webBaseUrl,
    repoLabel,
    apiBaseUrl: `${remoteUrl.origin}/api/v4`,
    gitlab: {
      projectPath: repoLabel,
      encodedProjectPath: encodeURIComponent(repoLabel),
    },
  };
};
