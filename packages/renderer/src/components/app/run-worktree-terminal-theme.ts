import type { Terminal } from "@xterm/xterm";

export const readTerminalTheme = (element: Element): NonNullable<Terminal["options"]["theme"]> => {
  const themeToken = (name: string, fallback: string): string => getComputedStyle(element).getPropertyValue(name).trim() || fallback;
  return {
    background: themeToken("--ec-terminal-bg", "#0d1013"),
    foreground: themeToken("--ec-terminal-fg", "#e7ebee"),
    cursor: themeToken("--ec-terminal-cursor", "#9fb1bf"),
  };
};

export const observeTerminalThemeChanges = (element: Element, terminal: Terminal): MutationObserver => {
  const observer = new MutationObserver(() => {
    terminal.options.theme = readTerminalTheme(element);
  });
  const options: MutationObserverInit = { attributes: true, attributeFilter: ["style", "data-theme", "data-design-scheme"] };
  observer.observe(document.documentElement, options);
  observer.observe(document.body, options);
  return observer;
};
