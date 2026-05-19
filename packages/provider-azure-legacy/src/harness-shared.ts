import { Buffer } from "node:buffer";
import pRetry, { AbortError } from "p-retry";
import type {
  ChatAttachmentPayload,
  HarnessRunChunk,
  HarnessToolContext,
  RunMode,
  RunTokenUsage,
  RunToolName,
} from "@easycode/shared";
import { CHAT_ATTACHMENT_LIMITS } from "@easycode/shared";

export const SYSTEM_PROMPT = [
  "You are Easycode, a desktop coding agent running inside a Git worktree.",
  "You are operating on a local codebase and can inspect and modify files via provided tools.",
  "Use the tools whenever repository context is needed and apply concrete changes when the task requires implementation.",
  "Do not claim to have changed files unless you used the file tools successfully.",
  "All file-tool paths must be relative to the run worktree root.",
  "run_shell already starts in the run worktree root. Do not prefix commands with cd or chain commands with operators.",
  "On Windows, commands run in PowerShell. Prefer Windows-safe command forms.",
  "Share short progress updates during substantive work and finish with a concise summary.",
].join("\n");

export const MODE_INSTRUCTIONS: Record<RunMode, string> = {
  code: "You are in code mode. Implement the requested changes directly when appropriate.",
  plan: "You are in plan mode. Do not modify files; inspect and produce a concrete implementation plan.",
  ask: "You are in ask mode. Do not modify files; inspect only as needed and answer directly.",
};

export const MODE_POLICIES = {
  code: {
    maxToolRounds: 28,
    completionStyle: "Make concrete repository changes when warranted and verify what you changed.",
  },
  plan: {
    maxToolRounds: 12,
    completionStyle: "Prefer analysis and an implementation plan over long exploratory loops.",
  },
  ask: {
    maxToolRounds: 8,
    completionStyle: "Prefer a direct answer with the minimum repo inspection needed.",
  },
} as const;

export const safeJsonParse = (value: string) => {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
};

export const describeToolCall = (name: string, args: Record<string, unknown>) => {
  const interestingValue = args.path ?? args.file_path ?? args.command ?? args.query ?? JSON.stringify(args);
  return `${name}: ${String(interestingValue)}`;
};

export const buildCheckpointMemo = (
  toolCalls: Array<{ name: string; arguments: string }>,
  toolOutputs: string[],
): string => {
  const toolSummary = toolCalls.map((call) => describeToolCall(call.name, safeJsonParse(call.arguments)).slice(0, 180));
  const outputSummary = toolOutputs.map((output) => output.replace(/\s+/g, " ").trim().slice(0, 180)).filter(Boolean);
  return [
    `Completed tool round with ${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"}.`,
    toolSummary.length > 0 ? `Calls: ${toolSummary.join(" | ")}` : "",
    outputSummary.length > 0 ? `Results: ${outputSummary.join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
};

export const isRunToolName = (value: string, toolContext: HarnessToolContext): value is RunToolName =>
  toolContext.tools.some((tool) => tool.name === value);

export const addUsage = (left: RunTokenUsage, right: RunTokenUsage): RunTokenUsage => ({
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
  cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
  cacheCreationInputTokens: (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0),
  totalTokens: (left.totalTokens ?? left.inputTokens + left.outputTokens) + (right.totalTokens ?? right.inputTokens + right.outputTokens),
});

const TEXTISH_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/javascript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
] as const;

const CODE_LIKE_EXT =
  /\.(txt|md|mdx|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|xml|html|htm|css|scss|less|rs|go|py|java|kt|swift|c|h|cpp|hpp|cs|rb|php|sh|sql|toml|ini|env|log|vue|svelte)$/i;

export const isTextishAttachment = (mime: string, fileName: string): boolean => {
  const loweredMime = mime.toLowerCase();
  for (const prefix of TEXTISH_MIME_PREFIXES) {
    if (loweredMime === prefix || loweredMime.startsWith(prefix)) {
      return true;
    }
  }
  if (loweredMime === "application/octet-stream" || loweredMime === "") {
    return CODE_LIKE_EXT.test(fileName);
  }
  return false;
};

export const decodeAttachmentText = (attachment: ChatAttachmentPayload): string => {
  try {
    return Buffer.from(attachment.dataBase64, "base64").toString("utf8");
  } catch {
    return "[Could not decode file as UTF-8]";
  }
};

export const capAttachmentText = (text: string): string => {
  const max = CHAT_ATTACHMENT_LIMITS.maxEmbeddedTextChars;
  return text.length > max ? `${text.slice(0, max)}\n\n[...truncated after ${String(max)} characters]` : text;
};

const shouldRetryProviderRequest = (error: unknown): boolean => {
  const status =
    typeof error === "object" && error && "status" in error
      ? Number((error as { status?: unknown }).status ?? 0)
      : 0;
  if (status === 429 || status === 408 || status >= 500) {
    return true;
  }

  const text = extractErrorText(error).toLowerCase();
  return ["rate limit", "too many requests", "temporarily unavailable", "capacity", "overloaded", "network", "timed out"].some(
    (pattern) => text.includes(pattern),
  );
};

export const extractErrorText = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error) {
    const maybeMessage = "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
    const maybeError = "error" in error ? String((error as { error?: unknown }).error ?? "") : "";
    return `${maybeMessage} ${maybeError}`.trim();
  }
  return String(error);
};

export const withProviderRetry = async <T>(
  operationName: string,
  signal: AbortSignal,
  onChunk: (chunk: HarnessRunChunk) => void,
  devLogger: { log: (event: string, data: unknown) => void } | undefined,
  operation: () => Promise<T>,
): Promise<T> =>
  pRetry(
    async () => {
      if (signal.aborted) {
        throw new AbortError("Aborted");
      }
      try {
        return await operation();
      } catch (error) {
        if (signal.aborted || !shouldRetryProviderRequest(error)) {
          throw new AbortError(extractErrorText(error) || "Aborted");
        }
        devLogger?.log("provider.retry.error", { operationName, error: extractErrorText(error) });
        throw error;
      }
    },
    {
      retries: 4,
      factor: 2,
      minTimeout: 1_000,
      maxTimeout: 15_000,
      randomize: true,
      signal,
      onFailedAttempt: (error) => {
        if (error.retriesLeft <= 0) {
          return;
        }
        onChunk({
          type: "status",
          value: `Transient provider issue during ${operationName}. Retrying...`,
        });
      },
    },
  );
