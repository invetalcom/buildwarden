/** @vitest-environment happy-dom */

import type { DesktopApi, RunRecord } from "@buildwarden/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BuildWardenClientProvider } from "./buildwarden-client";
import { createElectronBuildWardenClient } from "./buildwarden-client-core";
import { useRunUserInputSearch } from "./use-run-user-input-search";

type SearchRun = Pick<RunRecord, "id" | "lastUserInputAt">;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latestMatches: ReadonlySet<string> | null = null;

const Probe = ({ runs }: { runs: SearchRun[] }) => {
  latestMatches = useRunUserInputSearch(["answer"], runs);
  return null;
};

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latestMatches = null;
  vi.useRealTimers();
});

describe("useRunUserInputSearch", () => {
  it("searches again when run user input changes, but not for other snapshot updates", async () => {
    const searchRunUserInput = vi.fn<(query: string) => Promise<string[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["run-1"]);
    const client = createElectronBuildWardenClient({ searchRunUserInput } as unknown as DesktopApi);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = (runs: SearchRun[]) => act(async () => root?.render(
      <BuildWardenClientProvider client={client}>
        <Probe runs={runs} />
      </BuildWardenClientProvider>,
    ));
    const settleSearch = () => act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    await render([{ id: "run-1", lastUserInputAt: "2026-01-01T00:00:00.000Z" }]);
    await settleSearch();
    expect(searchRunUserInput).toHaveBeenCalledTimes(1);
    expect([...(latestMatches ?? [])]).toEqual([]);

    // A fresh snapshot without new user input (e.g. a token-usage refresh).
    await render([{ id: "run-1", lastUserInputAt: "2026-01-01T00:00:00.000Z" }]);
    await settleSearch();
    expect(searchRunUserInput).toHaveBeenCalledTimes(1);

    await render([{ id: "run-1", lastUserInputAt: "2026-01-01T00:05:00.000Z" }]);
    expect([...(latestMatches ?? [])]).toEqual([]);
    await settleSearch();
    expect(searchRunUserInput).toHaveBeenCalledTimes(2);
    expect([...(latestMatches ?? [])]).toEqual(["run-1"]);
  });
});
