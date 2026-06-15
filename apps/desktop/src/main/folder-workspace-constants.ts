export const MANAGED_WORKSPACE_DIR = ".buildwarden-worktrees";

export const FOLDER_WORKSPACE_IGNORED_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "target",
  MANAGED_WORKSPACE_DIR,
]);
