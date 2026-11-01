/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ErrorNotification } from "../../../../packages/renderer/src/components/app/ErrorNotification";
import { InstanceSettings } from "./InstanceSettings";
import { useConnectionError } from "./use-connection-error";
import type { ConnectedInstance, InstanceManager } from "./instance-manager";

vi.mock("@buildwarden/renderer", async () => ({
  ...await import("../../../../packages/renderer/src/components/ui/button"),
  ...await import("../../../../packages/renderer/src/components/ui/input"),
  ...await import("../../../../packages/renderer/src/components/ui/badge"),
}));

const instance = (id: string, status: ConnectedInstance["status"]): ConnectedInstance => ({
  connection: { id, name: "Laptop", hostOrigin: `https://${id}.ts.net`, token: "token", session: {
    id, label: "Browser", scopes: ["state:read"], createdAt: "2026-01-01", expiresAt: "2027-01-01", lastUsedAt: "2026-01-01", revokedAt: null, clientOrigin: "https://web.example",
  } },
  status, client: null, snapshot: null, attention: [], bookmarks: [], chatBookmarks: [], bookmarksLoaded: false, lastSeen: null,
});
const Harness = ({ instances }: { instances: ConnectedInstance[] }) => {
  const error = useConnectionError(instances);
  return error ? <ErrorNotification error={error.message} onDismissError={error.onDismiss} /> : null;
};
let root: Root;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); });
const mount = async (element: React.ReactNode) => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(element));
};
const render = async (instances: ConnectedInstance[]) => { await act(async () => root.render(<Harness instances={instances} />)); };

describe("instance connection errors", () => {
  it("announces settled startup failures, distinguishes duplicate names, and does not repeat dismissed retries", async () => {
    await mount(<Harness instances={[instance("a", "connecting"), instance("b", "connecting")]} />);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await render([instance("a", "offline"), instance("b", "connecting")]);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Laptop (a.ts.net)");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss error notification"]')?.click());
    await render([instance("a", "offline"), instance("b", "connecting")]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await render([instance("a", "offline"), instance("b", "pairing-required")]);
    expect(container.textContent).toContain("Laptop (b.ts.net)");
    expect(container.textContent).toContain("Pairing required");
    expect(container.textContent).not.toContain("a.ts.net");
  });

  it("clears notices when hosts recover or are removed, including when all hosts were offline", async () => {
    await mount(<Harness instances={[instance("a", "offline"), instance("b", "offline")]} />);
    expect(container.textContent).toContain("a.ts.net");
    expect(container.textContent).toContain("b.ts.net");
    await render([instance("a", "online"), instance("b", "offline")]);
    expect(container.textContent).not.toContain("a.ts.net");
    await render([instance("a", "online")]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("highlights unavailable connections and offers reconnect without mislabeling them as read-only", async () => {
    const refresh = vi.fn(async () => {});
    const manager = { refresh } as unknown as InstanceManager;
    await mount(<InstanceSettings instances={[instance("a", "offline"), instance("b", "online"), instance("c", "pairing-required")]}
      manager={manager} hint={{ hostOrigin: "", code: "" }} onPaired={vi.fn()} />);
    const offline = container.querySelector('[aria-label="Laptop: Offline"]');
    expect(offline?.getAttribute("data-unavailable")).toBe("true");
    expect(offline?.querySelector(".bw-instance-error")?.textContent).toContain("Host unavailable");
    expect(offline?.textContent).not.toContain("Read-only");
    expect(container.querySelector('[aria-label="Laptop: Online"]')?.hasAttribute("data-unavailable")).toBe(false);
    expect(container.querySelector('[aria-label="Laptop: Pairing required"]')?.textContent).toContain("Pair again");
    await act(async () => Array.from(offline?.querySelectorAll("button") ?? []).find((button) => button.textContent === "Reconnect")?.click());
    expect(refresh).toHaveBeenCalledWith("a");
  });
});
