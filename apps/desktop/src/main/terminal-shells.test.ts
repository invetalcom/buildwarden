import { describe, expect, it } from "vitest";
import { hostDefaultTerminalShell, isMissingShell, terminalShellCandidates } from "./terminal-shells";

describe("terminal shell selection", () => {
  it("honors ComSpec and falls back to auto for a preference from another OS", () => {
    expect(terminalShellCandidates("auto", "win32", { ComSpec: "D:\\custom\\cmd.exe" })[0]).toEqual({ file: "D:\\custom\\cmd.exe", args: ["/k"] });
    expect(hostDefaultTerminalShell("pwsh", "linux")).toBe("auto");
    expect(hostDefaultTerminalShell("zsh", "win32")).toBe("auto");
    expect(hostDefaultTerminalShell("zsh", "darwin")).toBe("zsh");
  });
  it("uses the system command interpreter before Windows fallbacks", () => {
    expect(terminalShellCandidates("auto", "win32", { SystemRoot: "D:\\Windows" }).map((item) => item.file)).toEqual([
      "D:\\Windows\\System32\\cmd.exe", "pwsh.exe", "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ]);
  });
  it("never silently falls back for an explicit profile", () => {
    expect(terminalShellCandidates("pwsh", "win32", {})).toEqual([{ file: "pwsh.exe", args: ["-NoLogo"] }]);
    expect(() => terminalShellCandidates("cmd", "linux", {})).toThrow();
    expect(isMissingShell(new Error("spawn ENOENT"))).toBe(true);
    expect(isMissingShell(new Error("EACCES permission denied"))).toBe(false);
  });
  it("uses the configured Unix shell before portable fallbacks", () => {
    expect(terminalShellCandidates("auto", "linux", { SHELL: "/custom/fish" }).map((item) => item.file))
      .toEqual(["/custom/fish", "/bin/bash", "/bin/zsh", "/bin/sh"]);
  });
});
