/**
 * What the Home page shows and how it is arranged. It is a setting of its own (not part of a
 * design scheme), so it stays when the theme changes. People edit it in Settings; agents read and
 * change it through `buildwarden_theme_read` and the `home` field of `buildwarden_theme_set`.
 */

interface HomeOption<Key extends string> {
  key: Key;
  label: string;
  description: string;
}

const option = <Key extends string>(key: Key, label: string, description: string): HomeOption<Key> => ({ key, label, description });

/** Blocks in the middle of the page. A layout lists the ones it shows, in display order. */
export const HOME_SECTIONS = [
  option("greeting", "Greeting", "Large line of text, by default a greeting for the time of day"),
  option("summary", "Status sentence", "One sentence on today's runs and what is waiting for you"),
  option("stats", "Numbers", "A row of key figures"),
  option("runs", "Recent runs", "The latest runs across all projects"),
  option("projects", "Projects", "Every project with its run count and outcome share"),
  option("providers", "By provider", "Runs and tokens per provider in the chart's range"),
] as const;
export type HomeSection = (typeof HOME_SECTIONS)[number]["key"];
export const DEFAULT_HOME_SECTIONS: readonly HomeSection[] = ["greeting", "summary", "stats", "runs"];

/** Figures the "Numbers" section can show, in the order a layout lists them. */
export const HOME_STATS = [
  option("running", "Running now", "Runs in progress"),
  option("today", "Today", "Runs started today and the tokens used"),
  option("success", "Success rate", "Share of finished runs that completed"),
  option("cost", "Cost", "Estimated cost of the last 30 days; all-time tokens while cost tracking is off"),
  option("tokens", "Tokens", "Tokens used since the app was set up"),
  option("waiting", "Waiting", "Approvals and questions waiting for you"),
] as const;
export type HomeStat = (typeof HOME_STATS)[number]["key"];
export const DEFAULT_HOME_STATS: readonly HomeStat[] = ["running", "today", "success", "cost"];

/** Lanes of the activity chart, top to bottom. Each has its own scale over one shared time axis. */
export const HOME_CHART_METRICS = [
  option("runs", "Runs", "Runs started per day"),
  option("tokens", "Tokens", "Tokens used per day"),
  option("cost", "Cost", "Estimated cost per day; only while cost tracking is on"),
] as const;
export type HomeChartMetric = (typeof HOME_CHART_METRICS)[number]["key"];

export const HOME_CHART_RANGES = [7, 14, 30] as const;
export type HomeChartRange = (typeof HOME_CHART_RANGES)[number];

export const HOME_POSITIONS = ["center", "top"] as const;
export type HomePosition = (typeof HOME_POSITIONS)[number];

export const HOME_LIMITS = { recentRuns: [1, 8], width: [40, 100], greetingText: 80 } as const;

export interface HomeLayout {
  /** Middle sections that show, in display order. */
  sections: HomeSection[];
  /** The boot message (a joke styled as a log line) in the top left corner. */
  bootMessage: boolean;
  /** Text of the greeting. Empty greets by time of day. */
  greetingText: string;
  /** Figures of the "Numbers" section, in display order. */
  stats: HomeStat[];
  /** Rows of the "Recent runs" section. */
  recentRuns: number;
  chart: {
    /** The activity chart along the bottom edge. */
    show: boolean;
    /** Lanes that show. Never empty. */
    metrics: HomeChartMetric[];
    /** Days the chart covers. */
    range: HomeChartRange;
  };
  /** Width of the middle sections in percent of the page. */
  width: number;
  /** Whether the middle sections sit in the vertical center of the page or at its top. */
  position: HomePosition;
}

