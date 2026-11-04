import type { CouncilSeverity } from "@buildwarden/shared";

export const SEVERITY_STYLES: Record<CouncilSeverity, { label: string; dot: string }> = {
  high: { label: "High", dot: "bg-[var(--ec-danger)]" },
  medium: { label: "Med", dot: "bg-[var(--ec-warning)]" },
  low: { label: "Low", dot: "bg-[var(--ec-muted)]" },
};
