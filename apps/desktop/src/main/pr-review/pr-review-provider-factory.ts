import { GithubPrReviewProvider, isGithubPrReviewContext } from "./github-pr-review-provider";
import { GitlabMrReviewProvider, isGitlabMrReviewContext } from "./gitlab-mr-review-provider";
import { PrReviewHttpClient } from "./pr-review-http-client";
import type { ProjectPrReviewProvider, ProjectPrReviewRemoteContext } from "./pr-review-types";

export const createProjectPrReviewProvider = (
  context: ProjectPrReviewRemoteContext,
  token: string,
): ProjectPrReviewProvider => {
  const http = new PrReviewHttpClient(context, token);
  if (isGithubPrReviewContext(context)) {
    return new GithubPrReviewProvider(context, http);
  }
  if (isGitlabMrReviewContext(context)) {
    return new GitlabMrReviewProvider(context, http);
  }
  throw new Error("Could not resolve a GitHub or GitLab provider for this project.");
};
