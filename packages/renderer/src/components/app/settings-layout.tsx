import type { ReactNode } from "react";
import { useInstanceContext } from "../../lib/instance-context";
import { useOptionalBuildWardenClient } from "../../lib/buildwarden-client";

export type SettingsSectionProps = {
  title: string;
  /** Section-level controls, such as save/reset, shown on the heading line. */
  actions?: ReactNode;
  children: ReactNode;
  /** Mixed sections combine browser and host settings; each control enforces its own permissions. */
  scope?: "browser" | "instance" | "mixed";
};

export type SettingsRowProps = {
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
  align?: "center" | "start";
};

/** A titled group of settings. The group is one tinted block; rows inside are split by hairlines. */
export const SettingsSection = ({ title, actions, children, scope = "instance" }: SettingsSectionProps) => {
  const instances = useInstanceContext();
  const client = useOptionalBuildWardenClient();
  const target = instances?.instances.find((entry) => entry.id === instances.activeInstanceId);
  return (
  <section className="space-y-1.5">
    <div className="flex min-h-7 items-center justify-between gap-3 px-1">
      <h3 className="text-[13px] font-semibold text-[var(--ec-text)]">{title}{instances && scope !== "mixed" && <span className="ml-1 text-[10px] font-normal text-[var(--ec-muted)]">{scope === "browser" ? "This browser" : target?.label}</span>}</h3>
      {actions ? <div className="relative flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
    <fieldset className="min-w-0 border-0 p-0" disabled={Boolean(instances && scope === "instance" && !client?.capabilities.settings)}>
      <div data-ui="card" className="overflow-hidden rounded-lg bg-[var(--ec-panel)]">{children}</div>
    </fieldset>
  </section>
);
};

export const SettingsRow = ({ title, description, children, align = "center" }: SettingsRowProps) => (
  <div
    data-ui="settings-row"
    className={`grid gap-x-6 gap-y-2 border-b border-[var(--ec-border)] px-3.5 py-2.5 last:border-b-0 md:grid-cols-[minmax(14rem,0.85fr)_minmax(18rem,1.35fr)] ${
      align === "start" ? "md:items-start" : "md:items-center"
    }`}
  >
    <div className="min-w-0">
      <div className="text-[13px] font-medium text-[var(--ec-text)]">{title}</div>
      <div className="mt-0.5 text-xs leading-5 text-[var(--ec-muted)]">{description}</div>
    </div>
    <div className={`min-w-0 w-full md:justify-self-end ${align === "start" ? "md:self-start" : "md:self-center"}`}>{children}</div>
  </div>
);
