import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProjectVerificationCommands } from "./project-verification";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("project verification", () => {
  it("runs commands in order and stops at the first failure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "buildwarden-verification-"));
    tempDirs.push(cwd);
    const results = await runProjectVerificationCommands(cwd, [
      'node -e "process.stdout.write(\'passed\')"',
      'node -e "process.stderr.write(\'failed\'); process.exit(3)"',
      'node -e "process.stdout.write(\'should-not-run\')"',
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: true, exitCode: 0, output: "passed" });
    expect(results[1]).toMatchObject({ ok: false, exitCode: 3, output: "failed" });
  });

  it("marks a command that exceeds its deadline as timed out", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "buildwarden-verification-"));
    tempDirs.push(cwd);
    const [result] = await runProjectVerificationCommands(
      cwd,
      ['node -e "setTimeout(() => {}, 1000)"'],
      25,
    );

    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(result?.output).toContain("Timed out");
  });

  it("stops a real watch-mode runner that reports failure but stays alive", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "buildwarden-verification-"));
    tempDirs.push(cwd);
    const results = await runProjectVerificationCommands(cwd, [
      'node -e "console.log(\'TOTAL: 1 FAILED, 2 SUCCESS\'); setInterval(() => {}, 1000)"',
      'node -e "console.log(\'should-not-run\')"',
    ], 1_000);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, timedOut: true });
    expect(results[0].output).toContain("TOTAL: 1 FAILED, 2 SUCCESS");
    expect(results[0].durationMs).toBeLessThan(4_000);
  });

  it.skipIf(process.platform === "win32")("force-stops a command that ignores SIGTERM", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "buildwarden-verification-"));
    tempDirs.push(cwd);

    const [result] = await runProjectVerificationCommands(
      cwd,
      ["sh -c \"trap '' TERM; while :; do sleep 1; done\""],
      25,
    );

    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(result?.durationMs).toBeLessThan(2_000);
  });
});
