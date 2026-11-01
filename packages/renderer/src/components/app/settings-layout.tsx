import type { ReactNode } from "react";
import { Card } from "../ui/card";
import { useInstanceContext } from "../../lib/instance-context";
import { useOptionalBuildWardenClient } from "../../lib/buildwarden-client";

export type SettingsSectionProps = {
  title: string;
  /** Section-level controls, such as save/reset, shown on the heading line. */
  actions?: ReactNode;
  children: ReactNode;
  scope?: "browser" | "instance";
};

export type SettingsRowProps = {
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
  align?: "center" | "start";
};

export const SettingsSection = ({ title, actions, children, scope = "instance" }: SettingsSectionProps) => {
  const instances = useInstanceContext();
  const client = useOptionalBuildWardenClient();
  const target = instances?.instances.find((entry) => entry.id === instances.activeInstanceId);
  return (
  <section className="space-y-2">
    <div className="flex min-h-7 items-center justify-between gap-3 px-1">
      <h3 className="text-sm font-semibold text-[var(--ec-text)]">{title}{instances && <span className="ml-1 text-[10px] font-normal text-[var(--ec-muted)]">{scope === "browser" ? "This browser" : target?.label}</span>}</h3>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
    <fieldset className="min-w-0 border-0 p-0" disabled={Boolean(instances && scope === "instance" && !client?.capabilities.settings)}>
      <Card className="overflow-hidden p-0 shadow-none">{children}</Card>
    </fieldset>
  </section>
);
};

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
