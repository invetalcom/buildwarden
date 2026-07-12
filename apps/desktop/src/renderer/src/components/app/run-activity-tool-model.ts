import { looksLikeGitDiff } from "./git-diff-utils";
import { describeActivityDetail, type SingleActivityEntry } from "./run-activity-model";
const TOOL_BATCH_MERGE_BY_PATH = new Set(["read_file"]);
const FILE_LINK_TOOL_NAMES = new Set(["read_file", "write_file", "edit_file", "delete_file", "list_files", "search_repo"]);

// Exported for focused renderer behavior tests.
export const isOpenableToolPath = (toolName: string, path: string | null | undefined): boolean =>
  FILE_LINK_TOOL_NAMES.has(toolName) && Boolean(path?.trim());

export type ToolBatchSummarizedRow = {
  toolName: string;
  detail: string | null;
  toolCallId?: string | null;
  command?: string | null;
  paths?: string[];
  count: number;
  failed: boolean;
  shellStreaming?: boolean;
  preview: string | null;
  writeFileDiff: string | null;
  createdAt: string;
};

export const summarizeToolBatchItems = (
  items: Extract<SingleActivityEntry, { kind: "tool" }>[],
): ToolBatchSummarizedRow[] =>
  items.reduce<ToolBatchSummarizedRow[]>((rows, item) => {
    const callMetadata = item.callMetadata ?? {};
    const resultMetadata = item.resultMetadata ?? {};
    const toolName = String(callMetadata.toolName ?? resultMetadata.toolName ?? "tool");
    const detail = describeActivityDetail(resultMetadata) ?? describeActivityDetail(callMetadata);
    const failed = resultMetadata.ok === false;
    const shellStreaming = resultMetadata.shellStreaming === true;
    const toolCallId = firstMetadataString(resultMetadata.callId, callMetadata.callId);
    const command = firstMetadataString(resultMetadata.command, callMetadata.command);
    const preview = summarizeToolPreview(toolName, failed, item);
    const writeFileDiff =
      !failed && toolName === "write_file" && typeof resultMetadata.writeFileUnifiedDiff === "string"
        ? resultMetadata.writeFileUnifiedDiff
        : null;
    const createdAt = (item.resultStep ?? item.callStep)?.createdAt ?? new Date().toISOString();
    const previousRow = rows[rows.length - 1];
    const pathKey = detail?.trim() ?? "";
    const canMergeSamePath =
      toolName !== "write_file" &&
      toolName !== "run_shell" &&
      previousRow &&
      previousRow.toolName === toolName &&
      previousRow.detail === detail &&
      previousRow.failed === failed &&
      !previousRow.paths?.length;
    const canMergeReadFileRun =
      TOOL_BATCH_MERGE_BY_PATH.has(toolName) &&
      pathKey.length > 0 &&
      previousRow &&
      previousRow.toolName === toolName &&
      previousRow.failed === failed;

    if (canMergeSamePath || canMergeReadFileRun) {
      if (canMergeReadFileRun) {
        const existingPaths = previousRow.paths ?? (previousRow.detail ? [previousRow.detail] : []);
        previousRow.paths = [...existingPaths, pathKey];
        previousRow.detail = null;
      }
      previousRow.count += 1;
      previousRow.createdAt = createdAt;
      previousRow.toolCallId = toolCallId ?? previousRow.toolCallId;
      previousRow.command = command ?? previousRow.command;
      previousRow.shellStreaming = shellStreaming || previousRow.shellStreaming;
      previousRow.preview = preview ?? previousRow.preview;
      previousRow.writeFileDiff = writeFileDiff ?? previousRow.writeFileDiff;
      return rows;
    }

    rows.push({
      toolName,
      detail: pathKey ? detail : null,
      toolCallId,
      count: 1,
      failed,
      command,
      shellStreaming,
      preview,
      writeFileDiff,
      createdAt,
    });
    return rows;
  }, []);

export const APPROVAL_DECISION_LABELS: Record<string, string> = {
  deny: "Denied",
  "allow-for-run": "Allowed for run",
  "allow-always": "Always allowed",
  "allow-once": "Allowed once",
};

export const firstMetadataString = (...candidates: unknown[]): string | null => {
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return null;
};



const summarizeToolPreview = (
  toolName: string,
  failed: boolean,
  item: Extract<SingleActivityEntry, { kind: "tool" }>,
): string | null => {
  if (failed) {
    return item.resultStep?.content ?? item.callStep?.content ?? null;
  }
  if (toolName === "run_shell") {
    return (item.resultStep?.content ?? "").trim() || null;
  }
  if (item.resultStep?.content && looksLikeGitDiff(item.resultStep.content)) {
    return item.resultStep.content;
  }
  return null;
};

