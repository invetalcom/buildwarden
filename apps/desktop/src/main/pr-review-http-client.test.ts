import { afterEach, describe, expect, it, vi } from "vitest";
import { PrReviewHttpClient, PrReviewHttpError } from "./pr-review/pr-review-http-client";
import type { ProjectPrReviewRemoteContext } from "./pr-review/pr-review-types";

const context: ProjectPrReviewRemoteContext = {
  provider: "github",
  webBaseUrl: "https://github.com/acme/repo",
  repoLabel: "acme/repo",
  apiBaseUrl: "https://api.github.test",
  github: { owner: "acme", repo: "repo" },
};

afterEach(() => vi.unstubAllGlobals());

describe("PrReviewHttpClient", () => {
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
