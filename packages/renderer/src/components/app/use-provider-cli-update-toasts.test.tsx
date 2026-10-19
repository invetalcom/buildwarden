/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, ProviderCliUpdateSnapshot, ProviderCliUpdateStatus } from "@buildwarden/shared";
import { createElectronBuildWardenClient, type BuildWardenClient } from "../../lib/buildwarden-client-core";
import { AppNotifications } from "./AppNotifications";
import { PROVIDER_CLI_UPDATE_TOASTS_STORAGE_KEY, useProviderCliUpdateToasts } from "./use-provider-cli-update-toasts";

let root: Root | undefined;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => window.localStorage.clear());
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); });

const status: ProviderCliUpdateStatus = {
  providerType: "claude-code", label: "Claude Code", binaryPath: "/home/dev/.local/bin/claude",
  installedVersion: "2.1.302", latestVersion: "2.1.303", state: "update-available", installMethod: "native",
  updateCommand: "/home/dev/.local/bin/claude update", canAutoUpdate: true, manualReason: null, inUse: false,
  dismissed: false, message: null, checkedAt: "2026-10-19T08:00:00Z",
};

const snapshotWith = (...providers: ProviderCliUpdateStatus[]): ProviderCliUpdateSnapshot =>
  ({ enabled: true, notify: true, checking: false, lastCheckedAt: "2026-10-19T08:00:00Z", providers });

const Harness = ({ client, onError }: { client: BuildWardenClient; onError: (message: string) => void }) => {
  const toasts = useProviderCliUpdateToasts(client, onError);
  return (
    <AppNotifications
      busy={false} pendingDeleteRunCount={0} visibleShellApprovals={[]} shellApprovalQueueLength={0} queuedShellApprovalCount={0}
      visibleShellApprovalStartedAtById={{}} getShellApprovalTarget={() => null} onOpenShellApprovalRun={() => undefined}
      onRespondToShellApproval={() => undefined} error={null} selectedProjectName={null} detachedCheckoutBranch=""
      availableRunBranches={[]} projectCheckoutBusy={false} onDetachedCheckoutBranchChange={() => undefined}
      onSubmitCheckoutDetachedProjectBranch={() => undefined} onDismissError={() => undefined} appWarning={null}
      onDismissAppWarning={() => undefined} automationStartedToasts={[]} onDismissAutomationStartedToast={() => undefined}
      projectForgeRequestToasts={[]} onOpenProjectForgeRequest={() => undefined} onDismissProjectForgeRequestToast={() => undefined}
      providerCliUpdateToasts={toasts.toasts}
      providerCliUpdatingType={toasts.updatingType}
      onUpdateProviderCli={(providerType) => void toasts.update(providerType)}
      onDismissProviderCliUpdateToast={toasts.dismiss}
    />
  );
};

const render = async (
  initial: ProviderCliUpdateSnapshot,
  options: { platform?: BuildWardenClient["capabilities"]["platform"]; settings?: boolean; runProviderCliUpdate?: () => Promise<unknown> } = {},
) => {
  let emit: (next: ProviderCliUpdateSnapshot) => void = () => undefined;
  const getProviderCliUpdates = vi.fn(async () => initial);
  const subscribe = vi.fn((listener: (next: ProviderCliUpdateSnapshot) => void) => {
    emit = listener;
    return () => undefined;
  });
  const runProviderCliUpdate = vi.fn(options.runProviderCliUpdate ?? (async () => undefined));
  const base = createElectronBuildWardenClient({
    getProviderCliUpdates, onProviderCliUpdatesChanged: subscribe, runProviderCliUpdate,
  } as unknown as DesktopApi);
  const client = { ...base, capabilities: { ...base.capabilities, platform: options.platform ?? "web", settings: options.settings ?? true } };
  const onError = vi.fn();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root?.render(<Harness client={client} onError={onError} />));
  return { getProviderCliUpdates, subscribe, onError, runProviderCliUpdate, emit: (next: ProviderCliUpdateSnapshot) => act(async () => emit(next)) };
};

const button = (text: string) => [...container.querySelectorAll("button")].find((entry) => entry.textContent?.includes(text));
const unmount = async () => { await act(async () => root?.unmount()); root = undefined; container.remove(); };

describe("provider CLI update toasts", () => {
  it("announces versions found while the page was closed, once per browser", async () => {
    await render(snapshotWith(status));
    expect(container.textContent).toContain("CLI update available");
    expect(container.textContent).toContain("Claude Code v2.1.302 → v2.1.303");
    expect(JSON.parse(window.localStorage.getItem(PROVIDER_CLI_UPDATE_TOASTS_STORAGE_KEY) ?? "[]")).toEqual(["provider-update:claude-code:2.1.303"]);

    await unmount();
    await render(snapshotWith(status));
    expect(container.textContent).not.toContain("CLI update available");
  });

  it("announces a newer version even after an earlier one was shown", async () => {
    window.localStorage.setItem(PROVIDER_CLI_UPDATE_TOASTS_STORAGE_KEY, JSON.stringify(["provider-update:claude-code:2.1.303"]));
    const { emit } = await render(snapshotWith(status));
    expect(container.textContent).not.toContain("CLI update available");
    await emit(snapshotWith({ ...status, latestVersion: "2.1.304" }));
    expect(container.textContent).toContain("v2.1.304");
  });

  it("follows live in-use changes and closes once the CLI is current", async () => {
    const { emit } = await render(snapshotWith(status));
    await emit(snapshotWith({ ...status, inUse: true }));
    expect(button("Update")?.disabled).toBe(true);
    expect(container.textContent).toContain("In use by an active run or chat.");
    await emit(snapshotWith({ ...status, inUse: false }));
    expect(button("Update")?.disabled).toBe(false);
    await emit(snapshotWith({ ...status, state: "current", installedVersion: "2.1.303" }));
    expect(container.textContent).not.toContain("CLI update available");
  });

  it("respects the notify setting and inbox dismissals", async () => {
    await render({ ...snapshotWith(status), notify: false });
    expect(container.textContent).not.toContain("CLI update available");
    await unmount();
    window.localStorage.clear();
    const { emit } = await render(snapshotWith(status));
    expect(container.textContent).toContain("CLI update available");
    await emit(snapshotWith({ ...status, dismissed: true }));
    expect(container.textContent).not.toContain("CLI update available");
  });

  it("updates on the host and reports failures without the IPC prefix", async () => {
    const failing = async () => {
      throw new Error("Error invoking remote method 'buildwarden:run-provider-cli-update': Error: Claude Code update failed: EACCES");
    };
    const { onError, runProviderCliUpdate } = await render(snapshotWith(status), { runProviderCliUpdate: failing });
    await act(async () => button("Update")!.click());
    expect(runProviderCliUpdate).toHaveBeenCalledWith("claude-code");
    expect(onError).toHaveBeenCalledWith("Claude Code update failed: EACCES");
    expect(container.textContent).toContain("CLI update available");
    await act(async () => button("Dismiss")!.click());
    expect(container.textContent).not.toContain("CLI update available");
  });

  it("does not duplicate the desktop OS notification and skips sessions without settings access", async () => {
    const desktop = await render(snapshotWith(status), { platform: "electron" });
    expect(desktop.getProviderCliUpdates).not.toHaveBeenCalled();
    expect(desktop.subscribe).not.toHaveBeenCalled();
    await unmount();
    const readOnly = await render(snapshotWith(status), { settings: false });
    expect(readOnly.getProviderCliUpdates).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("CLI update available");
  });
});
