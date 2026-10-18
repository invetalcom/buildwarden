/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { ChatTranscript } from "./ChatTranscript";

let root: Root;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { if (root) await act(() => root.unmount()); container?.remove(); });
const render = async (active: boolean, readOnly = false, requestStatus = "opened") => {
  const reply = vi.fn(async () => {});
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const client = createElectronBuildWardenClient({ respondToChatUserInput: reply } as unknown as DesktopApi);
  const metadata = { requestStatus, userInputRequestId: "request-1", userInputQuestions: [
    { id: "experience", header: "Experience", question: "Experience?", options: [{ label: "Beginner" }, { label: "Advanced" }] },
    { id: "interests", header: "Interests", question: "Interests?", multiSelect: true, options: [{ label: "AI" }, { label: "Web" }] },
  ] };
  await act(() => root.render(<BuildWardenClientProvider client={client}><ChatTranscript chatId="chat-1" active={active} readOnly={readOnly}
    emptyMessage="Empty" items={[{ id: "step-1", eventType: "user-input-requested", title: "Question", content: "",
      metadataJson: JSON.stringify(metadata), createdAt: "2026-10-18T09:00:00Z" }]} /></BuildWardenClientProvider>));
  return reply;
};
const button = (label: string) => {
  const result = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  if (!result) throw Error(`Missing button: ${label}`);
  return result;
};
describe("chat questions", () => {
  it("requires all answers and submits single and multiple selections through the chat bridge", async () => {
    const reply = await render(true);
    expect(button("Submit answer").disabled).toBe(true);
    await act(() => button("Advanced").click());
    expect(button("Submit answer").disabled).toBe(true);
    await act(() => { button("AI").click(); button("Web").click(); });
    expect(button("Web").getAttribute("aria-pressed")).toBe("true");
    await act(() => button("Submit answer").click());
    expect(reply).toHaveBeenCalledWith("chat-1", "request-1", { experience: "Advanced", interests: ["AI", "Web"] });
  });
  it.each([[false, false, "opened"], [true, true, "opened"], [true, false, "cancelled"]] as const)(
    "disables inactive, read-only and expired questions (%s, %s, %s)", async (active, readOnly, status) => {
      const reply = await render(active, readOnly, status);
      expect(button("Advanced").disabled).toBe(true);
      await act(() => button("Advanced").click());
      expect(reply).not.toHaveBeenCalled();
    });
});
