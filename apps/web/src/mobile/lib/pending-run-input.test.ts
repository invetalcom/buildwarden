import { expect, it } from "vitest";
import type { RunDetail, RunStepRecord } from "@buildwarden/shared";
import { findPendingUserInput } from "./pending-run-input";

const question = (id: string, extra = {}): RunStepRecord => ({ id, runId: "run", eventType: "user-input-requested", title: "Question", content: "", createdAt: "", metadataJson: JSON.stringify({ userInputRequestId: id, userInputQuestions: [{ id: "pick", header: "Choice", question: "Pick one", options: [{ label: "A" }] }], ...extra }) });
const detail = (steps: RunStepRecord[]) => ({ steps } as RunDetail);

it("does not resurrect an older unanswered request after the latest one was answered", () => {
  expect(findPendingUserInput(detail([question("old"), question("new", { userInputAnswers: { pick: "A" } })]))).toBeNull();
});
it("does not search past a new user turn while its worker is starting", () => {
  const followUp = { ...question("followup"), eventType: "log" as const, metadataJson: '{"source":"user","commandType":"follow-up"}' };
  expect(findPendingUserInput(detail([question("old"), followUp]))).toBeNull();
  expect(findPendingUserInput(detail([question("old"), followUp, question("new")]))?.requestId).toBe("new");
});
it("skips explicitly cancelled requests and supports legacy request IDs", () => {
  const legacy = question("legacy", { userInputRequestId: undefined, requestId: "legacy-id" });
  expect(findPendingUserInput(detail([legacy, question("cancelled", { requestStatus: "cancelled" })]))?.requestId).toBe("legacy-id");
});

