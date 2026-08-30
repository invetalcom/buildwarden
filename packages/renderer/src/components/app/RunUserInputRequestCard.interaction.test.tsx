/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DesktopApi, RunUserInputQuestion } from "@buildwarden/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { RunUserInputRequestCard } from "./RunUserInputRequestCard";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const question: RunUserInputQuestion = {
  id: "details",
  header: "Details",
  question: "What should change?",
  options: [],
  allowCustomAnswer: true,
};

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const renderCard = async (props: { disabled?: boolean; onSubmitAnswers?: () => Promise<void> }) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = createElectronBuildWardenClient({} as DesktopApi);
  await act(async () => root?.render(
    <BuildWardenClientProvider client={client}>
      <RunUserInputRequestCard
        runId="run-1"
        requestId="request-1"
        title="Question"
        content=""
        timestamp="now"
        questions={[question]}
        resolved={false}
        disabled={props.disabled}
        onSubmitAnswers={props.onSubmitAnswers}
      />
    </BuildWardenClientProvider>,
  ));
};

const enterAnswer = async (textarea: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  await act(async () => textarea.dispatchEvent(new Event("input", { bubbles: true })));
};

describe("RunUserInputRequestCard", () => {
  it("disables custom answers when the request is disabled", async () => {
    await renderCard({ disabled: true });
    expect(container?.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
  });

  it("disables custom answers while the request is submitting", async () => {
    let finishSubmission: (() => void) | undefined;
    const submission = new Promise<void>((resolve) => {
      finishSubmission = resolve;
    });
    await renderCard({ onSubmitAnswers: () => submission });
    const textarea = container?.querySelector<HTMLTextAreaElement>("textarea");
    const submitButton = [...(container?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes("Submit answer"));
    if (!textarea || !submitButton) throw new Error("Expected the custom answer controls.");

    await enterAnswer(textarea, "Use the compact layout");
    await act(async () => submitButton.click());
    expect(textarea.disabled).toBe(true);

    await act(async () => finishSubmission?.());
    expect(textarea.disabled).toBe(false);
  });
});
