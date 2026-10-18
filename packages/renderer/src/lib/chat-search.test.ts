import { expect, it } from "vitest";
import type { ChatSearchDetail } from "@buildwarden/shared";
import { chatDetailMatchesSearch } from "./chat-search";

it("searches descriptions, not embedded image payloads, including older host responses", () => {
  const detail = { chat: { prompt: "Ideas" }, steps: [{ title: "Answer", eventType: "output", content: "Caption ![Preview](data:image/png;base64,c2VjcmV0)", metadataJson: JSON.stringify({ responseSourceText: "Useful explanation ![Preview](image.png)" }) }] } as unknown as ChatSearchDetail;
  expect(chatDetailMatchesSearch(detail, "explanation")).toBe(true);
  expect(chatDetailMatchesSearch(detail, "c2vj")).toBe(false);
  expect(chatDetailMatchesSearch({ ...detail, steps: [{ title: "Legacy", eventType: "output", content: "Caption ![Preview](data:image/png;base64,c2VjcmV0)" }] }, "c2vj")).toBe(false);
});
