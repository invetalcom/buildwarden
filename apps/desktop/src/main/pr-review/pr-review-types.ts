import type {
  GetProjectForgeRequestDetailsInput,
  FetchProjectPrMrDiffInput,
  ListProjectForgeRequestsInput,
  PostProjectPrMrReviewInput,
  ProjectForgeRequestDetailsResult,
  ProjectForgeProvider,
  ProjectForgeRequestSummary,
  ProjectForgeRequestsResult,
  ProjectForgeReviewActionResult,
  ProjectPrMrDiffResult,
  RunForgeAction,
  RunForgeCheck,
  RunForgeMergeMethod,
  RunForgeMergeability,
  RunForgeRequestState,
  RunForgeReviewDecision,
  ReplyProjectPrMrReviewThreadInput,
  ResolveProjectPrMrReviewThreadInput,
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

export interface CreateForgeRequestInput {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

export interface MergeForgeRequestInput {
  prUrl: string;
  /** Optional commit message/title override for the merge commit. */
  mergeCommitTitle?: string;
  method?: RunForgeMergeMethod;
  expectedHeadSha?: string;
}

export interface ForgeRequestStatusResult {
  state: RunForgeRequestState;
  draft: boolean;
  mergeability: RunForgeMergeability;
  reviewDecision: RunForgeReviewDecision;
  headSha: string | null;
  checks: RunForgeCheck[];
  unresolvedThreadCount: number;
  supportedActions: RunForgeAction[];
  supportedMergeMethods: RunForgeMergeMethod[];
  etag?: string | null;
  lastModified?: string | null;
}

export interface ForgeRequestStatusInput extends GetProjectForgeRequestDetailsInput {
  etag?: string | null;
  lastModified?: string | null;
  previousStatus?: ForgeRequestStatusResult | null;
}

export interface UpdateForgeRequestInput {
  prUrl: string;
  action: "mark-draft" | "mark-ready" | "close" | "reopen";
  expectedHeadSha?: string;
}

export interface ForgeRequestApprovalStatus {
  approved: boolean;
  approvedBy: string[];
}

export interface ProjectPrReviewProvider {
  listRequests(input?: ListProjectForgeRequestsInput): Promise<ProjectForgeRequestsResult>;
  getRequestDetails(input: GetProjectForgeRequestDetailsInput): Promise<ProjectForgeRequestDetailsResult>;
  getRequestDiff(input: FetchProjectPrMrDiffInput): Promise<ProjectPrMrDiffResult>;
  postReview(input: PostProjectPrMrReviewInput): Promise<ProjectForgeReviewActionResult>;
  submitComments(input: SubmitProjectPrMrCommentsInput): Promise<ProjectForgeReviewActionResult>;
  replyToThread(input: ReplyProjectPrMrReviewThreadInput): Promise<ProjectForgeReviewActionResult>;
  resolveThread(input: ResolveProjectPrMrReviewThreadInput): Promise<ProjectForgeReviewActionResult>;
  /** Create a PR/MR through the hosting API (no browser, no gh/glab CLI). */
  createRequest(input: CreateForgeRequestInput): Promise<ProjectForgeRequestSummary>;
  /** Merge a PR/MR through the hosting API. */
  mergeRequest(input: MergeForgeRequestInput): Promise<ProjectForgeReviewActionResult>;
  /** Whether the PR/MR currently has at least one approval. */
  getRequestApprovalStatus(input: GetProjectForgeRequestDetailsInput): Promise<ForgeRequestApprovalStatus>;
  /** Lightweight request state, checks, mergeability, and review readiness query. */
  getRequestStatus(input: ForgeRequestStatusInput): Promise<ForgeRequestStatusResult>;
  updateRequest(input: UpdateForgeRequestInput): Promise<ProjectForgeReviewActionResult>;
}
