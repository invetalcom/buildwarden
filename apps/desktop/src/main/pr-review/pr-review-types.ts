import type {
  GetProjectForgeRequestDetailsInput,
  FetchProjectPrMrDiffInput,
  ListProjectForgeRequestsInput,
  PostProjectPrMrReviewInput,
  ProjectForgeRequestDetailsResult,
  ProjectForgeProvider,
  ProjectForgeRequestsResult,
  ProjectForgeReviewActionResult,
  ProjectPrMrDiffResult,
  SubmitProjectPrMrCommentsInput,
} from "@buildwarden/shared";

export type ProjectPrReviewRemoteContext = {
  provider: ProjectForgeProvider;
  webBaseUrl: string;
  repoLabel: string;
  apiBaseUrl: string;
  github?: {
    owner: string;
    repo: string;
  };
  gitlab?: {
    projectPath: string;
    encodedProjectPath: string;
  };
};

export type GitlabDiffRefs = {
  baseSha: string;
  startSha: string;
  headSha: string;
};

export interface ProjectPrReviewProvider {
  listRequests(input?: ListProjectForgeRequestsInput): Promise<ProjectForgeRequestsResult>;
  getRequestDetails(input: GetProjectForgeRequestDetailsInput): Promise<ProjectForgeRequestDetailsResult>;
  getRequestDiff(input: FetchProjectPrMrDiffInput): Promise<ProjectPrMrDiffResult>;
  postReview(input: PostProjectPrMrReviewInput): Promise<ProjectForgeReviewActionResult>;
  submitComments(input: SubmitProjectPrMrCommentsInput): Promise<ProjectForgeReviewActionResult>;
}
