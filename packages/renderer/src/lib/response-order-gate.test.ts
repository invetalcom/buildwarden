import { describe, expect, it } from "vitest";
import { createResponseOrderGate } from "./response-order-gate";

describe("createResponseOrderGate", () => {
  it("accepts answers that arrive in the order their requests started", () => {
    const gate = createResponseOrderGate();
    const first = gate.start();
    const second = gate.start();
    expect(gate.accept(first)).toBe(true);
    expect(gate.accept(second)).toBe(true);
  });

  it("drops an earlier request's answer that arrives after a later one", () => {
    const gate = createResponseOrderGate();
    const first = gate.start();
    const second = gate.start();
    expect(gate.accept(second)).toBe(true);
    expect(gate.accept(first)).toBe(false);
  });

  it("keeps accepting newer requests after dropping a stale answer", () => {
    const gate = createResponseOrderGate();
    const first = gate.start();
    const second = gate.start();
    gate.accept(second);
    gate.accept(first);
    expect(gate.accept(gate.start())).toBe(true);
  });
});
