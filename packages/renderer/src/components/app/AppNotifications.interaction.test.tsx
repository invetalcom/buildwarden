/** @vitest-environment happy-dom */

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppNotifications } from "./AppNotifications";
import { InstanceContextProvider, type InstanceContextValue } from "../../lib/instance-context";

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

const notificationProps = (): ComponentProps<typeof AppNotifications> => ({
  busy: false, pendingDeleteRunCount: 0, visibleShellApprovals: [], shellApprovalQueueLength: 0,
  queuedShellApprovalCount: 0, visibleShellApprovalStartedAtById: {}, getShellApprovalTarget: () => null,
  onOpenShellApprovalRun: vi.fn(), onRespondToShellApproval: vi.fn(), error: null, selectedProjectName: null,
  detachedCheckoutBranch: "", availableRunBranches: [], projectCheckoutBusy: false,
  onDetachedCheckoutBranchChange: vi.fn(), onSubmitCheckoutDetachedProjectBranch: vi.fn(), onDismissError: vi.fn(),
  appWarning: null, onDismissAppWarning: vi.fn(), automationStartedToasts: [], onDismissAutomationStartedToast: vi.fn(),
  projectForgeRequestToasts: [], onOpenProjectForgeRequest: vi.fn(), onDismissProjectForgeRequestToast: vi.fn(),
});

it("uses the existing error notification for connection failures without covering an application error", async () => {
  const dismiss = vi.fn(); const manage = vi.fn();
  const context = { connectionError: { message: "Laptop is offline", onDismiss: dismiss }, manageInstances: manage } as unknown as InstanceContextValue;
  const props = notificationProps();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const render = async (error: string | null) => {
    await act(async () => root?.render(<InstanceContextProvider value={context}><AppNotifications {...props} error={error} /></InstanceContextProvider>));
  };
  await render("A run failed");
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(container.textContent).toContain("A run failed");
  expect(container.textContent).not.toContain("Laptop is offline");
  await act(async () => container?.querySelector<HTMLButtonElement>('[aria-label="Dismiss error notification"]')?.click());
  expect(props.onDismissError).toHaveBeenCalledOnce();
  expect(dismiss).not.toHaveBeenCalled();
  await render(null);
  expect(container.textContent).toContain("Laptop is offline");
  await act(async () => Array.from(container?.querySelectorAll("button") ?? []).find((button) => button.textContent === "Manage instances")?.click());
  expect(dismiss).toHaveBeenCalledOnce();
  expect(manage).toHaveBeenCalledOnce();
});

it("offers only allow once and deny for an action with nothing specific to remember", async () => {
  const props = notificationProps();
  const request = { runId: "run-1", requestId: "r1", command: "Edit note", requestedAt: Date.now(), toolApproval: true };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const render = async (onceOnly: boolean) => {
    const shown = onceOnly ? { ...request, onceOnly: true } : request;
    await act(async () => root?.render(
      <AppNotifications {...props} visibleShellApprovals={[shown]} shellApprovalQueueLength={1} visibleShellApprovalStartedAtById={{ r1: Date.now() }} />,
    ));
  };
  const labels = () => Array.from(container?.querySelectorAll("button") ?? []).map((button) => button.textContent);
  await render(false);
  expect(labels()).toEqual(expect.arrayContaining(["Allow once", "For this run", "Always allow"]));
  await render(true);
  expect(labels()).toEqual(expect.arrayContaining(["Deny", "Allow once"]));
  expect(labels()).not.toContain("For this run");
  expect(labels()).not.toContain("Always allow");
});
