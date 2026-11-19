import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import type { OwnedProcessesSnapshot } from "@buildwarden/shared";
import { isLinuxLaunchProgram } from "./launch-program";
import { OwnedProcessRegistry } from "./owned-process-registry";
import { createPlatformProcessTableReader } from "./process-table";
import { createPlatformProcessTerminator } from "./process-terminator";

export { OwnedProcessRegistry, type OwnedProcessSpawnReport } from "./owned-process-registry";

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["win32", "linux", "darwin"]);

export const createOwnedProcessRegistry = (options: {
  onChange: (snapshot: OwnedProcessesSnapshot) => void;
  log?: (message: string, error: unknown) => void;
  platform?: NodeJS.Platform;
}): OwnedProcessRegistry => {
  const platform = options.platform ?? process.platform;
  return new OwnedProcessRegistry({
    createReader: () => createPlatformProcessTableReader(platform),
    supported: SUPPORTED_PLATFORMS.has(platform),
    terminator: createPlatformProcessTerminator(platform),
    platform,
    cpuCount: availableParallelism(),
    onChange: options.onChange,
    log: options.log,
    isLaunchProgram: platform === "linux" ? isLinuxLaunchProgram : undefined,
    // Windows keeps the exact command line, so cmd.exe can run it again verbatim. Linux restarts
    // from the exact argv read from /proc. macOS only reveals a space-joined command line.
    spawnCommand: platform === "win32"
      ? ({ commandLine, cwd }) => spawn(commandLine, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: process.env })
      : platform === "linux"
        ? ({ argv, commandLine, cwd }) => {
          const [file, ...args] = argv?.length ? argv : [commandLine];
          return spawn(file!, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
        }
        : undefined,
  });
};
