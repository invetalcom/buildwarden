import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RunActionDialogs } from "./RunActionDialogs";

const renderConfirmation = (
  confirmDialog: NonNullable<ComponentProps<typeof RunActionDialogs>["confirmDialog"]>,
) => renderToStaticMarkup(<RunActionDialogs {...({
  busy: false,
  commitDialogRun: null,
  publishDialogRun: null,
  branchPublishDialogRun: null,
  continueDialogRun: null,
  confirmDialog,
  onResolveConfirmation: vi.fn(),
} as unknown as ComponentProps<typeof RunActionDialogs>)} />);

describe("RunActionDialogs confirmation", () => {
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
