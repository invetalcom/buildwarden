import type { RunDetail } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import { RecentRunDetailCache } from "./recent-run-details";

const detail = (id: string) => ({ run: { id } }) as unknown as RunDetail;

describe("RecentRunDetailCache", () => {
  it("evicts the least recently stored run detail beyond capacity", () => {
    const cache = new RecentRunDetailCache(2);
    cache.set("a", detail("a"));
    cache.set("b", detail("b"));
    cache.set("a", detail("a"));
    cache.set("c", detail("c"));

    expect(cache.get("a")?.run.id).toBe("a");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")?.run.id).toBe("c");
  });

  it("forgets deleted runs", () => {
    const cache = new RecentRunDetailCache();
    cache.set("a", detail("a"));
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
  });
});
