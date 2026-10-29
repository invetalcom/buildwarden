import type { ReactNode } from "react";
import { Card } from "../ui/card";

export type SettingsSectionProps = {
  title: string;
  /** Section-level controls, such as save/reset, shown on the heading line. */
  actions?: ReactNode;
  children: ReactNode;
};

export type SettingsRowProps = {
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
  align?: "center" | "start";
};

export const SettingsSection = ({ title, actions, children }: SettingsSectionProps) => (
  <section className="space-y-2">
    <div className="flex min-h-7 items-center justify-between gap-3 px-1">
      <h3 className="text-sm font-semibold text-[var(--ec-text)]">{title}</h3>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
    <Card className="overflow-hidden p-0 shadow-none">{children}</Card>
  </section>
);

export const SettingsRow = ({ title, description, children, align = "center" }: SettingsRowProps) => (
  <div
    className={`grid gap-3 border-b border-[var(--ec-border)] px-4 py-3 last:border-b-0 md:grid-cols-[minmax(14rem,0.85fr)_minmax(18rem,1.35fr)] ${
      align === "start" ? "md:items-start" : "md:items-center"
    }`}
  >
    <div className="min-w-0">
      <div className="text-sm font-medium text-[var(--ec-text)]">{title}</div>
      <div className="mt-1 text-xs leading-5 text-[var(--ec-muted)]">{description}</div>
    </div>
    <div className={`min-w-0 w-full md:justify-self-end ${align === "start" ? "md:self-start" : "md:self-center"}`}>{children}</div>
  </div>
);
