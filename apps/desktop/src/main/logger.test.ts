import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const brokenPipe = () => Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" });

describe("logger console output", () => {
  let logDir: string;

  beforeEach(() => {
    vi.resetModules();
    logDir = mkdtempSync(join(tmpdir(), "bw-logger-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(logDir, { recursive: true, force: true });
  });

  it("keeps writing the file and stops using the console after a broken pipe", async () => {
    const logger = await import("./logger");
    logger.watchConsoleStreams([new EventEmitter()]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      throw brokenPipe();
    });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    logger.initializeAppLogger(logDir);

    expect(() => logger.logError("first")).not.toThrow();
    expect(() => logger.logError("second")).not.toThrow();

    expect(consoleError).toHaveBeenCalledTimes(1);
    const lines = readFileSync(join(logDir, "main.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { message: string });
    expect(lines.map((line) => line.message)).toEqual(["Application logger initialized.", "first", "second"]);
  });

  it("stops using the console when a console stream reports an error", async () => {
    const logger = await import("./logger");
    const stream = new EventEmitter();
    logger.watchConsoleStreams([stream]);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logger.logWarn("before");
    // With a listener in place the error event no longer surfaces as an uncaught exception.
    expect(() => stream.emit("error", brokenPipe())).not.toThrow();
    logger.logWarn("after");

    expect(consoleWarn).toHaveBeenCalledTimes(1);
  });

  it("recognizes broken console streams", async () => {
    const { isBrokenPipeError } = await import("./logger");
    expect(isBrokenPipeError(brokenPipe())).toBe(true);
    expect(isBrokenPipeError(Object.assign(new Error("gone"), { code: "ERR_STREAM_DESTROYED" }))).toBe(true);
    expect(isBrokenPipeError(new Error("other"))).toBe(false);
    expect(isBrokenPipeError(null)).toBe(false);
    // An invalid descriptor elsewhere, such as a file read, is a real error.
    expect(isBrokenPipeError(Object.assign(new Error("bad descriptor"), { code: "EBADF" }))).toBe(false);
  });

  it("stops using a console without a valid descriptor", async () => {
    const logger = await import("./logger");
    logger.watchConsoleStreams([new EventEmitter()]);
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {
      throw Object.assign(new Error("EBADF: bad file descriptor, write"), { code: "EBADF" });
    });

    expect(() => logger.logInfo("first")).not.toThrow();
    expect(() => logger.logInfo("second")).not.toThrow();
    expect(consoleInfo).toHaveBeenCalledTimes(1);
  });
});
