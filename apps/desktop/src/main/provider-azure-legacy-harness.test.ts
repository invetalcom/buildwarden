import { describe, expect, it } from "vitest";
import {
  buildContinuationPrompt,
  createCompletionState,
  isLikelyValidationCommand,
  shouldForceContinuation,
  updateCompletionStateFromToolResult,
} from "../../../../packages/provider-azure-legacy/src";

describe("Azure Legacy harness completion gate", () => {
  it("does not force continuation when no files changed", () => {
    const state = createCompletionState();
    expect(shouldForceContinuation("code", state)).toBe(false);
  });

  it("forces continuation after edits without verification", () => {
    const state = createCompletionState();
    updateCompletionStateFromToolResult(state, "write_file", {
      ok: true,
      metadata: { path: "src/example.ts" },
    });

    expect(shouldForceContinuation("code", state)).toBe(true);
    expect(buildContinuationPrompt(state)).toContain("must verify completeness");
  });

  it("allows completion after successful validation", () => {
    const state = createCompletionState();
    updateCompletionStateFromToolResult(state, "write_file", {
      ok: true,
      metadata: { path: "src/example.ts" },
    });
    updateCompletionStateFromToolResult(state, "run_shell", {
      ok: true,
      metadata: { command: "pnpm typecheck" },
    });

    expect(shouldForceContinuation("code", state)).toBe(false);
  });

  it("forces continuation after failed validation", () => {
    const state = createCompletionState();
    updateCompletionStateFromToolResult(state, "write_file", {
      ok: true,
      metadata: { path: "src/example.ts" },
    });
    updateCompletionStateFromToolResult(state, "run_shell", {
      ok: false,
      metadata: { command: "pnpm typecheck" },
    });

    expect(shouldForceContinuation("code", state)).toBe(true);
    expect(buildContinuationPrompt(state)).toContain("Validation failed");
  });

  it("recognizes follow-up inspection after edits", () => {
    const state = createCompletionState();
    updateCompletionStateFromToolResult(state, "write_file", {
      ok: true,
      metadata: { path: "src/example.ts" },
    });
    updateCompletionStateFromToolResult(state, "read_file", {
      ok: true,
      metadata: { path: "src/example.ts" },
    });

    expect(shouldForceContinuation("code", state)).toBe(false);
  });

  it("detects likely validation commands", () => {
    expect(isLikelyValidationCommand("pnpm typecheck")).toBe(true);
    expect(isLikelyValidationCommand(".\\gradlew.bat test")).toBe(true);
    expect(isLikelyValidationCommand(" .\\gradlew build")).toBe(true);
    expect(isLikelyValidationCommand("git status -sb")).toBe(false);
  });

  it("allows completion after successful Gradle wrapper build", () => {
    const state = createCompletionState();
    updateCompletionStateFromToolResult(state, "write_file", {
      ok: true,
      metadata: { path: "src/main/java/example/Example.java" },
    });
    updateCompletionStateFromToolResult(state, "run_shell", {
      ok: true,
      metadata: { command: " .\\gradlew build" },
    });

    expect(shouldForceContinuation("code", state)).toBe(false);
  });
});
