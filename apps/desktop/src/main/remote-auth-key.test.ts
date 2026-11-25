import { describe, expect, it } from "vitest";
import { loadRemoteAuthKey } from "./remote-auth-key";

const createStore = () => {
  const entries = new Map<string, string>();
  const unreadable = new Set<string>();
  return {
    entries,
    unreadable,
    readSecret: async (key: string) => unreadable.has(key) ? null : entries.get(key) ?? null,
    saveSecret: async (key: string, value: string) => { entries.set(key, value); },
    listSecretKeys: async () => [...entries.keys()],
  };
};

describe("loadRemoteAuthKey", () => {
  it("creates a key once", async () => {
    const store = createStore();
    const key = await loadRemoteAuthKey(store);
    expect(key.byteLength).toBe(32);
    expect(await loadRemoteAuthKey(store)).toEqual(key);
    expect(store.entries.size).toBe(1);
  });

  it("keeps a key it cannot read and goes back to it later", async () => {
    const store = createStore();
    const key = await loadRemoteAuthKey(store);
    const [id] = store.entries.keys();
    store.unreadable.add(id);

    const substitute = await loadRemoteAuthKey(store);
    expect(substitute).not.toEqual(key);
    expect(await loadRemoteAuthKey(store)).toEqual(substitute);
    expect(store.entries.get(id)).toBe(key.toString("base64"));

    store.unreadable.clear();
    expect(await loadRemoteAuthKey(store)).toEqual(key);
  });

  it("keeps a substitute it cannot read either", async () => {
    const store = createStore();
    const createUnreadable = async () => {
      const key = await loadRemoteAuthKey(store);
      const id = [...store.entries.keys()].find((entry) => store.entries.get(entry) === key.toString("base64"))!;
      store.unreadable.add(id);
      return { id, key };
    };
    const first = await createUnreadable();
    const second = await createUnreadable();
    const third = await createUnreadable();
    expect(store.entries.size).toBe(3);

    for (const { id, key } of [third, second, first]) {
      store.unreadable.delete(id);
      expect(await loadRemoteAuthKey(store)).toEqual(key);
    }
    expect(store.entries.size).toBe(3);
  });

  it("prefers the oldest readable key among many", async () => {
    const store = createStore();
    const keys: Array<{ id: string; key: Buffer }> = [];
    for (let index = 0; index < 12; index += 1) {
      const key = await loadRemoteAuthKey(store);
      const id = [...store.entries.keys()].at(-1)!;
      store.unreadable.add(id);
      keys.push({ id, key });
    }
    for (const { id, key } of keys.reverse()) {
      store.unreadable.delete(id);
      expect(await loadRemoteAuthKey(store)).toEqual(key);
    }
  });

  it("uses the substitute when only that one was restored from a backup", async () => {
    const store = createStore();
    const original = await loadRemoteAuthKey(store);
    const [id] = store.entries.keys();
    store.unreadable.add(id);
    const substitute = await loadRemoteAuthKey(store);
    store.entries.delete(id);
    expect(await loadRemoteAuthKey(store)).toEqual(substitute);
    expect(substitute).not.toEqual(original);
  });
});
