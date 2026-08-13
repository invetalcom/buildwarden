import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunRecord } from "@buildwarden/shared";
import { describe, expect, it, vi } from "vitest";
import { RunActionDialogs } from "./RunActionDialogs";

const renderDialogs = (overrides: Partial<ComponentProps<typeof RunActionDialogs>>) =>
  renderToStaticMarkup(<RunActionDialogs {...({
  busy: false,
  commitDialogRun: null,
  commitMessage: "",
  commitSuggestBusy: false,
  publishDialogRun: null,
  branchPublishDialogRun: null,
  branchPublishName: "",
  branchPublishMode: "local",
  continueDialogRun: null,
  confirmDialog: null,
  onResolveConfirmation: vi.fn(),
  ...overrides,
} as unknown as ComponentProps<typeof RunActionDialogs>)} />);

const renderConfirmation = (
  confirmDialog: NonNullable<ComponentProps<typeof RunActionDialogs>["confirmDialog"]>,
) => renderDialogs({ confirmDialog });

const dialogRun = (prompt: string) => ({
  prompt,
  workspaceType: "worktree",
  branchName: "feature/test-run",
} as RunRecord);

describe("RunActionDialogs run actions", () => {
  const longPrompt = "Redesign the Kanban Cards. Just the Cards, not the board";

  it("does not render the run prompt in the create commit dialog", () => {
    const markup = renderDialogs({
      commitDialogRun: dialogRun(longPrompt),
      commitMessage: "buildwarden: update cards",
    });

    expect(markup).toContain("Create commit");
    expect(markup).not.toContain(longPrompt);
  });

  it("does not render the run prompt in the create local branch dialog", () => {
    const markup = renderDialogs({
      branchPublishDialogRun: dialogRun(longPrompt),
      branchPublishName: "feature/update-cards",
      branchPublishMode: "local",
    });

    expect(markup).toContain("Create local branch");
    expect(markup).not.toContain(longPrompt);
  });
});

describe("RunActionDialogs confirmation", () => {
  it("uses an opaque panel surface over the blurred workspace", () => {
    const markup = renderConfirmation({
      title: "Delete selected runs",
      message: "Selected runs will be deleted.",
      confirmLabel: "Delete selected runs",
      confirmVariant: "danger",
    });

    expect(markup).toContain("!bg-zinc-900");
  });

  it("renders grouped deletion impact counts", () => {
    const markup = renderConfirmation({
      title: "Delete model",
      message: "Related data will be deleted.",
      impactItems: [
        { label: "Agent runs", count: 3 },
        { label: "Chats", count: 2 },
      ],
      confirmLabel: "Delete model",
      confirmVariant: "danger",
    });

    expect(markup).toContain("Related data");
    expect(markup).toContain("Agent runs");
    expect(markup).toContain(">3<");
    expect(markup).toContain("Chats");
    expect(markup).toContain(">2<");
  });

  it("keeps ordinary confirmations compact when no impact items are provided", () => {
    const markup = renderConfirmation({
      title: "Continue?",
      message: "Confirm this action.",
      confirmLabel: "Continue",
    });

    expect(markup).not.toContain("Related data");
    expect(markup).toContain("Confirm this action.");
  });
});
