import type { ProjectLabMode } from "@buildwarden/shared";

export const PROJECT_LAB_MODE_LABELS: Record<ProjectLabMode, string> = {
  "new-feature": "New feature",
  bugfix: "Bugfix",
  refactoring: "Refactoring",
  "rfc-only": "RFC only",
};
