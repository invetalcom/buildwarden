import { describe, expect, it } from "vitest";
import { replaceEqualDeep } from "./structural-sharing";

describe("replaceEqualDeep", () => {
  it("returns the previous value when nothing changed", () => {
    const previous = { projects: [{ id: "p1", runs: [{ id: "r1", status: "done" }] }], settings: { a: "1" } };
    const next = structuredClone(previous);
    expect(replaceEqualDeep(previous, next)).toBe(previous);
  });

  it("keeps unchanged branches and replaces changed ones", () => {
    const previous = {
      projects: [
        { id: "p1", runs: [{ id: "r1", status: "running" }, { id: "r2", status: "done" }] },
        { id: "p2", runs: [{ id: "r3", status: "done" }] },
      ],
      settings: { theme: "dark" },
    };
    const next = structuredClone(previous);
    next.projects[0]!.runs[0]!.status = "done";

    const result = replaceEqualDeep(previous, next);

    expect(result).not.toBe(previous);
    expect(result).toEqual(next);
    expect(result.settings).toBe(previous.settings);
    expect(result.projects[1]).toBe(previous.projects[1]);
    expect(result.projects[0]).not.toBe(previous.projects[0]);
    expect(result.projects[0]!.runs[1]).toBe(previous.projects[0]!.runs[1]);
    expect(result.projects[0]!.runs[0]).toBe(next.projects[0]!.runs[0]);
  });

  it("detects added, removed and reordered entries", () => {
    const previous = { list: [{ id: "a" }, { id: "b" }], extra: { x: 1 } as Record<string, number> };
    const added = replaceEqualDeep(previous, { list: [{ id: "a" }, { id: "b" }, { id: "c" }], extra: { x: 1 } });
    expect(added.list).not.toBe(previous.list);
    expect(added.list[0]).toBe(previous.list[0]);

    const removedKey = replaceEqualDeep(previous, { list: [{ id: "a" }, { id: "b" }], extra: {} });
    expect(removedKey.extra).not.toBe(previous.extra);
    expect(removedKey.list).toBe(previous.list);

    const reordered = replaceEqualDeep(previous, { list: [{ id: "b" }, { id: "a" }], extra: { x: 1 } });
    expect(reordered.list).toEqual([{ id: "b" }, { id: "a" }]);
    expect(reordered.extra).toBe(previous.extra);
  });

  it("treats a key that changed from undefined to missing as a change", () => {
    const previous: { a?: number; b: number } = { a: undefined, b: 1 };
    const result = replaceEqualDeep(previous, { b: 1, c: undefined } as { b: number; c?: number });
    expect(result).not.toBe(previous);
    expect(Object.keys(result)).toEqual(["b", "c"]);
  });

  it("keeps a JSON __proto__ key as an own property without changing the prototype", () => {
    const previous = JSON.parse('{"stable":{},"value":0}') as Record<string, unknown>;
    const next = JSON.parse('{"stable":{},"value":1,"__proto__":{"flag":true}}') as Record<string, unknown>;

    const result = replaceEqualDeep(previous, next);

    expect(result.stable).toBe(previous.stable);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toEqual({ flag: true });
    expect((result as { flag?: unknown }).flag).toBeUndefined();
    expect(Object.keys(result)).toEqual(["stable", "value", "__proto__"]);
  });

  it("does not share non-plain objects", () => {
    const date = new Date(0);
    const result = replaceEqualDeep({ at: new Date(0) }, { at: date });
    expect(result.at).toBe(date);
  });
});
