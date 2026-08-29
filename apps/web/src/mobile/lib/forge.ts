import type { RunForgeReadiness } from "@buildwarden/shared";

export const mobileForgeColor: Record<RunForgeReadiness, string> = {
  ready: "var(--ec-success)",
  pending: "var(--ec-warning)",
  blocked: "var(--ec-danger)",
  merged: "var(--ec-secondary)",
  closed: "var(--ec-faint)",
  unavailable: "var(--ec-faint)",
};
