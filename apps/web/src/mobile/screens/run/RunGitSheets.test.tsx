/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { BuildWardenClient } from "@buildwarden/renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MobileAppProvider, type MobileAppValue } from "../../data/mobile-app-context";
import { LocalBranchSheet, PullRequestSheet } from "./RunGitSheets";

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

const setTextareaValue = (textarea: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
};

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const mounted of mountedRoots.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});

describe("LocalBranchSheet", () => {
  it("renders the AI branch-name control", () => {
    const value = { client: {} as BuildWardenClient } as MobileAppValue;
    const markup = renderToStaticMarkup(
      <MobileAppProvider value={value}>
        <LocalBranchSheet
          runId="run-1"
          defaultName="feature/current-branch"
          open
          onClose={vi.fn()}
          onDone={vi.fn()}
        />
      </MobileAppProvider>,
    );

    expect(markup).toContain("Create local branch");
    expect(markup).toContain("feature/current-branch");
    expect(markup).toContain("Generate branch name with AI");
  });

  it("closes and reports completion after creating a void local branch", async () => {
    const createRunLocalBranch = vi.fn(async () => undefined);
    const onClose = vi.fn();
    const onDone = vi.fn(async () => undefined);
    const value = { client: { createRunLocalBranch } as unknown as BuildWardenClient } as MobileAppValue;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });

    await act(async () => root.render(
      <MobileAppProvider value={value}>
        <LocalBranchSheet
          runId="run-1"
          defaultName="feat/local-branch"
          open
          onClose={onClose}
          onDone={onDone}
        />
      </MobileAppProvider>,
    ));

    const createButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Create local branch");
    expect(createButton).toBeDefined();
    await act(async () => {
      createButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(createRunLocalBranch).toHaveBeenCalledWith("run-1", "feat/local-branch");
    expect(onClose).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledWith("feat/local-branch");
  });
});

describe("PullRequestSheet", () => {
  it("uses one generator to populate the complete PR draft", async () => {
    const suggestRunPullRequestDraft = vi.fn(async () => ({
      title: "Generated PR title",
      commitMessage: "Generated commit message",
      description: "## Summary\n\nGenerated description",
    }));
    const value = {
      client: {
        getRunPublishOptions: vi.fn(async () => ({
          defaultTargetBranch: "main",
          defaultSourceBranch: "feat/mobile-pr",
          defaultDescription: "Default description",
          defaultCommitMessage: "Default commit",
          hasOpenChanges: true,
          suggestedTitle: "Default title",
          targetBranches: ["main"],
        })),
        suggestRunPullRequestDraft,
      } as unknown as BuildWardenClient,
    } as MobileAppValue;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });

    await act(async () => {
      root.render(
        <MobileAppProvider value={value}>
          <PullRequestSheet runId="run-1" open onClose={vi.fn()} onDone={vi.fn()} />
        </MobileAppProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const generateButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .filter((button) => button.textContent?.trim() === "Generate PR content");
    expect(generateButtons).toHaveLength(1);
    expect(container.textContent).not.toContain("Generate PR description");
    expect(container.textContent).not.toContain("Generate commit message");

    await act(async () => {
      generateButtons[0]?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(suggestRunPullRequestDraft).toHaveBeenCalledWith("run-1", "main");
    expect(Array.from(container.querySelectorAll<HTMLInputElement>("input")).some((input) => input.value === "Generated PR title")).toBe(true);
    const textareaValues = Array.from(container.querySelectorAll<HTMLTextAreaElement>("textarea")).map((textarea) => textarea.value);
    expect(textareaValues).toContain("Generated commit message");
    expect(textareaValues).toContain("## Summary\n\nGenerated description");
  });

  it("requires and trims the commit message when submitting open changes", async () => {
    const createRunPullRequest = vi.fn(async () => "https://example.test/pull/1");
    const value = {
      client: {
        getRunPublishOptions: vi.fn(async () => ({
          defaultTargetBranch: "main",
          defaultSourceBranch: "feat/mobile-pr",
          defaultDescription: "Default description",
          defaultCommitMessage: "Default commit",
          hasOpenChanges: true,
          suggestedTitle: "Mobile PR title",
          targetBranches: ["main"],
        })),
        createRunPullRequest,
      } as unknown as BuildWardenClient,
    } as MobileAppValue;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });
    await act(async () => {
      root.render(
        <MobileAppProvider value={value}>
          <PullRequestSheet runId="run-1" open onClose={vi.fn()} onDone={vi.fn(async () => undefined)} />
        </MobileAppProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const commitMessage = container.querySelector<HTMLTextAreaElement>('textarea[placeholder="Commit message"]');
    const createButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Create pull request");
    expect(commitMessage).not.toBeNull();
    expect(createButton).toBeDefined();

    await act(async () => {
      if (commitMessage) {
        setTextareaValue(commitMessage, "   ");
      }
    });
    expect(createButton?.disabled).toBe(true);

    await act(async () => {
      if (commitMessage) {
        setTextareaValue(commitMessage, "  Commit mobile changes  ");
      }
    });
    expect(createButton?.disabled).toBe(false);

    await act(async () => {
      createButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createRunPullRequest).toHaveBeenCalledWith(
      "run-1",
      "main",
      "Mobile PR title",
      undefined,
      "Default description",
      "Commit mobile changes",
    );
  });

  it("omits the commit message when submitting a clean workspace", async () => {
    const createRunPullRequest = vi.fn(async () => "https://example.test/pull/1");
    const value = {
      client: {
        getRunPublishOptions: vi.fn(async () => ({
          defaultTargetBranch: "main",
          defaultSourceBranch: "feat/mobile-pr",
          defaultDescription: "Default description",
          defaultCommitMessage: "Unused commit",
          hasOpenChanges: false,
          suggestedTitle: "Mobile PR title",
          targetBranches: ["main"],
        })),
        createRunPullRequest,
      } as unknown as BuildWardenClient,
    } as MobileAppValue;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });
    await act(async () => {
      root.render(
        <MobileAppProvider value={value}>
          <PullRequestSheet runId="run-1" open onClose={vi.fn()} onDone={vi.fn(async () => undefined)} />
        </MobileAppProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('textarea[placeholder="Commit message"]')).toBeNull();
    const createButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Create pull request");
    await act(async () => {
      createButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(createRunPullRequest).toHaveBeenCalledWith(
      "run-1",
      "main",
      "Mobile PR title",
      undefined,
      "Default description",
      undefined,
    );
  });
});
