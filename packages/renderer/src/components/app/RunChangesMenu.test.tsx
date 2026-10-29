/** @vitest-environment happy-dom */
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RunDetail, RunRecord } from "@buildwarden/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RunChangesMenu } from "./RunChangesMenu";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

const renderMenu = async (metadataJson: string, detailPatch: Partial<RunDetail> = {}) => {
  const run = { id: "run" } as RunRecord;
  const runDetail: RunDetail = {
    run, diff: "", diffLoaded: true, notes: [],
    steps: [{ metadataJson } as RunDetail["steps"][number]],
    ...detailPatch,
  };
  const onOpenBranchPublishDialog = vi.fn();
  const setPublishMenuOpen = vi.fn();
  const onRequestDiffSummary = vi.fn();
  await act(() => root.render(<RunChangesMenu
    run={run} runDetail={runDetail} busy={false} publishMenuOpen
    setPublishMenuOpen={setPublishMenuOpen} publishMenuAnchorRef={createRef<HTMLDivElement>()}
    onCommitRun={vi.fn()} onOpenPublishDialog={vi.fn()}
    onRequestDiffSummary={onRequestDiffSummary} onOpenBranchPublishDialog={onOpenBranchPublishDialog}
  />));
  return { run, onOpenBranchPublishDialog, setPublishMenuOpen, onRequestDiffSummary };
};
const button = (label: string) => [...document.querySelectorAll("button")].find((entry) => entry.textContent === label)!;

it.each(["null", "[]", "42", "invalid JSON"])("tolerates legacy metadata %s without enabling publish actions", async (metadata) => {
  await renderMenu(metadata);
  expect(button("Publish branch").disabled).toBe(true);
  expect(button("Create MR / PR").disabled).toBe(true);
});

it("closes the menu and publishes the selected run when a clean workspace has a commit", async () => {
  const { run, onOpenBranchPublishDialog, setPublishMenuOpen } = await renderMenu('{"commitHash":"abc123"}');
  await act(() => button("Publish branch").click());
  expect(setPublishMenuOpen).toHaveBeenCalledWith(false);
  expect(onOpenBranchPublishDialog).toHaveBeenCalledWith(run, "publish");
});

it("keeps publish actions disabled until the workspace summary is known", async () => {
  await renderMenu('{"commitHash":"abc123"}', { diffSummaryPending: true });
  expect(button("Checking changes").disabled).toBe(true);
  expect(button("Publish branch").disabled).toBe(true);
  expect(button("Publish branch").title).toBe("Checking workspace changes.");
  expect(button("Create local branch").disabled).toBe(true);
});
