import type { RunForgeRequestSummary } from "@buildwarden/shared";

export type ForgeRequestActionTarget = Pick<
  RunForgeRequestSummary,
  "provider" | "number" | "state" | "readiness" | "draft" | "headSha" | "supportedActions" | "supportedMergeMethods"
>;

export const forgeRequestActionAvailability = (request: ForgeRequestActionTarget, canWrite: boolean) => ({
  canToggleDraft: canWrite
    && request.state === "open"
    && request.supportedActions.includes(request.draft ? "mark-ready" : "mark-draft"),
  canMerge: canWrite
    && request.supportedMergeMethods.length > 0
    && request.readiness === "ready"
    && request.state === "open"
    && !request.draft
    && Boolean(request.headSha),
  canClose: canWrite && request.supportedActions.includes("close"),
  canReopen: canWrite && request.supportedActions.includes("reopen"),
});
