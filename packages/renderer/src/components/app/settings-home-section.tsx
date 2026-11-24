import { useEffect, useState } from "react";
import {
  DEFAULT_HOME_LAYOUT,
  HOME_CHART_METRICS,
  HOME_CHART_RANGES,
  HOME_LIMITS,
  HOME_SECTIONS,
  HOME_STATS,
  isDefaultHomeLayout,
  type HomeChartMetric,
  type HomeLayout,
  type HomePosition,
} from "@buildwarden/shared";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SegmentedControl } from "../ui/segmented-control";
import { Slider } from "../ui/slider";
import { Switch } from "../ui/switch";
import { OrderedToggleList } from "./ordered-toggle-list";
import { SettingsRow, SettingsSection } from "./settings-layout";

const SECTION_ITEMS = HOME_SECTIONS.map((entry) => ({ key: entry.key, label: entry.label, hint: entry.description }));
const STAT_ITEMS = HOME_STATS.map((entry) => ({ key: entry.key, label: entry.label, hint: entry.description }));
const RANGE_OPTIONS = HOME_CHART_RANGES.map((range) => ({ value: range, label: `${String(range)} days` }));
const POSITION_OPTIONS: ReadonlyArray<{ value: HomePosition; label: string }> = [
  { value: "center", label: "Centered" },
  { value: "top", label: "Top" },
];

/**
 * What the Home page shows. Every change is saved at once; agents change the same setting through
 * the `home` field of `buildwarden_theme_set`.
 */