export const DEFAULT_HOME_LAYOUT: HomeLayout = {
  sections: [...DEFAULT_HOME_SECTIONS],
  bootMessage: true,
  greetingText: "",
  stats: [...DEFAULT_HOME_STATS],
  recentRuns: 3,
  chart: { show: true, metrics: ["runs", "tokens", "cost"], range: 30 },
  width: 60,
  position: "center",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const keysOf = <Key extends string>(options: ReadonlyArray<HomeOption<Key>>): readonly Key[] => options.map((entry) => entry.key);

/** The known entries of a list, without repeats, in the order given. Undefined when it is no list. */
const knownList = <Key extends string>(value: unknown, known: readonly Key[]): Key[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const result: Key[] = [];
  for (const entry of value) {
    const key = known.find((candidate) => candidate === entry);
    if (key && !result.includes(key)) result.push(key);
  }
  return result;
};

const boundedInteger = (value: unknown, [min, max]: readonly [number, number]): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : undefined;

/**
 * Merges a partial layout into `base`. Valid fields replace the ones in `base`; `null` returns a
 * field to its default; everything else is left alone and reported in `ignored`, so one bad field
 * never discards the rest.
 */
export const mergeHomeLayout = (base: HomeLayout, patch: unknown): { layout: HomeLayout; ignored: string[] } => {
  const layout: HomeLayout = { ...base, sections: [...base.sections], stats: [...base.stats], chart: { ...base.chart, metrics: [...base.chart.metrics] } };
  const ignored: string[] = [];
  if (!isRecord(patch)) return { layout, ignored };

  const list = <Key extends string>(field: string, value: unknown, known: readonly Key[], fallback: readonly Key[], allowEmpty: boolean): Key[] | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return [...fallback];
    const entries = knownList(value, known);
    if (!entries) { ignored.push(field); return undefined; }
    if (Array.isArray(value)) value.forEach((entry, index) => { if (!known.some((key) => key === entry)) ignored.push(`${field}[${String(index)}]`); });
    if (entries.length === 0 && !allowEmpty) { ignored.push(field); return undefined; }
    return entries;
  };
  const flag = (field: string, value: unknown, fallback: boolean): boolean | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return fallback;
    if (typeof value === "boolean") return value;
    ignored.push(field);
    return undefined;
  };
  const number = (field: string, value: unknown, limits: readonly [number, number], fallback: number): number | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return fallback;
    const next = boundedInteger(value, limits);
    if (next === undefined) ignored.push(field);
    return next;
  };

  for (const key of Object.keys(patch)) {
    if (!(key in DEFAULT_HOME_LAYOUT)) ignored.push(key);
  }

  layout.sections = list("sections", patch.sections, keysOf(HOME_SECTIONS), DEFAULT_HOME_LAYOUT.sections, true) ?? layout.sections;
  layout.stats = list("stats", patch.stats, keysOf(HOME_STATS), DEFAULT_HOME_LAYOUT.stats, false) ?? layout.stats;
  layout.bootMessage = flag("bootMessage", patch.bootMessage, DEFAULT_HOME_LAYOUT.bootMessage) ?? layout.bootMessage;
  layout.recentRuns = number("recentRuns", patch.recentRuns, HOME_LIMITS.recentRuns, DEFAULT_HOME_LAYOUT.recentRuns) ?? layout.recentRuns;
  layout.width = number("width", patch.width, HOME_LIMITS.width, DEFAULT_HOME_LAYOUT.width) ?? layout.width;

  if (patch.greetingText === null) layout.greetingText = "";
  else if (typeof patch.greetingText === "string") layout.greetingText = patch.greetingText.trim().slice(0, HOME_LIMITS.greetingText);
  else if (patch.greetingText !== undefined) ignored.push("greetingText");

  if (patch.position === null) layout.position = DEFAULT_HOME_LAYOUT.position;
  else if (HOME_POSITIONS.some((position) => position === patch.position)) layout.position = patch.position as HomePosition;
  else if (patch.position !== undefined) ignored.push("position");

  if (patch.chart === null) {
    layout.chart = { ...DEFAULT_HOME_LAYOUT.chart, metrics: [...DEFAULT_HOME_LAYOUT.chart.metrics] };
  } else if (isRecord(patch.chart)) {
    const chart = patch.chart;
    for (const key of Object.keys(chart)) {
      if (!(key in DEFAULT_HOME_LAYOUT.chart)) ignored.push(`chart.${key}`);
    }
    layout.chart.show = flag("chart.show", chart.show, DEFAULT_HOME_LAYOUT.chart.show) ?? layout.chart.show;
    layout.chart.metrics = list("chart.metrics", chart.metrics, keysOf(HOME_CHART_METRICS), DEFAULT_HOME_LAYOUT.chart.metrics, false) ?? layout.chart.metrics;
    if (chart.range === null) layout.chart.range = DEFAULT_HOME_LAYOUT.chart.range;
    else if (HOME_CHART_RANGES.some((range) => range === chart.range)) layout.chart.range = chart.range as HomeChartRange;
    else if (chart.range !== undefined) ignored.push("chart.range");
  } else if (patch.chart !== undefined) {
    ignored.push("chart");
  }

  return { layout, ignored };
};

