/** @vitest-environment happy-dom */
import type { DesktopApi, ProjectSnapshot } from "@buildwarden/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useProjectBranches } from "./use-project-branches";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
});

const projectSnapshot = (id: string, baseBranch = "main"): ProjectSnapshot =>
  ({ project: { id, kind: "git", baseBranch } }) as unknown as ProjectSnapshot;

const setError = () => undefined;

const Harness = (props: { buildwarden: DesktopApi; selectedProject: ProjectSnapshot | null; refreshToken?: number }) => {
  useProjectBranches({ ...props, setError });
  return null;
};

describe("useProjectBranches", () => {
  it("reloads branches only when the selected project identity or refresh token changes", async () => {
    const getProjectBranches = vi.fn(async () => ["main", "dev"]);
    const getProjectCurrentBranch = vi.fn(async () => "main");
    const buildwarden = { getProjectBranches, getProjectCurrentBranch } as unknown as DesktopApi;
    container = document.createElement("div");
    document.body.append(container);
    const mountedRoot = createRoot(container);
    root = mountedRoot;
    const render = (selectedProject: ProjectSnapshot, refreshToken = 0) =>
      act(async () => mountedRoot.render(<Harness buildwarden={buildwarden} selectedProject={selectedProject} refreshToken={refreshToken} />));

    await render(projectSnapshot("project-1"));
    expect(getProjectBranches).toHaveBeenCalledTimes(1);

    // A snapshot refresh recreates the project object with the same fields.
    await render(projectSnapshot("project-1"));
    expect(getProjectBranches).toHaveBeenCalledTimes(1);

    await render(projectSnapshot("project-1"), 1);
    expect(getProjectBranches).toHaveBeenCalledTimes(2);

    await render(projectSnapshot("project-2"), 1);
    expect(getProjectBranches).toHaveBeenCalledTimes(3);
    expect(getProjectBranches).toHaveBeenLastCalledWith("project-2");
  });
});
