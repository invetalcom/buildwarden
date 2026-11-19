import { spawn } from "node:child_process";
import type { OwnedProcessesSnapshot } from "@buildwarden/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnedProcessRegistry, type OwnedProcessRegistry } from "./index";

const supported = process.platform === "win32" || process.platform === "linux" || process.platform === "darwin";
const OWNER = { kind: "run" as const, id: "integration-run" };

let registry: OwnedProcessRegistry | null = null;
const spawned: number[] = [];

afterEach(() => {
  registry?.dispose();
  registry = null;
  for (const pid of spawned.splice(0)) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
});

const waitFor = async (condition: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the process table.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

describe.runIf(supported)("owned processes on the real operating system", () => {
  it("tracks a grandchild through the real process table and stops it", async () => {
    let latest: OwnedProcessesSnapshot | null = null;
    registry = createOwnedProcessRegistry({ onChange: (snapshot) => { latest = snapshot; } });
    // A parent that starts a long-lived grandchild, like a shell starting a dev server.
    const grandchildScript = "setInterval(() => {}, 1000)";
    const parent = spawn(process.execPath, ["-e", `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { parent.once("spawn", () => resolve()); parent.once("error", reject); });
    spawned.push(parent.pid!);
    registry.registerSpawn(OWNER, { pid: parent.pid!, role: "command", spawnedAtMs: Date.now(), commandLine: "node -e" }, process.cwd());

    await waitFor(() => (latest?.processes.length ?? 0) >= 2, 20_000);
    const processes = registry.getSnapshot(OWNER).processes;
    const root = processes.find((entry) => entry.pid === parent.pid)!;
    const grandchild = processes.find((entry) => entry.parentProcessId === root.processId)!;
    expect(root).toMatchObject({ role: "command", status: "running" });
    expect(grandchild).toMatchObject({ role: "command", status: "running" });
    expect(grandchild.commandLine ?? "").toContain("setInterval");
    spawned.push(grandchild.pid);

    await registry.manage({ owner: OWNER, action: "kill", processId: root.processId });
    const after = registry.getSnapshot(OWNER).processes;
    expect(after.find((entry) => entry.processId === root.processId)).toMatchObject({ status: "exited", endReason: "killed" });
    expect(after.find((entry) => entry.processId === grandchild.processId)).toMatchObject({ status: "exited", endReason: "killed" });
  }, 60_000);
});
