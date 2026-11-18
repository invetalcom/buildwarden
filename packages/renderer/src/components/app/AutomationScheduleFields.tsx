import { previewAutomationRunTimes, type AutomationScheduleKind } from "@buildwarden/shared";
import { CalendarClock, Repeat } from "lucide-react";
import { Input } from "../ui/input";
import { SegmentedControl } from "../ui/segmented-control";
import { formatScheduleMoment, formatTimeUntil, oneTimeQuickPicks, previewOneTimeRunAt } from "./automation-schedule-model";

export interface AutomationScheduleDraft {
  scheduleKind: AutomationScheduleKind;
  cronExpression: string;
  runAtLocal: string;
  timeZone: string;
}

interface AutomationScheduleFieldsProps {
  value: AutomationScheduleDraft;
  onChange: (patch: Partial<AutomationScheduleDraft>) => void;
  /** Current time in epoch ms; owned by the page so previews and countdowns tick together. */
  now: number;
}

const SCHEDULE_KIND_OPTIONS = [
  { value: "cron", label: "Repeating" },
  { value: "once", label: "One time" },
] as const satisfies ReadonlyArray<{ value: AutomationScheduleKind; label: string }>;

const SchedulePreview = ({ value, now }: { value: AutomationScheduleDraft; now: number }) => {
  if (value.scheduleKind === "once") {
    const preview = previewOneTimeRunAt(value.runAtLocal, value.timeZone, now);
    return preview.ok ? (
      <p className="mt-2 flex items-center gap-1.5 rounded-md bg-[var(--ec-accent-soft)] px-2 py-1.5 text-[11px] text-[var(--ec-text)]">
        <CalendarClock className="size-3.5 shrink-0 text-[var(--ec-accent)]" />
        <span className="min-w-0 truncate">Runs <span className="font-semibold text-[var(--ec-accent)]">{formatScheduleMoment(preview.runAt, value.timeZone, { withYear: true })}</span> ({value.timeZone}) · {formatTimeUntil(preview.runAt, now)}</span>
      </p>
    ) : (
      <p className="mt-2 rounded-md bg-[var(--ec-danger-soft)] px-2 py-1.5 text-[11px] text-[var(--ec-danger)]">{preview.message}</p>
    );
  }
  const upcoming = previewAutomationRunTimes(value.cronExpression, value.timeZone, new Date(now), 3);
  if (upcoming.length === 0) {
    return <p className="mt-2 px-0.5 text-[11px] text-[var(--ec-faint)]">Enter a valid cron schedule to preview its next starts.</p>;
  }
  return (
    <p className="mt-2 flex items-center gap-1.5 rounded-md bg-[var(--ec-accent-soft)] px-2 py-1.5 text-[11px] text-[var(--ec-text)]">
      <Repeat className="size-3.5 shrink-0 text-[var(--ec-accent)]" />
      <span className="min-w-0 truncate">
        Next <span className="font-semibold text-[var(--ec-accent)]">{formatScheduleMoment(upcoming[0]!, value.timeZone)}</span>
        {upcoming.slice(1).map((time) => <span key={time} className="text-[var(--ec-muted)]"> · {formatScheduleMoment(time, value.timeZone)}</span>)}
      </span>
    </p>
  );
};

/** Schedule type switch plus the cron or one-time fields of the automation editor. */
export const AutomationScheduleFields = ({ value, onChange, now }: AutomationScheduleFieldsProps) => {
  const quickPicks = value.scheduleKind === "once" ? oneTimeQuickPicks(value.timeZone, now) : [];
  return (
    <div className="md:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-[var(--ec-muted)]">Schedule</span>
        <SegmentedControl
          label="Schedule type"
          options={SCHEDULE_KIND_OPTIONS}
          value={value.scheduleKind}
          onChange={(scheduleKind) => onChange({ scheduleKind })}
        />
      </div>
      <div className="mt-1.5 grid gap-3 md:grid-cols-2">
        {value.scheduleKind === "once" ? (
          <div className="text-xs text-[var(--ec-muted)]">
            <label className="block">
              Run at
              <Input
                type="datetime-local"
                className="mt-1 h-9"
                value={value.runAtLocal}
                onChange={(event) => onChange({ runAtLocal: event.target.value })}
              />
            </label>
            {quickPicks.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1" role="group" aria-label="Quick start times">
                {quickPicks.map((pick) => (
                  <button
                    key={pick.label}
                    type="button"
                    className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)] ${value.runAtLocal === pick.value ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]" : "border-[var(--ec-border)] text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"}`}
                    onClick={() => onChange({ runAtLocal: pick.value })}
                  >
                    {pick.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <label className="text-xs text-[var(--ec-muted)]">
            Cron schedule
            <Input className="mt-1 h-9 font-mono" value={value.cronExpression} onChange={(event) => onChange({ cronExpression: event.target.value })} placeholder="0 9 * * 1-5" />
            <span className="mt-1 block text-[10px] text-[var(--ec-faint)]">minute hour day month weekday · e.g. <code>*/30 * * * *</code></span>
          </label>
        )}
        <label className="text-xs text-[var(--ec-muted)]">
          Time zone
          <Input className="mt-1 h-9" value={value.timeZone} onChange={(event) => onChange({ timeZone: event.target.value })} />
        </label>
      </div>
      <SchedulePreview value={value} now={now} />
    </div>
  );
};
