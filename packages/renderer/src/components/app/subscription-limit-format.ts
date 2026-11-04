export function subscriptionResetCountdown(timestamp: string, now: number): string {
  const minutes = Math.max(0, Math.ceil((Date.parse(timestamp) - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  return days ? `in ${days}d ${hours}h` : hours ? `in ${hours}h ${minutes % 60}m` : `in ${minutes}m`;
}

export const subscriptionUsageColor = (used: number) => used >= 95 ? "var(--ec-danger)" : used >= 80 ? "var(--ec-warning)" : "var(--ec-accent)";
