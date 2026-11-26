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
    expect(options.publishWarning).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: "Unexpected error", message: "lost promise" }));
    expect(options.publishWarning).toHaveBeenNthCalledWith(2, { title: "Unexpected error", message: "plain reason" });
    expect(options.showFatalError).not.toHaveBeenCalled();
    expect(options.quit).not.toHaveBeenCalled();
  });
});
