import { CHAT_ATTACHMENT_LIMITS } from "@buildwarden/shared";
import { countTokens } from "gpt-tokenizer";

const IMAGE_ATTACHMENT_TOKENS = 1_200;
const PDF_ATTACHMENT_TOKENS = 2_200;
const BINARY_ATTACHMENT_TOKENS = 700;
const CHAT_OVERHEAD_TOKENS = 300;
const RUN_OVERHEAD_TOKENS = 1_400;

const TEXT_LIKE_FILE_EXT = /\.(txt|md|mdx|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|xml|html|htm|css|scss|less|rs|go|py|java|kt|swift|c|h|cpp|hpp|cs|rb|php|sh|sql|toml|ini|env|log|vue|svelte)$/i;

const MODEL_CONTEXT_WINDOWS: Array<{ match: RegExp; maxTokens: number }> = [
  { match: /^gpt-5(?:$|[.-])/i, maxTokens: 400_000 },
  { match: /^gpt-5-mini(?:$|[.-])/i, maxTokens: 400_000 },
  { match: /^gpt-5-nano(?:$|[.-])/i, maxTokens: 400_000 },
  { match: /^gpt-4\.1(?:$|[.-])/i, maxTokens: 1_048_576 },
  { match: /^o[134](?:$|[.-])/i, maxTokens: 200_000 },
  { match: /^claude/i, maxTokens: 200_000 },
  { match: /^gemini/i, maxTokens: 1_048_576 },
  { match: /^grok/i, maxTokens: 256_000 },
];

export interface ContextWindowEstimate {
  usedTokens: number;
  maxTokens: number;
  remainingTokens: number;
  usedPercent: number;
  remainingPercent: number;
}

interface ContextWindowEstimateInput {
  modelIds: string[];
  prompt: string;
  historyText?: string;
  attachmentFiles?: File[];
  isRun?: boolean;
}

const estimateTextTokens = (text: string): number => {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  try {
    return countTokens(trimmed);
  } catch {
    return Math.max(1, Math.ceil(trimmed.length / 4));
  }
};

const isTextLikeAttachment = (file: File): boolean => {
  const mime = (file.type || "").toLowerCase();
  if (mime.startsWith("text/")) {
    return true;
  }
  if (mime === "application/json" || mime === "application/xml" || mime === "application/yaml" || mime === "application/x-yaml") {
    return true;
  }
  return TEXT_LIKE_FILE_EXT.test(file.name);
};

const estimateAttachmentTokens = (files: File[]): number =>
  files.reduce((sum, file) => {
    const mime = (file.type || "").toLowerCase();
    if (mime.startsWith("image/")) {
      return sum + IMAGE_ATTACHMENT_TOKENS;
    }
    if (mime === "application/pdf") {
      return sum + Math.min(8_000, Math.max(PDF_ATTACHMENT_TOKENS, Math.ceil(file.size / 90)));
    }
    if (isTextLikeAttachment(file)) {
      const approxChars = Math.min(file.size, CHAT_ATTACHMENT_LIMITS.maxEmbeddedTextChars);
      return sum + Math.max(1, Math.ceil(approxChars / 4));
    }
    return sum + Math.min(4_000, Math.max(BINARY_ATTACHMENT_TOKENS, Math.ceil(file.size / 180)));
  }, 0);

const getMaxContextTokens = (modelIds: string[]): number | null => {
  const matches = modelIds
    .map((modelId) => {
      const normalized = modelId.trim();
      if (!normalized) {
        return null;
      }
      const found = MODEL_CONTEXT_WINDOWS.find((entry) => entry.match.test(normalized));
      return found?.maxTokens ?? null;
    })
    .filter((value): value is number => value !== null);

  if (matches.length === 0) {
    return null;
  }
  return Math.min(...matches);
};

export const formatCompactTokens = (value: number): string => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  }
  return value.toLocaleString();
};

export const estimateContextWindow = ({
  modelIds,
  prompt,
  historyText = "",
  attachmentFiles = [],
  isRun = false,
}: ContextWindowEstimateInput): ContextWindowEstimate | null => {
  const maxTokens = getMaxContextTokens(modelIds);
  if (!maxTokens) {
    return null;
  }

  const usedTokens =
    estimateTextTokens(prompt) +
    estimateTextTokens(historyText) +
    estimateAttachmentTokens(attachmentFiles) +
    (isRun ? RUN_OVERHEAD_TOKENS : CHAT_OVERHEAD_TOKENS);

  const clampedUsed = Math.max(0, Math.min(usedTokens, maxTokens));
  const remainingTokens = Math.max(0, maxTokens - clampedUsed);
  const usedPercent = Math.max(0, Math.min(100, Math.round((clampedUsed / maxTokens) * 100)));

  return {
    usedTokens: clampedUsed,
    maxTokens,
    remainingTokens,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
  };
};

export const buildVisibleConversationHistory = (
  steps: Array<{ eventType: string; title: string; content: string; metadataJson: string }>,
): string =>
  steps
    .flatMap((step) => {
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
      } catch {
        metadata = {};
      }

      if (step.eventType === "log" && metadata.source === "user") {
        return [step.content];
      }

      if (step.eventType === "output") {
        if (metadata.assistantKind === "reasoning" || step.title === "Reasoning") {
          return [];
        }
        return [step.content];
      }

      return [];
    })
    .join("\n\n");
