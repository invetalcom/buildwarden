import { afterEach, describe, expect, it, vi } from "vitest";
import { PrReviewHttpClient, PrReviewHttpError, PrReviewRequestTimeoutError } from "./pr-review/pr-review-http-client";
import type { ProjectPrReviewRemoteContext } from "./pr-review/pr-review-types";

const context: ProjectPrReviewRemoteContext = {
  provider: "github",
  webBaseUrl: "https://github.com/acme/repo",
  repoLabel: "acme/repo",
  apiBaseUrl: "https://api.github.test",
  github: { owner: "acme", repo: "repo" },
};

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("PrReviewHttpClient", () => {
  it.each(["json", "jsonWithHeaders", "text"] as const)("bounds stalled %s requests and aborts the transport without retrying mutations", async (method) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_url, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetch);
    const client = new PrReviewHttpClient(context, "secret-token");
    const result = expect(client[method]("/reviews", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(PrReviewRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { method: "json" as const, status: 200 },
    { method: "text" as const, status: 200 },
    { method: "jsonWithHeaders" as const, status: 429 },
    { method: "text" as const, status: 403 },
  ])("includes the $status body in the same $method deadline", async ({ method, status }) => {
    vi.useFakeTimers();
    let respond!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>((resolve) => { respond = resolve; });
    }));
    const client = new PrReviewHttpClient(context, "secret-token");
    const result = expect(client[method]("/slow-body")).rejects.toThrow("timed out after 30 seconds");
    await vi.advanceTimersByTimeAsync(29_000);
    const response = new Response("", { status });
    vi.spyOn(response, "text").mockImplementation(() => new Promise(() => {}));
    respond(response);
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
    expect(response.text).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not issue a request when the caller has already cancelled it", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const caller = new AbortController();
    const reason = new Error("Review closed");
    caller.abort(reason);
    await expect(new PrReviewHttpClient(context, "token").json("/review", { signal: caller.signal })).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates caller cancellation while consuming the body", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const removeListener = vi.spyOn(caller.signal, "removeEventListener");
    const response = new Response("");
    vi.spyOn(response, "text").mockImplementation(() => new Promise(() => {}));
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => { signal = init.signal ?? undefined; return response; }));
    const reason = new Error("Navigated away");
    const result = expect(new PrReviewHttpClient(context, "token").text("/diff", { signal: caller.signal })).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(response.text).toHaveBeenCalledOnce();
    caller.abort(reason);
    await result;
    expect(signal?.aborted).toBe(true);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears deadlines and caller listeners after success", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const removeListener = vi.spyOn(caller.signal, "removeEventListener");
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => { signal = init.signal ?? undefined; return new Response('{"ok":true}'); }));
    await expect(new PrReviewHttpClient(context, "token").json("/review", { signal: caller.signal })).resolves.toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    caller.abort();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal?.aborted).toBe(false);
  });

  it("exposes Retry-After to the adaptive forge scheduler", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ message: "Secondary rate limit" }),
      { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "120" } },
    )));
    const client = new PrReviewHttpClient(context, "secret-token");

    const error = await client.json("/rate-limited").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PrReviewHttpError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 120_000 });
    expect(String(error)).toContain("GitHub API 429");
  });

  it("ignores rate-limit reset headers on ordinary API failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ message: "Not found" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "X-RateLimit-Remaining": "4999",
          "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1000) + 3_600),
        },
      },
    )));
    const client = new PrReviewHttpClient(context, "secret-token");

    const error = await client.json("/missing").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 404, retryAfterMs: null });
  });

  it("returns a cache hit for an authorized conditional 304", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 304,
      headers: { ETag: '"same-version"' },
    })));
    const client = new PrReviewHttpClient(context, "secret-token");

    const result = await client.jsonWithHeaders("/unchanged", {
      headers: { "If-None-Match": '"same-version"' },
    });

    expect(result).toMatchObject({ payload: null, notModified: true });
    expect(result.headers.get("etag")).toBe('"same-version"');
  });
});
