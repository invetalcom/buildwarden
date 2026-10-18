import type { HarnessRunChunk } from "@buildwarden/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResponseChunkStream } from "./response-chunk-stream";

const message = (value: string, streamId = "answer"): HarnessRunChunk => ({
  type: "message", value, metadata: { streamId, replace: true },
});

describe("response chunk delivery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces multi-image tokens before embedding and waits for the host under load", async () => {
    const images = [1, 2, 3].map((id) => `![Image ${id}](data:image/png;base64,${"A".repeat(2 * 1024 * 1024)})`).join("\n");
    const embed = vi.fn((source: string) => images + source);
    const send = vi.fn();
    const stream = createResponseChunkStream(embed, send);
    stream.post(message("First"));
    for (let token = 0; token < 1000; token++) stream.post(message(`Latest ${token}`));
    const drained = vi.fn();
    void stream.drain().then(drained);
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(drained).not.toHaveBeenCalled();
    stream.acknowledge(999); // stale/unrelated acknowledgements cannot open the gate
    expect(send).toHaveBeenCalledTimes(1);
    stream.acknowledge(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(embed).toHaveBeenLastCalledWith("Latest 999");
    expect(send.mock.calls[1][0]).toMatchObject({ value: images + "Latest 999", metadata: { responseSourceText: "Latest 999" } });
    expect(drained).not.toHaveBeenCalled();
    stream.acknowledge(2);
    await stream.drain();
    expect(drained).toHaveBeenCalledOnce();
  });

  it("paces inline images from any provider even with immediate host acknowledgements", async () => {
    const image = `![Preview](data:image/png;base64,${"A".repeat(8 * 1024 * 1024)})`;
    const send = vi.fn();
    const stream = createResponseChunkStream((text) => text, send);
    stream.post(message(image));
    stream.acknowledge(1);
    stream.post(message(image + " final"));
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(2);
    stream.acknowledge(2);
    await stream.drain();
  });

  it("keeps text streaming and flushes the final buffered value before completion", async () => {
    const send = vi.fn();
    const stream = createResponseChunkStream((text) => text, send);
    stream.post(message("Hello"));
    stream.acknowledge(1);
    stream.post(message("Hello world"));
    const completed = vi.fn();
    void stream.drain().then(completed);
    await vi.advanceTimersByTimeAsync(99);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenLastCalledWith(message("Hello world"), 2);
    expect(completed).not.toHaveBeenCalled();
    stream.acknowledge(2);
    await stream.drain();
    expect(completed).toHaveBeenCalledOnce();
  });

  it("preserves distinct responses, tool boundaries, plans, errors and image-only output", async () => {
    const send = vi.fn();
    const stream = createResponseChunkStream((text) => text, send);
    const chunks: HarnessRunChunk[] = [
      message("First", "one"), message("Second", "two"),
      { type: "tool-call", value: "Read" }, message("Third", "two"),
      { type: "plan", value: "Plan" }, { type: "error", value: "Failed" },
      { type: "message", value: "![Image](data:image/png;base64,AA==)" },
      { type: "message", value: "![Image](data:image/png;base64,BB==)" },
    ];
    for (const chunk of chunks) stream.post(chunk);
    for (let id = 1; id <= chunks.length; id++) {
      await vi.advanceTimersByTimeAsync(1000);
      stream.acknowledge(id);
    }
    await stream.drain();
    expect(send.mock.calls.map(([chunk]) => chunk)).toEqual(chunks);
  });

  it.each(["usageTotals", "providerSessionRuntime", "checkpoint"])("does not discard %s metadata", async (key) => {
    const send = vi.fn();
    const stream = createResponseChunkStream((text) => text, send);
    stream.post(message("First"));
    const state = { ...message("State"), metadata: { ...message("").metadata, [key]: {} } };
    stream.post(state);
    stream.post(message("Latest"));
    for (let id = 1; id <= 3; id++) {
      await vi.advanceTimersByTimeAsync(1000);
      stream.acknowledge(id);
    }
    await stream.drain();
    expect(send.mock.calls.map(([chunk]) => chunk.value)).toEqual(["First", "State", "Latest"]);
  });

  it("preserves additive provider deltas even when they share a stream ID", async () => {
    const send = vi.fn();
    const stream = createResponseChunkStream((text) => text, send);
    for (const value of ["Hello", " ", "world"]) {
      stream.post({ type: "message", value, metadata: { streamId: "claude-assistant" } });
    }
    for (let id = 1; id <= 3; id++) stream.acknowledge(id);
    await stream.drain();
    expect(send.mock.calls.map(([chunk]) => chunk.value).join("")).toBe("Hello world");
  });
});
