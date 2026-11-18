import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminateAgentProcesses } from "@buildwarden/agent-runtime";
import { afterEach, describe, expect, it } from "vitest";

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});

describe.runIf(process.platform === "win32" || process.platform === "linux")("terminateAgentProcesses on the real operating system", () => {
  it("ends the launcher and the agent but leaves a server the agent started running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bw-agent-shutdown-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const pidFile = join(dir, "server.pid");
    // The "agent" (started through a launcher shell, like an npm shim) starts a long-lived server the
    // way agents start background terminals: detached. On Windows, Node puts non-detached children in
    // a kill-on-close job, so they would die with the agent whatever BuildWarden does.
    // No ">" or "&": cmd.exe would treat them as redirections even inside the quoted script.
    const agentScript = `const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(function(){},1000)"],{stdio:"ignore",detached:true});require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(function(){},1000);`;
    const launcher = spawn(`"${process.execPath}" -e ${JSON.stringify(agentScript)}`, { shell: true, stdio: "ignore", windowsHide: true });
    await new Promise<void>((resolve, reject) => { launcher.once("spawn", () => resolve()); launcher.once("error", reject); });

    const deadline = Date.now() + 15_000;
    let serverPid = 0;
    while (!serverPid && Date.now() < deadline) {
      try { serverPid = Number(readFileSync(pidFile, "utf8")); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    expect(serverPid).toBeGreaterThan(0);
    cleanup.push(() => { try { process.kill(serverPid); } catch { /* gone */ } });

    await expect(terminateAgentProcesses(launcher.pid!)).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(isAlive(launcher.pid!)).toBe(false);
    expect(isAlive(serverPid)).toBe(true);
  }, 60_000);
});
