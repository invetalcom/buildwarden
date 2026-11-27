import { describe, expect, it, vi } from "vitest";
import { createMainProcessErrorHandlers } from "./main-process-errors";

const setup = () => {
  const options = {
    logError: vi.fn(),
    publishWarning: vi.fn(),
    showFatalError: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
  };
  return { options, handlers: createMainProcessErrorHandlers(options) };
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("main process error handlers", () => {
  it("keeps running after a broken pipe", async () => {
    const { options, handlers } = setup();
    handlers.onUncaughtException(Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" }));
    await flush();
    expect(options.logError).toHaveBeenCalledTimes(1);
    expect(options.showFatalError).not.toHaveBeenCalled();
    expect(options.quit).not.toHaveBeenCalled();
  });

  it("still treats an invalid descriptor outside the console as fatal", async () => {
    const { options, handlers } = setup();
    handlers.onUncaughtException(Object.assign(new Error("EBADF: bad file descriptor, read"), { code: "EBADF" }));
    await flush();
    expect(options.showFatalError).toHaveBeenCalledTimes(1);
    expect(options.quit).toHaveBeenCalledTimes(1);
  });

  it("reports an uncaught exception once and quits once", async () => {
    const { options, handlers } = setup();
    handlers.onUncaughtException(new Error("first"));
    handlers.onUncaughtException(new Error("second"));
    await flush();
    expect(options.logError).toHaveBeenCalledTimes(2);
    expect(options.showFatalError).toHaveBeenCalledTimes(1);
    expect(options.showFatalError).toHaveBeenCalledWith("Uncaught Exception", "first", expect.any(String));
    expect(options.quit).toHaveBeenCalledTimes(1);
  });

  it("quits even when the dialog cannot be shown", async () => {
    const { options, handlers } = setup();
    options.showFatalError.mockImplementation(() => Promise.reject(new Error("no display")));
    handlers.onUncaughtException(new Error("boom"));
    await flush();
    expect(options.quit).toHaveBeenCalledTimes(1);
  });

  it("shows an unhandled rejection as a warning without quitting", async () => {
    const { options, handlers } = setup();
    handlers.onUnhandledRejection(new Error("lost promise"));
    handlers.onUnhandledRejection("plain reason");
    await flush();
    expect(options.publishWarning).toHaveBeenNthCalledWith(1, {
      title: "Unexpected error",
      message: "A background task failed (Error). BuildWarden kept running; the log has the details.",
    });
    expect(options.publishWarning).toHaveBeenNthCalledWith(2, {
      title: "Unexpected error",
      message: "A background task failed (Unknown rejection reason). BuildWarden kept running; the log has the details.",
    });
    expect(options.logError).toHaveBeenCalledWith("Unhandled rejection in main process.", { reason: expect.objectContaining({ message: "lost promise" }) });
    expect(options.showFatalError).not.toHaveBeenCalled();
    expect(options.quit).not.toHaveBeenCalled();
  });

  it("keeps the host error's message and stack out of the warning clients receive", async () => {
    const { options, handlers } = setup();
    const error = new TypeError("fetch failed for https://internal.example/secret?token=abc");
    handlers.onUnhandledRejection(error);
    await flush();
    const [warning] = options.publishWarning.mock.calls.at(-1) as unknown as [{ message: string; detail?: string }];
    expect(warning.message).toContain("TypeError");
    expect(warning.message).not.toContain("internal.example");
    expect(warning.detail).toBeUndefined();
  });

  it("warns about a rejection reason that has no string form", async () => {
    const { options, handlers } = setup();
    const reason: unknown = Object.create(null);
    expect(() => String(reason)).toThrow(TypeError);

    expect(() => handlers.onUnhandledRejection(reason)).not.toThrow();
    await flush();
    expect(options.publishWarning).toHaveBeenCalledWith({
      title: "Unexpected error",
      message: "A background task failed (Unknown rejection reason). BuildWarden kept running; the log has the details.",
    });
    expect(options.quit).not.toHaveBeenCalled();
  });
});
