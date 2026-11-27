import { describe, expect, it } from "vitest";
import { formatAppErrorMessage } from "./app-error-message";

describe("formatAppErrorMessage", () => {
  it("drops Electron's remote method wrapper and a plain Error prefix", () => {
    expect(formatAppErrorMessage(new Error("Error invoking remote method 'buildwarden:get-run-detail': Error: Run not found."), "x"))
      .toBe("Run not found.");
  });

  it("keeps the kind of other errors after dropping the wrapper", () => {
    expect(formatAppErrorMessage(new Error("Error invoking remote method 'buildwarden:get-run-detail': TypeError: Cannot read properties of undefined"), "x"))
      .toBe("TypeError: Cannot read properties of undefined");
  });

  it("uses the fallback when no readable text is left", () => {
    expect(formatAppErrorMessage(new Error(""), "Could not load this run.")).toBe("Could not load this run.");
    expect(formatAppErrorMessage(new Error("  "), "Could not load this run.")).toBe("Could not load this run.");
    expect(formatAppErrorMessage(new Error("Error invoking remote method 'buildwarden:get-run-detail': Error: "), "Fallback."))
      .toBe("Fallback.");
  });

  it("returns other messages unchanged and uses the fallback for non-errors", () => {
    expect(formatAppErrorMessage(new Error("Network down"), "x")).toBe("Network down");
    expect(formatAppErrorMessage("oops", "Something failed.")).toBe("Something failed.");
  });
});
