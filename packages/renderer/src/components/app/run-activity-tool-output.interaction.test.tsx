/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityToolBatchRow } from "./run-activity-tool-rows";
import { summarizeToolBatchItems } from "./run-activity-tool-model";
import type { RunActivityStep } from "./run-activity-types";

const client = { getStepContent: vi.fn<(kind: "run" | "chat", stepId: string) => Promise<string | null>>() };
vi.mock("../../lib/buildwarden-client", () => ({ useBuildWardenClient: () => client, useOptionalBuildWardenClient: () => client }));

const step = (id: string, eventType: RunActivityStep["eventType"], content: string, extra: Partial<RunActivityStep> = {}): RunActivityStep => ({
  id, eventType, title: id, content, createdAt: "2026-11-20T12:00:00.000Z",
  metadataJson: JSON.stringify({ callId: "c1", toolName: "run_shell", command: "pnpm build" }), ...extra,
});
const metadata = { callId: "c1", toolName: "run_shell", command: "pnpm build", ok: true };

let root: Root;
let container: HTMLDivElement;
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const renderRow = (resultStep: RunActivityStep) => {
  const [row] = summarizeToolBatchItems([{ kind: "tool", callStep: step("call", "tool-call", ""), callMetadata: metadata, resultStep, resultMetadata: metadata }]);
  act(() => root.render(
    <ActivityToolBatchRow item={row!} itemIndex={0} run={{ id: "r1", status: "completed", mode: "code" }} density="comfortable" busy={false} readOnly />,
  ));
  return row!;
};

describe("previewed tool output", () => {
  it("loads the full output of a previewed step on request", async () => {
    const row = renderRow(step("result", "tool-result", "head\n… 900 characters of output omitted …\ntail", { contentOmittedChars: 900 }));
    expect(row.omittedOutput).toMatchObject({ stepId: "result", omittedChars: 900 });
    client.getStepContent.mockResolvedValue("head\nthe complete build log\ntail");

    const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.startsWith("Show full output"));
    expect(button?.textContent).toBe("Show full output (+900 characters)");
    await act(async () => button!.click());

    expect(client.getStepContent).toHaveBeenCalledWith("run", "result");
    expect(container.querySelector("pre")?.textContent).toBe("head\nthe complete build log\ntail");
    expect(container.textContent).not.toContain("Show full output");
  });

  it("drops loaded full output when the same step streams newer output", async () => {
    const showFullOutput = () => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.startsWith("Show full output"));
    const earlier = step("live", "tool-progress", "head\n… 900 characters of output omitted …\ntail", { contentOmittedChars: 900 });
    renderRow(earlier);
    client.getStepContent.mockResolvedValue("head\nthe log so far\ntail");
    await act(async () => showFullOutput()!.click());
    expect(container.querySelector("pre")?.textContent).toBe("head\nthe log so far\ntail");

    // An unchanged revision keeps the loaded text.
    renderRow({ ...earlier });
    expect(container.querySelector("pre")?.textContent).toBe("head\nthe log so far\ntail");

    renderRow(step("live", "tool-progress", "head\n… 950 characters of output omitted …\nnewer tail", { contentOmittedChars: 950 }));
    expect(container.querySelector("pre")?.textContent).toBe("head\n… 950 characters of output omitted …\nnewer tail");
    expect(showFullOutput()?.textContent).toBe("Show full output (+950 characters)");
  });

  it("keeps the newer full output when an earlier request finishes last", async () => {
    const showFullOutput = () => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.startsWith("Show full output"));
    const resolvers: Array<(content: string) => void> = [];
    client.getStepContent.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    renderRow(step("live", "tool-progress", "head\n… 900 characters of output omitted …\ntail", { contentOmittedChars: 900 }));
    await act(async () => showFullOutput()!.click());
    renderRow(step("live", "tool-progress", "head\n… 950 characters of output omitted …\nnewer tail", { contentOmittedChars: 950 }));
    await act(async () => showFullOutput()!.click());

    await act(async () => resolvers[1]!("head\nthe newer log\nnewer tail"));
    await act(async () => resolvers[0]!("head\nthe earlier log\ntail"));
    expect(container.querySelector("pre")?.textContent).toBe("head\nthe newer log\nnewer tail");
    expect(showFullOutput()).toBeUndefined();
  });

  it("shows no control for output that arrived whole", () => {
    const row = renderRow(step("result", "tool-result", "short output"));
    expect(row.omittedOutput).toBeUndefined();
    expect(container.textContent).not.toContain("Show full output");
  });
});
