/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DESIGN_CSS_HOOKS } from "@buildwarden/shared";
import { Button } from "./button";
import { SegmentedControl } from "./segmented-control";
import { Switch } from "./switch";
import { TabList, TabPanel } from "./tabs";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

/**
 * Hooks that need more than `data-ui`, such as a variant or a state. The source check in
 * `design-theme.test.ts` only sees the `data-ui` value, so a control could lose the second
 * attribute unnoticed. These are matched against what the shared controls really render.
 */
const SELECTORS_OF_SHARED_CONTROLS = [
  '[data-ui="button"][data-variant="default"]',
  '[data-ui="button"][data-variant="danger"]',
  '[data-ui="button"][data-variant="ghost"]',
  '[data-ui="button"]:not([data-variant="default"]):not([data-variant="danger"]):not([data-variant="ghost"])',
  '[data-ui="switch"][aria-checked="false"]',
  '[data-ui="switch"][aria-checked="true"]',
  '[data-ui="segmented"] > [aria-pressed="true"]',
  '[data-ui="tab"][data-active="true"], [data-ui="tab-panel"]',
];

describe("theme hooks of the shared controls", () => {
  it("lists these selectors as public hooks", () => {
    const published = DESIGN_CSS_HOOKS.map((hook) => hook.selector);
    for (const selector of SELECTORS_OF_SHARED_CONTROLS) expect(published).toContain(selector);
  });

  it.each(SELECTORS_OF_SHARED_CONTROLS)("renders an element that matches %s", async (selector) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <>
        <Button>Save</Button>
        <Button variant="danger">Delete</Button>
        <Button variant="ghost">More</Button>
        <Button variant="secondary">Cancel</Button>
        <Switch aria-label="Off" checked={false} />
        <Switch aria-label="On" checked />
        <SegmentedControl label="Mode" value="dark" onChange={() => undefined} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />
        <TabList label="Views" value="one" onChange={() => undefined} items={[{ value: "one", label: "One" }, { value: "two", label: "Two" }]} />
        <TabPanel>Content</TabPanel>
      </>,
    ));
    // A selector list matches as soon as one of its parts does, so every part is checked on its own.
    // None of these selectors has a comma inside brackets or parentheses.
    for (const part of selector.split(",")) expect(container.querySelector(part.trim()), part.trim()).not.toBeNull();
  });
});
