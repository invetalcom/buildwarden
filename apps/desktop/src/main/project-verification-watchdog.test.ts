import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProjectVerificationCommand, runProjectVerificationCommands } from "./project-verification";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const processDouble = () => Object.assign(new EventEmitter(), {
  pid: 54321,
  exitCode: null as number | null,
  signalCode: null as NodeJS.Signals | null,
  stdout: new PassThrough(),
  stderr: new PassThrough(),
  kill: vi.fn(() => true),
  unref: vi.fn(),
});

let child: ReturnType<typeof processDouble>;
let killer: ReturnType<typeof processDouble>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, "kill").mockReturnValue(true);
  child = processDouble(); killer = processDouble();
  vi.mocked(spawn).mockImplementation((command) => (command === "taskkill" ? killer : child) as unknown as ReturnType<typeof spawn>);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(spawn).mockReset(); });

describe("verification completion watchdog", () => {
  it("bounds a watch-mode command even when termination never produces close", async () => {
    const pending = runProjectVerificationCommands("workspace", ["tests --watch", "must-not-run"], 100);
    child.stdout.write("TOTAL: 1 FAILED, 2 SUCCESS\n");
    await vi.advanceTimersByTimeAsync(2_100);
    const results = await pending;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, timedOut: true, exitCode: null, durationMs: 2_100 });
    expect(results[0].output).toContain("disable watch/interactive mode");
    expect(results[0].output).toContain("shutdown could not be confirmed");
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.unref).toHaveBeenCalled();
    expect(vi.mocked(spawn).mock.calls.some(([command]) => command === "must-not-run")).toBe(false);
  });

  it("bounds cancellation when a command ignores termination", async () => {
    const abort = new AbortController();
    const pending = runProjectVerificationCommand("workspace", "tests", 300_000, abort.signal);
    abort.abort();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({ ok: false, timedOut: false, durationMs: 2_000, output: expect.stringContaining("Verification cancelled") });
  });

  it("fails promptly if an exited shell leaves descendants holding its output open", async () => {
    const pending = runProjectVerificationCommand("workspace", "tests");
    child.exitCode = 0;
    child.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await pending).toMatchObject({ ok: false, timedOut: false, output: expect.stringContaining("output streams stayed open") });
    if (process.platform === "win32") expect(vi.mocked(spawn).mock.calls.some(([command]) => command === "taskkill")).toBe(false);
  });

  it("settles after spawn errors without depending on close", async () => {
    const pending = runProjectVerificationCommand("workspace", "tests");
    child.emit("error", new Error("Cannot spawn"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({ ok: false, output: expect.stringContaining("Cannot spawn") });
  });

  it.skipIf(process.platform !== "win32")("handles a failing taskkill helper without crashing or hanging", async () => {
    const pending = runProjectVerificationCommand("workspace", "tests", 100);
    await vi.advanceTimersByTimeAsync(100);
    killer.emit("error", new Error("taskkill unavailable"));
    expect(child.kill).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({ ok: false, timedOut: true });
  });

  it("sets CI mode and preserves normal exit-code based results", async () => {
    const pending = runProjectVerificationCommand("workspace", "tests", 100);
    expect(vi.mocked(spawn).mock.calls[0][1]).toMatchObject({ env: expect.objectContaining({ CI: "true" }), stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.write("Tests passed");
    child.emit("close", 0);
    expect(await pending).toMatchObject({ ok: true, timedOut: false, exitCode: 0, output: "Tests passed" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
