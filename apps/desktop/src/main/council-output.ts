import type {
  CouncilFailureKind,
  CouncilFinding,
  CouncilFindingGroup,
  CouncilGroupDecision,
  CouncilReviewKind,
  CouncilSeverity,
} from "@buildwarden/shared";
import { normalizeJsonResponse } from "./json-response";
import { COUNCIL_MAX_FINDINGS_PER_REVIEW } from "./council-prompts";

const TITLE_LIMIT = 120;
const TEXT_LIMIT = 600;
const SUMMARY_LIMIT = 500;

const clip = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;

const text = (value: unknown, limit: number): string => (typeof value === "string" ? clip(value.trim(), limit) : "");

const severityOf = (value: unknown): CouncilSeverity =>
  value === "high" || value === "low" ? value : "medium";

const readObject = (raw: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(normalizeJsonResponse(raw));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object.");
  return parsed as Record<string, unknown>;
};

export type ParsedCouncilFinding = Omit<CouncilFinding, "id" | "reviewId">;

/** Throws when the reply is not a report. A valid report may be empty. */
export const parseCouncilReport = (raw: string, kind: CouncilReviewKind): ParsedCouncilFinding[] => {
  const { findings } = readObject(raw);
  if (!Array.isArray(findings)) throw new Error("The report has no findings list.");
  return findings.flatMap((entry): ParsedCouncilFinding[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const title = text(record.title, TITLE_LIMIT);
    const problem = text(record.problem, TEXT_LIMIT);
    if (!title || !problem) return [];
    const line = typeof record.line === "number" && Number.isInteger(record.line) && record.line > 0 ? record.line : null;
    return [{
      title,
      severity: severityOf(record.severity),
      file: kind === "code" ? text(record.file, 400) || null : null,
      line: kind === "code" ? line : null,
      quote: kind === "text" ? text(record.quote, TEXT_LIMIT) || null : null,
      problem,
      impact: text(record.impact, TEXT_LIMIT),
      suggestion: text(record.suggestion, TEXT_LIMIT) || null,
    }];
  }).slice(0, COUNCIL_MAX_FINDINGS_PER_REVIEW);
};

const standaloneGroup = (finding: CouncilFinding, id: string): CouncilFindingGroup => ({
  id,
  title: finding.title,
  severity: finding.severity,
  decision: "unassessed",
  reason: null,
  findingIds: [finding.id],
});

/** Used when no assessment is available: every finding stays visible, ungrouped and unjudged. */
export const ungroupedCouncilFindings = (findings: readonly CouncilFinding[]): CouncilFindingGroup[] =>
  findings.map((finding, index) => standaloneGroup(finding, `G${String(index + 1)}`));

export interface ParsedCouncilAssessment {
  summary: string | null;
  groups: CouncilFindingGroup[];
}

/**
 * Throws when the reply is not an assessment. A partial assessment is accepted but can never lose a
 * finding: unknown ids are ignored, a repeated id stays in its first group, and any finding the
 * model skipped is kept as its own unassessed group.
 */
export const parseCouncilAssessment = (raw: string, findings: readonly CouncilFinding[]): ParsedCouncilAssessment => {
  const parsed = readObject(raw);
  if (!Array.isArray(parsed.groups)) throw new Error("The assessment has no groups list.");
  const unassigned = new Map(findings.map((finding) => [finding.id, finding]));
  const groups: CouncilFindingGroup[] = [];
  for (const entry of parsed.groups as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const ids = Array.isArray(record.findingIds) ? record.findingIds : [];
    const findingIds = ids.filter((id): id is string => typeof id === "string" && unassigned.delete(id));
    if (!findingIds.length) continue;
    const members = findings.filter((finding) => findingIds.includes(finding.id));
    const decision: CouncilGroupDecision = record.decision === "recommended" || record.decision === "rejected" ? record.decision : "unassessed";
    groups.push({
      id: `G${String(groups.length + 1)}`,
      title: text(record.title, TITLE_LIMIT) || members[0]!.title,
      severity: typeof record.severity === "string" ? severityOf(record.severity) : members[0]!.severity,
      decision,
      reason: text(record.reason, TEXT_LIMIT) || null,
      findingIds,
    });
  }
  for (const finding of unassigned.values()) groups.push(standaloneGroup(finding, `G${String(groups.length + 1)}`));
  return { summary: text(parsed.summary, SUMMARY_LIMIT) || null, groups };
};

/** Only transient failures are retried, because a usage limit or bad credentials will not clear in time. */
export const classifyCouncilFailure = (message: string): CouncilFailureKind => {
  const value = message.toLowerCase();
  if (/usage limit|limit reached|hit your limit|quota|insufficient[_ ]|billing|out of credits|credit balance|rate.?limit.*(day|week|month)/.test(value)) return "limit";
  if (/unauthori[sz]ed|forbidden|credential|api key|authentication|not logged in|log in|\b401\b|\b403\b/.test(value)) return "auth";
  if (/rate.?limit|too many requests|overloaded|temporarily|timed? ?out|econnreset|etimedout|enotfound|socket hang up|network|\b429\b|\b50[234]\b/.test(value)) return "transient";
  return "unknown";
};
