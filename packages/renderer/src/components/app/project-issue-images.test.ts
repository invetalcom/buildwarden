import { describe, expect, it, vi } from "vitest";
import { createIssueImageLoader } from "./project-issue-images";

const deferred = () => {
  let resolve: (value: string) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createIssueImageLoader", () => {
  it("downloads an image once and reuses it afterwards", async () => {
    const fetchImage = vi.fn(async (url: string) => `data:${url}`);
    const load = createIssueImageLoader(fetchImage);

    const [first, second] = await Promise.all([load("https://host/a.png", 1), load("https://host/a.png", 1)]);

    expect(first).toBe("data:https://host/a.png");
    expect(second).toBe(first);
    expect(await load("https://host/a.png", 2)).toBe(first);
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it("runs only a few downloads at a time", async () => {
    const pending = new Map<string, ReturnType<typeof deferred>>();
    const fetchImage = vi.fn((url: string) => {
      const entry = deferred();
      pending.set(url, entry);
      return entry.promise;
    });
    const load = createIssueImageLoader(fetchImage, { parallel: 2, remembered: 10 });

    const results = ["a", "b", "c"].map((name) => load(name, 1));
    await settle();
    expect([...pending.keys()]).toEqual(["a", "b"]);

    pending.get("a")?.resolve("A");
    await settle();
    expect([...pending.keys()]).toEqual(["a", "b", "c"]);

    pending.get("b")?.resolve("B");
    pending.get("c")?.resolve("C");
    expect(await Promise.all(results)).toEqual(["A", "B", "C"]);
  });

  it("tries a failed download again and frees its slot", async () => {
    let attempt = 0;
    const fetchImage = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("offline");
      return "data:ok";
    });
    const load = createIssueImageLoader(fetchImage, { parallel: 1, remembered: 10 });

    await expect(load("a", 1)).rejects.toThrow("offline");
    await settle();
    expect(await load("a", 1)).toBe("data:ok");
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it("forgets the images used longest ago", async () => {
    const fetchImage = vi.fn(async (url: string) => `data:${url}`);
    const load = createIssueImageLoader(fetchImage, { parallel: 4, remembered: 2 });

    await load("a", 1);
    await load("b", 1);
    await load("a", 1);
    await load("c", 1);
    await load("a", 1);
    expect(fetchImage).toHaveBeenCalledTimes(3);
    await load("b", 1);
    expect(fetchImage).toHaveBeenCalledTimes(4);
  });
});
