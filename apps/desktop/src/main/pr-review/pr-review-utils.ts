import { parsePrMrBrowserUrl } from "@buildwarden/git-service";
import type { ProjectPrMrDiffComment } from "@buildwarden/shared";
import type { ProjectPrReviewRemoteContext } from "./pr-review-types";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const recordString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

export const recordNumber = (record: Record<string, unknown>, key: string): number | null => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const GITHUB_LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const GITLAB_SECTION_MARKER = /section_(?:start|end):\d+:[\w.\-[\]=,]*\r?/g;

/** The last lines of a CI log, without colors and timestamps, bounded for a prompt. */
export const tailCheckLog = (text: string, maxLines = 150, maxChars = 12_000): string | null => {
  const lines = text
    .replace(ANSI_ESCAPE, "")
    .replace(GITLAB_SECTION_MARKER, "")
    .split(/\r?\n/)
    .map((line) => line.replace(GITHUB_LOG_TIMESTAMP, "").trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  if (!lines.length) return null;
  let tail = lines.slice(-maxLines).join("\n");
  if (tail.length > maxChars) tail = tail.slice(tail.length - maxChars);
  return tail;
};

export const recordBoolean =(record: Record<string, unknown>, key: string): boolean => record[key] === true;

export const recordObject = (record: Record<string, unknown>, key: string): Record<string, unknown> | null => {
  const value = record[key];
  return isRecord(value) ? value : null;
};

const normalizeWebBaseForApiCompare = (value: string) => {
  let normalized = value.trim();
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.toLowerCase();
};

export const parseAndValidatePrMrUrl = (prUrl: string, context: ProjectPrReviewRemoteContext) => {
  const parsed = parsePrMrBrowserUrl(prUrl);
  if (!parsed) {
    throw new Error("Could not parse a GitHub pull request or GitLab merge request URL.");
  }
  if (parsed.provider !== context.provider) {
    throw new Error(`The selected request is for ${parsed.provider}, but this project origin looks like ${context.provider}.`);
  }
  if (normalizeWebBaseForApiCompare(parsed.expectedWebBase) !== normalizeWebBaseForApiCompare(context.webBaseUrl)) {
    throw new Error("The selected PR/MR does not match this project's origin repository.");
  }
  return parsed;
};

export const normalizeDraftComments = (comments: ProjectPrMrDiffComment[]): ProjectPrMrDiffComment[] =>
  comments.map((comment) => ({
    ...comment,
    body: comment.body.trim(),
  }));

export const assertDraftCommentsAreSubmittable = (comments: ProjectPrMrDiffComment[]): void => {
  if (comments.length === 0) {
    throw new Error("Add at least one draft diff comment before submitting.");
  }
  if (comments.some((comment) => !comment.body)) {
    throw new Error("Every draft diff comment needs a body.");
  }
};
