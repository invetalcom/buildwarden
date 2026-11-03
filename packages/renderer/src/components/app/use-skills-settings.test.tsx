/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { DesktopApi, IntegratedSkillMetadata } from "@buildwarden/shared";
import { useSkillsSettings } from "./use-skills-settings";

let root: Root | undefined;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); });

const deferred = () => {
  let resolve!: (skills: IntegratedSkillMetadata[]) => void;
  const promise = new Promise<IntegratedSkillMetadata[]>((done) => { resolve = done; });
  return { promise, resolve };
};
const skill = (id: string): IntegratedSkillMetadata => ({ id, source: "local", category: "custom", name: id, title: id, description: id, license: null, relativeDir: "", sourceUrl: "" });

it("keeps the import refresh when the initial catalog request finishes later", async () => {
  const initial = deferred(); const refreshed = deferred();
  const listIntegratedSkills = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(refreshed.promise);
  const client = { listIntegratedSkills } as unknown as DesktopApi;
  const View = () => {
    const { integratedSkillsCatalog } = useSkillsSettings({ buildwarden: client, snapshotSettings: {}, loadSnapshot: async () => {} });
    return <div>{integratedSkillsCatalog.map((entry) => entry.id).join(",")}</div>;
  };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(() => root!.render(<View />));
  await act(() => { window.dispatchEvent(new Event("buildwarden-skills-changed")); });
  await act(async () => { refreshed.resolve([skill("original"), skill("imported")]); await refreshed.promise; });
  expect(container.textContent).toBe("original,imported");
  await act(async () => { initial.resolve([skill("original")]); await initial.promise; });
  expect(container.textContent).toBe("original,imported");
  await act(() => root!.unmount()); root = undefined;
  window.dispatchEvent(new Event("buildwarden-skills-changed"));
  expect(listIntegratedSkills).toHaveBeenCalledTimes(2);
});
