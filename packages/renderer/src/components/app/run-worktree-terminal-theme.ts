import type { Terminal } from "@xterm/xterm";

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
const DEFAULT_FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace";
const DEFAULT_FONT_SIZE = 12;

type TerminalTheme = NonNullable<Terminal["options"]["theme"]>;

export const readTerminalTheme = (element: Element): TerminalTheme => {
  const style = getComputedStyle(element);
  const themeToken = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  const theme: TerminalTheme = {
    background: themeToken("--ec-terminal-bg", "#0d1013"),
    foreground: themeToken("--ec-terminal-fg", "#e7ebee"),
    cursor: themeToken("--ec-terminal-cursor", "#9fb1bf"),
  };
  // The 16 ANSI colors stay the terminal's own unless the theme names one.
  for (const name of ANSI_NAMES) {
    const normal = style.getPropertyValue(`--bw-term-${name}`).trim();
    const bright = style.getPropertyValue(`--bw-term-bright-${name}`).trim();
    if (normal) theme[name] = normal;
    if (bright) theme[`bright${name[0]!.toUpperCase()}${name.slice(1)}` as `bright${Capitalize<typeof name>}`] = bright;
  }
  return theme;
};

/** Font of the terminal: the theme's code font and terminal text size when set, the built-in ones otherwise. */
export const readTerminalFont = (element: Element): { fontFamily: string; fontSize: number } => {
  const style = getComputedStyle(element);
  const size = Number(style.getPropertyValue("--bw-terminal-font-size").trim());
  return {
    fontFamily: style.getPropertyValue("--bw-font-mono").trim() || DEFAULT_FONT_FAMILY,
    fontSize: Number.isFinite(size) && size > 0 ? size : DEFAULT_FONT_SIZE,
  };
};

export const observeTerminalThemeChanges = (element: Element, terminal: Terminal, onFontChange?: () => void): MutationObserver => {
  const observer = new MutationObserver(() => {
    terminal.options.theme = readTerminalTheme(element);
    const font = readTerminalFont(element);
    if (terminal.options.fontFamily !== font.fontFamily || terminal.options.fontSize !== font.fontSize) {
      terminal.options.fontFamily = font.fontFamily;
      terminal.options.fontSize = font.fontSize;
      onFontChange?.();
    }
  });
  const options: MutationObserverInit = { attributes: true, attributeFilter: ["style", "data-theme", "data-design-scheme", "data-design-revision"] };
  observer.observe(document.documentElement, options);
  observer.observe(document.body, options);
  return observer;
};
