import { describe, expect, it } from "vitest";
import { isAllowedEmbeddedFrameUrl } from "./embedded-frame-navigation";

describe("embedded frame navigation", () => {
  it("lets a frame show its inline document or an empty page", () => {
    expect(isAllowedEmbeddedFrameUrl("about:srcdoc")).toBe(true);
    expect(isAllowedEmbeddedFrameUrl("about:blank")).toBe(true);
  });

  it("refuses every navigation that would reach a host or run code", () => {
    for (const url of [
      "https://collector.example/?data=secret",
      "http://127.0.0.1:47831/api/rpc",
      "file:///C:/Users/me/.ssh/id_rsa",
      "data:text/html,<p>x</p>",
      "javascript:alert(1)",
      "blob:https://example.com/0",
      "about:srcdoc?x",
      "",
    ]) {
      expect(isAllowedEmbeddedFrameUrl(url), url).toBe(false);
    }
  });
});
