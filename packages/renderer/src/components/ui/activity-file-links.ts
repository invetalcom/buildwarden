import { parseRunWorkspaceFileReference } from "@buildwarden/shared";

const LINE_SUFFIX_RE = /(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/i;
const hasSupportedFileExtension = (value: string): boolean => {
  const fileName = value.replace(/\\/g, "/").split("/").at(-1) ?? "";
  if (!fileName || /[<>:"|?*\r\n]/.test(fileName)) {
    return false;
  }
  const extensionSeparator = fileName.lastIndexOf(".");
  if (extensionSeparator <= 0 || extensionSeparator === fileName.length - 1) {
    return false;
  }
  const extension = fileName.slice(extensionSeparator + 1);
  return extension.length > 0 && extension.length <= 16 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(extension);
};

const COMMON_FILE_REFERENCES = new Set([
  ".env",
  ".env.example",
  ".env.local",
  ".eslintrc",
  ".eslintrc.cjs",
  ".eslintrc.js",
  ".gitignore",
  "agents.md",
  "dockerfile",
  "makefile",
  "package.json",
  "pnpm-lock.yaml",
  "pom.xml",
  "readme.md",
  "tsconfig.json",
  "vite.config.ts",
]);

const inlineTextFromChildren = (children: unknown): string | null => {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (!Array.isArray(children)) {
    return null;
  }

  let text = "";
  for (const child of children) {
    if (typeof child !== "string" && typeof child !== "number") {
      return null;
    }
    text += String(child);
  }
  return text;
};

export const looksLikeRunWorkspaceFilePath = (path: string): boolean => {
  const trimmed = path.trim();
  if (!trimmed || trimmed.length > 2048 || /[\r\n]/.test(trimmed)) {
    return false;
  }

  const pathWithoutLineTarget = trimmed.replace(LINE_SUFFIX_RE, "");
  if (!pathWithoutLineTarget || pathWithoutLineTarget.endsWith("/") || pathWithoutLineTarget.endsWith("\\")) {
    return false;
  }

  const normalized = pathWithoutLineTarget.replace(/\\/g, "/");
  const basename = normalized.split("/").filter(Boolean).at(-1)?.toLowerCase() ?? "";
  const hasPathSeparator = /[\\/]/.test(pathWithoutLineTarget);
  const hasFileExtension = hasSupportedFileExtension(pathWithoutLineTarget);
  const hasCommonFileName = COMMON_FILE_REFERENCES.has(basename);

  return hasCommonFileName || (hasPathSeparator && hasFileExtension);
};

export const getOpenableInlineCodePath = (children: unknown): string | null => {
  const text = inlineTextFromChildren(children)?.trim();
  if (!text || !looksLikeRunWorkspaceFilePath(text)) {
    return null;
  }
  return parseRunWorkspaceFileReference(text) ? text : null;
};