export const HomeLayoutSettingsSection = ({ layout, busy, costTrackingEnabled, onChange }: {
  layout: HomeLayout;
  busy: boolean;
  /** The cost lane only has data while cost tracking is on. */
  costTrackingEnabled: boolean;
  /** A returned promise that rejects means the save failed. */
  onChange: (layout: HomeLayout) => void | Promise<void>;
}) => {
  // Sliders and the text field change this copy while they move and save when they settle.
  const [draft, setDraft] = useState(layout);
  useEffect(() => setDraft(layout), [layout]);
  const save = (patch: Partial<HomeLayout>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    // The app reports a failed save. The controls then go back to what is saved.
    void Promise.resolve(onChange(next)).catch(() => setDraft(layout));
  };
  const saveChart = (patch: Partial<HomeLayout["chart"]>) => save({ chart: { ...draft.chart, ...patch } });
  const toggleMetric = (metric: HomeChartMetric, on: boolean) =>
    saveChart({ metrics: HOME_CHART_METRICS.map((entry) => entry.key).filter((key) => (key === metric ? on : draft.chart.metrics.includes(key))) });
  const commitGreeting = () => {
    const text = draft.greetingText.trim();
    if (text !== layout.greetingText) save({ greetingText: text });
  };
  const showsSection = (section: HomeLayout["sections"][number]) => draft.sections.includes(section);

  return (
    <SettingsSection title="Home page" scope="browser" actions={isDefaultHomeLayout(layout) ? null : (
      <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => save(DEFAULT_HOME_LAYOUT)}>Reset</Button>
    )}>
      <div className="border-b border-[var(--ec-border)]">
        <p className="px-3.5 pt-2.5 text-xs text-[var(--ec-muted)]">Sections in the middle of the page, in this order. Agents can rearrange the page too: ask one to change the Home page.</p>
        <OrderedToggleList items={SECTION_ITEMS} active={draft.sections} label="Home page sections" switchLabel={(label) => `Show ${label} on the Home page`}
          disabled={busy} onChange={(sections) => save({ sections })} />
      </div>
      <SettingsRow title="Greeting" description="Text of the large line. Leave it empty to be greeted by the time of day.">
        <Input aria-label="Greeting text" placeholder="Good morning" value={draft.greetingText} maxLength={HOME_LIMITS.greetingText} disabled={busy || !showsSection("greeting")}
          onChange={(event) => setDraft((current) => ({ ...current, greetingText: event.target.value }))}
          onBlur={commitGreeting}
          onKeyDown={(event) => { if (event.key === "Enter") commitGreeting(); }} />
      </SettingsRow>
      <div className="border-b border-[var(--ec-border)]">
        <p className="px-3.5 pt-2.5 text-xs text-[var(--ec-muted)]">Figures of the Numbers section, in this order.{costTrackingEnabled ? "" : " Cost shows all-time tokens until cost tracking is on."}</p>
        <OrderedToggleList items={STAT_ITEMS} active={draft.stats} label="Home page numbers" switchLabel={(label) => `Show ${label} in the numbers`}
          disabled={busy || !showsSection("stats")} minActive={1} onChange={(stats) => save({ stats })} />
      </div>
      <SettingsRow title="Recent runs" description="Number of runs the Recent runs section lists.">
        <Slider aria-label="Recent runs" value={draft.recentRuns} min={HOME_LIMITS.recentRuns[0]} max={HOME_LIMITS.recentRuns[1]} step={1} showValue disabled={busy || !showsSection("runs")}
          onValueChange={(recentRuns) => setDraft((current) => ({ ...current, recentRuns }))} onValueCommit={(recentRuns) => save({ recentRuns })} />
      </SettingsRow>
      <SettingsRow title="Activity chart" description="Chart along the bottom edge of the page. Each metric is a lane with its own scale over the same days.">
        <div className="flex justify-end">
          <Switch aria-label="Activity chart" checked={draft.chart.show} disabled={busy} onCheckedChange={(show) => saveChart({ show })} />
        </div>
      </SettingsRow>
      <SettingsRow title="Chart metrics" description={`What the chart shows. You can also switch these on the page itself.${costTrackingEnabled ? "" : " Cost needs cost tracking, which is off."}`}>
        <div className="flex flex-wrap justify-end gap-x-5 gap-y-2">
          {HOME_CHART_METRICS.map((metric) => {
            const on = draft.chart.metrics.includes(metric.key);
            return (
              <label key={metric.key} className="flex items-center gap-2 text-xs text-[var(--ec-text)]">
                {metric.label}
                <Switch aria-label={`Show ${metric.label} in the chart`} checked={on} disabled={busy || !draft.chart.show || (on && draft.chart.metrics.length === 1)} onCheckedChange={(checked) => toggleMetric(metric.key, checked)} />
              </label>
            );
          })}
        </div>
      </SettingsRow>
      <SettingsRow title="Chart range" description="Days the chart covers.">
        <div className="flex justify-end">
          <SegmentedControl label="Chart range" options={RANGE_OPTIONS} value={draft.chart.range} disabled={busy || !draft.chart.show} onChange={(range) => saveChart({ range })} />
        </div>
      </SettingsRow>
      <SettingsRow title="Boot message" description="The joke in the top left corner, styled as a line of a boot log.">
        <div className="flex justify-end">
          <Switch aria-label="Boot message" checked={draft.bootMessage} disabled={busy} onCheckedChange={(bootMessage) => save({ bootMessage })} />
        </div>
      </SettingsRow>
      <SettingsRow title="Content width" description="Width of the middle sections, in percent of the page. The chart always spans the page.">
        <Slider aria-label="Content width" value={draft.width} min={HOME_LIMITS.width[0]} max={HOME_LIMITS.width[1]} step={1} showValue valueSuffix="%" disabled={busy}
          onValueChange={(width) => setDraft((current) => ({ ...current, width }))} onValueCommit={(width) => save({ width })} />
      </SettingsRow>
      <SettingsRow title="Position" description="Where the middle sections sit: in the vertical center of the page, or at its top.">
        <div className="flex justify-end">
          <SegmentedControl label="Position" options={POSITION_OPTIONS} value={draft.position} disabled={busy} onChange={(position) => save({ position })} />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
};
