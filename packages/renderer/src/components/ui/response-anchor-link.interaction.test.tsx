/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopApi } from "@buildwarden/shared";
import { ActivityRichText } from "./activity-rich-text";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const renderResponses = async (contents: string[], openExternalUrl = vi.fn()) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = createElectronBuildWardenClient({ openExternalUrl } as unknown as DesktopApi);
  await act(async () => root.render(
    <BuildWardenClientProvider client={client}>
      {contents.map((content, index) => <ActivityRichText key={index} content={content} />)}
    </BuildWardenClientProvider>,
  ));
  return { container, root, openExternalUrl };
};

const scrolled: Element[] = [];
HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) { scrolled.push(this); };

afterEach(() => {
  scrolled.length = 0;
  document.body.innerHTML = "";
});

it("moves between a footnote reference and its note within the same response", async () => {
  // Both responses use the id `fn-1`; each reference must reach its own note.
  const { container, root, openExternalUrl } = await renderResponses(["First.[^1]\n\n[^1]: First note.", "Second.[^1]\n\n[^1]: Second note."]);
  try {
    const responses = container.querySelectorAll(".response-markdown");
    const reference = responses[1].querySelector<HTMLAnchorElement>("a[data-footnote-ref]")!;
    expect(reference.getAttribute("target")).toBeNull();
    await act(async () => reference.click());
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0].textContent).toContain("Second note.");
    expect(responses[1].contains(scrolled[0])).toBe(true);
    // Keyboard navigation continues from the note, which becomes focusable only programmatically.
    expect(document.activeElement).toBe(scrolled[0]);
    expect(scrolled[0].getAttribute("tabindex")).toBe("-1");

    await act(async () => responses[1].querySelector<HTMLAnchorElement>("a[data-footnote-backref]")!.click());
    expect(scrolled[1]).toBe(reference);
    expect(document.activeElement).toBe(reference);
    expect(reference.hasAttribute("tabindex")).toBe(false);
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
  } finally {
    await act(async () => root.unmount());
  }
});

it("links to a heading of the same response, including headings with punctuation", async () => {
  const { container, root, openExternalUrl } = await renderResponses([
    "## Setup\n\nOther response.",
    "Contents: [Setup](#setup), [Risks & limits](#risks--limits)\n\n## Setup\n\nText.\n\n## Risks & limits\n\nMore.",
  ]);
  try {
    const response = container.querySelectorAll(".response-markdown")[1];
    const [setupLink, risksLink] = Array.from(response.querySelectorAll<HTMLAnchorElement>("p a"));
    await act(async () => setupLink.click());
    await act(async () => risksLink.click());
    expect(scrolled.map((element) => element.textContent)).toEqual(["Setup", "Risks & limits"]);
    expect(scrolled.every((element) => response.contains(element))).toBe(true);
    expect(openExternalUrl).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