/** Reads the stored setting. Missing or damaged fields fall back to their defaults. */
export const parseHomeLayout = (value?: string | null): HomeLayout => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "{}");
  } catch {
    parsed = {};
  }
  return mergeHomeLayout(DEFAULT_HOME_LAYOUT, parsed).layout;
};

export const serializeHomeLayout = (layout: HomeLayout): string => JSON.stringify(mergeHomeLayout(DEFAULT_HOME_LAYOUT, layout).layout);

export const isDefaultHomeLayout = (layout: HomeLayout): boolean => serializeHomeLayout(layout) === serializeHomeLayout(DEFAULT_HOME_LAYOUT);

/** Stable hooks of the Home page for custom theme CSS. */
export const HOME_CSS_HOOKS: ReadonlyArray<{ selector: string; styles: string }> = [
  { selector: '[data-ui="home"]', styles: "The Home page" },
  { selector: '[data-ui="home-boot"]', styles: "Boot message in the top left corner of Home" },
  { selector: '[data-ui="home-section"]', styles: "One middle section of Home; [data-section] is greeting, summary, stats, runs, projects or providers" },
  { selector: '[data-ui="home-stat"]', styles: "One figure on Home with its label; [data-stat] is running, today, success, cost, tokens or waiting" },
  { selector: '[data-ui="home-chart"]', styles: "Activity chart along the bottom edge of Home" },
  { selector: '[data-ui="home-chart-lane"]', styles: "One lane of the Home chart; [data-metric] is runs, tokens or cost" },
];

const describe = (options: ReadonlyArray<HomeOption<string>>): string => options.map((entry) => `${entry.key} (${entry.description})`).join(", ");

/** What an agent needs to rearrange the Home page. Part of the guide `buildwarden_theme_read` returns. */
export const HOME_LAYOUT_GUIDE = [
  "Home page (`home` in buildwarden_theme_set): what the start page shows. It is stored apart from the theme, so it stays when the theme or preset changes. Omitted fields stay as they are, null returns one to its default, and `home: null` resets the whole page.",
  `\`home.sections\`: the middle sections that show, in order. Any of ${describe(HOME_SECTIONS)}. Default: ${DEFAULT_HOME_SECTIONS.join(", ")}.`,
  `\`home.stats\`: the figures of the stats section, in order. Any of ${describe(HOME_STATS)}. Default: ${DEFAULT_HOME_STATS.join(", ")}.`,
  `\`home.recentRuns\` ${String(HOME_LIMITS.recentRuns[0])} to ${String(HOME_LIMITS.recentRuns[1])} rows. \`home.greetingText\` replaces the greeting (up to ${String(HOME_LIMITS.greetingText)} characters; empty greets by time of day). \`home.bootMessage\` (true, false) shows the joke line in the top left corner.`,
  `\`home.chart.show\` (true, false), \`home.chart.metrics\` (any of ${describe(HOME_CHART_METRICS)}; at least one) and \`home.chart.range\` (${HOME_CHART_RANGES.join(", ")} days) set the activity chart at the bottom edge. Each metric is a lane with its own scale.`,
  `\`home.width\` ${String(HOME_LIMITS.width[0])} to ${String(HOME_LIMITS.width[1])} is the width of the middle sections in percent of the page, and \`home.position\` (${HOME_POSITIONS.join(", ")}) places them in the vertical center or at the top.`,
  "Colors of Home come from the theme: the chart lanes use `charts.series1` (runs), `charts.series2` (tokens) and `charts.series3` (cost), and text follows the palette. Use the Home selectors in `css` for anything else.",
].join("\n");
