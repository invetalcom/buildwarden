import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectPrReviewRemoteContext } from "../pr-review/pr-review-types";
import { ForgeIssueService } from "./forge-issue-service";
import { extractSignedGithubImageUrls, githubAssetId, loadForgeIssueImage, planForgeIssueImageAttempts, sniffImageMimeType } from "./forge-issue-images";

const githubContext: ProjectPrReviewRemoteContext = {
  provider: "github",
  webBaseUrl: "https://github.com/acme/widgets",
  repoLabel: "acme/widgets",
  apiBaseUrl: "https://api.github.com",
  github: { owner: "acme", repo: "widgets" },
};

const gitlabContext: ProjectPrReviewRemoteContext = {
  provider: "gitlab",
  webBaseUrl: "https://gitlab.example.com/acme/widgets",
  repoLabel: "acme/widgets",
  apiBaseUrl: "https://gitlab.example.com/api/v4",
  gitlab: { projectPath: "acme/widgets", encodedProjectPath: "acme%2Fwidgets" },
};

const ASSET_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const ATTACHMENT_URL = `https://github.com/user-attachments/assets/${ASSET_ID}`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

type Call = { url: string; headers: Headers };
type Reply = { status?: number; body?: Uint8Array<ArrayBuffer> | string; headers?: Record<string, string> };

