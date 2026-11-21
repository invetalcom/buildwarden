/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ResponsePrWatchReport } from "./response-pr-watch-report";

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

const rows = () => [...container.querySelectorAll("li")].map((row) => row.textContent);

it("shows one row per comment when the report lists one twice", async () => {
  const code = JSON.stringify([
    { item: "C1", verdict: "incorrect", reply: "First answer." },
    { item: "c1", verdict: "intentional", reply: "Second answer." },
  ]);
  await act(() => root.render(<ResponsePrWatchReport code={code} />));
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toContain("Second answer.");
});

it("keeps verdicts written with surrounding spaces", async () => {
  const code = JSON.stringify([
    { item: "T1", verdict: "valid", commits: ["abc1234"], reply: "Added a null check." },
    { item: "C1", verdict: " needs-user ", reply: "" },
  ]);
  await act(() => root.render(<ResponsePrWatchReport code={code} />));
  expect(rows()).toHaveLength(2);
  expect(rows()[1]).toContain("needs user");
});
