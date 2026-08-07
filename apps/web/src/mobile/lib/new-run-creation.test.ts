import { describe, expect, it, vi } from "vitest";
import { createNewRunsIndependently } from "./new-run-creation";

describe("createNewRunsIndependently", () => {
  it("continues after a model fails and returns both successful runs and failures", async () => {
    const createRun = vi.fn(async (model: string) => {
      if (model === "model-b") throw new Error("provider offline");
      return `run-for-${model}`;
    });

    const result = await createNewRunsIndependently(["model-a", "model-b", "model-c"], createRun);

    expect(createRun).toHaveBeenCalledTimes(3);
    expect(result.runs).toEqual(["run-for-model-a", "run-for-model-c"]);
    expect(result.failures).toEqual([{ model: "model-b", error: expect.any(Error) }]);
  });
});