const stubFetch = (route: (call: Call) => Reply): Call[] => {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const call: Call = { url: String(input), headers: new Headers(init.headers) };
    calls.push(call);
    const { status = 200, body = "", headers = {} } = route(call);
    return new Response(status >= 300 && status < 400 ? null : body, { status, headers });
  });
  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("issue image helpers", () => {
  it("reads the attachment id from Markdown and signed addresses alike", () => {
    expect(githubAssetId(ATTACHMENT_URL)).toBe(ASSET_ID);
    expect(githubAssetId(`https://private-user-images.githubusercontent.com/1/2-${ASSET_ID.toUpperCase()}.png?jwt=abc`)).toBe(ASSET_ID);
    expect(githubAssetId("https://github.com/acme/widgets/raw/main/logo.png")).toBeNull();
    expect(githubAssetId("not a url")).toBeNull();
  });

  it("collects signed image addresses from rendered HTML", () => {
    const signed = `https://private-user-images.githubusercontent.com/1/2-${ASSET_ID}.png?jwt=a.b.c&amp;x=1`;
    const urls = extractSignedGithubImageUrls(
      `<p><a href="x"><img width="400" src="${signed}" alt="Shot"></a></p><img src="http://insecure.example/${ASSET_ID}.png"><img src="https://example.com/plain.png">`,
    );
    expect([...urls.entries()]).toEqual([[ASSET_ID, signed.replace("&amp;", "&")]]);
  });

  it("recognises raster images by their first bytes", () => {
    expect(sniffImageMimeType(PNG)).toBe("image/png");
    expect(sniffImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageMimeType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(sniffImageMimeType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageMimeType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageMimeType(new TextEncoder().encode("<!doctype html>"))).toBeNull();
  });

  it("sends the token to github.com only, with an anonymous retry", () => {
    expect(planForgeIssueImageAttempts(githubContext, "secret", ATTACHMENT_URL)).toEqual([
      { url: ATTACHMENT_URL, headers: { Authorization: "Bearer secret" }, authHost: "github.com" },
      { url: ATTACHMENT_URL, headers: {}, authHost: null },
    ]);
    expect(planForgeIssueImageAttempts(githubContext, "secret", "https://raw.githubusercontent.com/acme/widgets/main/a.png")).toEqual([
      { url: "https://raw.githubusercontent.com/acme/widgets/main/a.png", headers: {}, authHost: null },
    ]);
    expect(planForgeIssueImageAttempts(githubContext, null, ATTACHMENT_URL)).toEqual([{ url: ATTACHMENT_URL, headers: {}, authHost: null }]);
  });

  it("reads GitLab uploads through the API when a token is saved", () => {
    const secret = "a".repeat(32);
    const upload = `https://gitlab.example.com/acme/widgets/uploads/${secret}/shot.png`;
    expect(planForgeIssueImageAttempts(gitlabContext, "glpat", upload)).toEqual([
      { url: `https://gitlab.example.com/api/v4/projects/acme%2Fwidgets/uploads/${secret}/shot.png`, headers: { "PRIVATE-TOKEN": "glpat" }, authHost: "gitlab.example.com" },
      { url: upload, headers: {}, authHost: null },
    ]);
    expect(planForgeIssueImageAttempts(gitlabContext, null, upload)).toEqual([{ url: upload, headers: {}, authHost: null }]);
  });
});

describe("loadForgeIssueImage", () => {
  it("returns the image as a data URL and keeps the token away from the storage host", async () => {
    const storage = "https://objects.githubusercontent.com/signed/shot.png?sig=1";
    const calls = stubFetch((call): Reply => (call.url === ATTACHMENT_URL ? { status: 302, headers: { location: storage } } : { body: PNG, headers: { "content-type": "text/plain" } }));

    const dataUrl = await loadForgeIssueImage({ context: githubContext, token: "secret", url: ATTACHMENT_URL });

    expect(dataUrl).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    expect(calls.map((call) => call.url)).toEqual([ATTACHMENT_URL, storage]);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer secret");
    expect(calls[1]?.headers.get("authorization")).toBeNull();
  });

  it("falls back to the signed address of a private attachment", async () => {
    const signed = `https://private-user-images.githubusercontent.com/1/2-${ASSET_ID}.png?jwt=abc`;
    const calls = stubFetch((call) => (call.url === signed ? { body: PNG } : { status: 404 }));
    const resolveSignedUrl = vi.fn(async () => signed);

    const dataUrl = await loadForgeIssueImage({ context: githubContext, token: "secret", url: ATTACHMENT_URL, resolveSignedUrl });

    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(resolveSignedUrl).toHaveBeenCalledWith(ASSET_ID);
    expect(calls.map((call) => call.url)).toEqual([ATTACHMENT_URL, ATTACHMENT_URL, signed]);
    expect(calls[2]?.headers.get("authorization")).toBeNull();
  });

  it("reports the host's answer when nothing works", async () => {
    stubFetch(() => ({ status: 404 }));
    await expect(loadForgeIssueImage({ context: githubContext, token: null, url: ATTACHMENT_URL, resolveSignedUrl: async () => null })).rejects.toThrow("answered 404");
  });

  it("refuses images from other hosts without a request", async () => {
    const calls = stubFetch(() => ({ body: PNG }));
    await expect(loadForgeIssueImage({ context: githubContext, token: "secret", url: "https://tracker.example.com/pixel.png" })).rejects.toThrow("Git host");
    await expect(loadForgeIssueImage({ context: gitlabContext, token: "glpat", url: "https://gitlab.com/other/uploads/x.png" })).rejects.toThrow("Git host");
    expect(calls).toHaveLength(0);
  });

  it("refuses a redirect to an insecure address", async () => {
    stubFetch(() => ({ status: 302, headers: { location: "http://internal.example/shot.png" } }));
    await expect(loadForgeIssueImage({ context: githubContext, token: null, url: ATTACHMENT_URL })).rejects.toThrow("not secure");
  });

  it("refuses files that are not raster images", async () => {
    stubFetch(() => ({ body: "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", headers: { "content-type": "image/png" } }));
    await expect(loadForgeIssueImage({ context: githubContext, token: null, url: ATTACHMENT_URL })).rejects.toThrow("not a PNG");
  });

  it("looks up signed addresses once per issue for attachments of a private repository", async () => {
    const otherId = "11111111-2222-3333-4444-555555555555";
    const signed = (id: string) => `https://private-user-images.githubusercontent.com/1/2-${id}.png?jwt=abc`;
    const calls = stubFetch((call): Reply => {
      if (call.url.startsWith("https://private-user-images.githubusercontent.com/")) return { body: PNG };
      if (call.url.endsWith("/repos/acme/widgets/issues/7")) return { body: JSON.stringify({ body_html: `<p><img src="${signed(ASSET_ID)}" alt="a"></p>` }) };
      if (call.url.includes("/repos/acme/widgets/issues/7/comments")) return { body: JSON.stringify([{ body_html: `<img src="${signed(otherId)}">` }]) };
      return { status: 404 };
    });
    const service = new ForgeIssueService({
      resolveContext: async () => githubContext,
      readToken: async () => "secret",
      getRepoPath: () => "/nonexistent-repo",
      listLinks: () => [],
    });

    const first = await service.getIssueImage("project-1", { url: ATTACHMENT_URL, issueNumber: 7 });
    const second = await service.getIssueImage("project-1", { url: `https://github.com/user-attachments/assets/${otherId}`, issueNumber: 7 });

    expect(first.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(second.dataUrl).toBe(first.dataUrl);
    const apiCalls = calls.filter((call) => call.url.startsWith("https://api.github.com/"));
    expect(apiCalls.map((call) => call.headers.get("accept"))).toEqual(["application/vnd.github.full+json", "application/vnd.github.full+json"]);
    // The token goes to the API and github.com, never to the host that serves the signed image.
    expect(calls.filter((call) => call.url.includes("githubusercontent.com")).every((call) => !call.headers.has("authorization"))).toBe(true);
  });

  it("refuses images that are too large", async () => {
    stubFetch(() => ({ body: PNG, headers: { "content-length": String(6 * 1024 * 1024) } }));
    await expect(loadForgeIssueImage({ context: githubContext, token: null, url: ATTACHMENT_URL })).rejects.toThrow("too large");
  });
});
