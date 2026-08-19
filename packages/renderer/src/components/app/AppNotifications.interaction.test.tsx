/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppNotifications } from "./AppNotifications";

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

describe("application automation notifications", () => {
  it("shows and dismisses an automation-started notification", async () => {
    const onDismiss = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <AppNotifications
        busy={false}
        pendingDeleteRunCount={0}
        visibleShellApprovals={[]}
        shellApprovalQueueLength={0}
        queuedShellApprovalCount={0}
        visibleShellApprovalStartedAtById={{}}
        getShellApprovalTarget={() => null}
        onOpenShellApprovalRun={vi.fn()}
        onRespondToShellApproval={vi.fn()}
        error={null}
        selectedProjectName={null}
        detachedCheckoutBranch=""
        availableRunBranches={[]}
        projectCheckoutBusy={false}
        onDetachedCheckoutBranchChange={vi.fn()}
        onSubmitCheckoutDetachedProjectBranch={vi.fn()}
        onDismissError={vi.fn()}
        appWarning={null}
        onDismissAppWarning={vi.fn()}
        automationStartedToasts={[{
          automationId: "automation-1",
          automationName: "Daily review",
          projectId: "project-1",
          projectName: "BuildWarden",
          runId: "run-1",
          startedAt: "2026-08-19T09:00:00.000Z",
        }]}
        onDismissAutomationStartedToast={onDismiss}
        projectForgeRequestToasts={[]}
        onOpenProjectForgeRequest={vi.fn()}
        onDismissProjectForgeRequestToast={vi.fn()}
      />,
    ));

    expect(container.textContent).toContain("Automation started");
    expect(container.textContent).toContain("Daily review");
    const dismiss = container.querySelector<HTMLButtonElement>('[aria-label="Dismiss Daily review automation notification"]');
    await act(async () => dismiss?.click());
    expect(onDismiss).toHaveBeenCalledWith("run-1");
  });
});
