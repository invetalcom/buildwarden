import type { HarnessType, ProviderType } from "@buildwarden/shared";
import { PROVIDER_BRAND_LABELS, type ProviderBrandKey } from "./provider-brand-metadata";

/**
 * Provider marks for run lists: which agent produced a run, readable at a glance.
 *
 * Harness type remains the fallback for older callers. Provider type takes precedence when supplied,
 * which distinguishes OpenRouter runs even though they deliberately reuse the AI SDK harness.
 *
 * Sized in `em` and never given vertical padding: the mark can only ever be as tall as the line box it
 * sits in, so dropping one into an existing row cannot make that row taller.
 *
 * Glyphs are the vendors' public single-colour marks (Anthropic, OpenAI, Cursor, Vercel, OpenRouter, Azure), redrawn
 * as one path each so they stay legible around 12px. They identify the provider; they are not an
 * endorsement mark, same convention as {@link ./ide-brand-icons}.
 */
interface ProviderMark {
  readonly label: string;
  readonly color: string;
  readonly viewBox: string;
  readonly path: string;
  readonly fillRule?: "evenodd";
}

const PROVIDER_MARKS: Readonly<Record<ProviderBrandKey, ProviderMark>> = {
  "claude-code": {
    label: PROVIDER_BRAND_LABELS["claude-code"],
    // Claude's coral, the one colour that reads as "Anthropic" at this size.
    color: "#D97757",
    viewBox: "0 0 16 16",
    path: "M9.218 2h2.402L16 12.987h-2.402zM4.379 2h2.512l4.38 10.987H8.82l-.895-2.308h-4.58l-.896 2.307H0L4.38 2.001zm2.755 6.64L5.635 4.777 4.137 8.64z",
    fillRule: "evenodd",
  },
  "codex-app-server": {
    label: PROVIDER_BRAND_LABELS["codex-app-server"],
    color: "#74AA9C",
    viewBox: "0 0 16 16",
    path: "M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934A4.1 4.1 0 0 0 8.423.2 4.15 4.15 0 0 0 6.305.086a4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679A4 4 0 0 0 .554 4.72a3.99 3.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.99 3.99 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.02 3.02 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z",
  },
  "cursor-acp": {
    label: PROVIDER_BRAND_LABELS["cursor-acp"],
    // The one mark with no colour of its own: Cursor's cube is off-white on dark and near-black on light,
    // so it follows the theme's text token instead of a fixed hue. A fixed off-white vanished in light mode.
    color: "var(--ec-text)",
    viewBox: "0 0 24 24",
    path: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  },
  "ai-sdk": {
    label: PROVIDER_BRAND_LABELS["ai-sdk"],
    // Vercel's triangle (the AI SDK's vendor), tinted indigo so it does not read as the Cursor cube.
    color: "#8B93F8",
    viewBox: "0 0 24 24",
    path: "m12 1.608 12 20.784H0Z",
  },
  openrouter: {
    label: PROVIDER_BRAND_LABELS.openrouter,
    // Official 2026 OpenRouter OR glyph: lime in dark mode and purple in light mode.
    color: "var(--ec-openrouter-brand)",
    viewBox: "19.82 17.199 365.556 258.298",
    path: "M303.9475 17.19926c42.79734 0 77.48933 34.69327 77.48933 77.48933s-34.69199 77.48933-77.48933 77.48933l76.86166 76.86244c9.76367 9.76313 2.84903 26.45667-10.95697 26.45667H148.96884c-71.32686 0-129.14889-57.82202-129.14889-129.14889S77.64197 17.19926 148.96884 17.19926h154.97866ZM148.96884 68.85881c-42.79607 0-77.48933 34.69327-77.48933 77.48933s34.69327 77.48933 77.48933 77.48933 77.48933-34.69327 77.48933-77.48933-34.69327-77.48933-77.48933-77.48933Z",
  },
  "azure-legacy": {
    label: PROVIDER_BRAND_LABELS["azure-legacy"],
    color: "#4FB2F5",
    viewBox: "0 0 24 24",
    path: "M13.05 2h5.2L23.7 21.2a.7.7 0 0 1-.67.9h-6.6L11.2 12.6h3.9L12.1 4.4l-2.55 7.3-4.13 6.3h4.4l-1.03 3.05a.7.7 0 0 1-.66.45H1.05a.7.7 0 0 1-.66-.93L6.9 2z",
  },
};

/**
 * A run's provider mark. Pass `className` for sizing (`size-3` / `size-3.5`) — the caller owns the size so
 * the mark can be matched to whatever line box it lands in, and so Tailwind sees the class in a scanned file.
 */
export const ProviderBrandIcon = ({
  harnessType,
  providerType,
  className,
}: {
  harnessType: HarnessType;
  providerType?: ProviderType | null;
  className?: string;
}) => {
  const brandKey: ProviderBrandKey = providerType === "openrouter" ? "openrouter" : harnessType;
  const mark = PROVIDER_MARKS[brandKey];
  if (!mark) return null;
  return (
    <svg
      className={className}
      width="1em"
      height="1em"
      viewBox={mark.viewBox}
      fill={mark.color}
      fillRule={mark.fillRule}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
    >
      <title>{mark.label}</title>
      <path d={mark.path} />
    </svg>
  );
};
