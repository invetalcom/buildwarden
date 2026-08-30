/** @vitest-environment happy-dom */

import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import { observeTerminalThemeChanges } from "./run-worktree-terminal-theme";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
});

describe("RunWorktreeTerminal theme synchronization", () => {
  it("updates the active terminal when semantic theme tokens change", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    const terminal = { options: {} } as Terminal;
    const observer = observeTerminalThemeChanges(element, terminal);

    element.style.setProperty("--ec-terminal-bg", "#123456");
    element.style.setProperty("--ec-terminal-fg", "#abcdef");
    element.style.setProperty("--ec-terminal-cursor", "#fedcba");
    document.documentElement.dataset.theme = "light";
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(terminal.options.theme).toEqual({
      background: "#123456",
      foreground: "#abcdef",
      cursor: "#fedcba",
    });

    observer.disconnect();
    element.remove();
  });
});
