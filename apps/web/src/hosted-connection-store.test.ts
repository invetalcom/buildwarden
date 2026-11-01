import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteAccessSession } from "@buildwarden/shared";
import { readHostedConnection, readInstanceConnections, removeInstanceConnection, saveHostedConnection, saveInstanceConnection } from "./hosted-connection-store";

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); });
afterEach(() => { vi.unstubAllGlobals(); });
const session: RemoteAccessSession = { id: "session", label: "Web", scopes: ["state:read"], createdAt: "2026-01-01", expiresAt: "2027-01-01", lastUsedAt: "2026-01-01", revokedAt: null, clientOrigin: "https://web.example" };
const legacy = { hostOrigin: "https://work.ts.net", token: "existing-token", session };

describe("instance registry persistence", () => {
  it("atomically migrates the old active connection exactly once, preserving its credentials", async () => {
    await saveHostedConnection(legacy);
    const [first, concurrent] = await Promise.all([readInstanceConnections(), readInstanceConnections()]);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ ...legacy, name: "work.ts.net" });
    expect(concurrent).toEqual(first);
    expect(await readInstanceConnections()).toEqual(first);
    expect(await readHostedConnection()).toBeNull();
  });
  it("saves duplicate custom names independently, persists renames, and removes only the target", async () => {
    await saveInstanceConnection({ ...legacy, id: "a", name: "Work" });
    await saveInstanceConnection({ ...legacy, hostOrigin: "https://other.ts.net", id: "b", name: "Work" });
    await saveInstanceConnection({ ...legacy, id: "a", name: "Laptop" });
    expect((await readInstanceConnections()).map(({ id, name }) => ({ id, name }))).toEqual([{ id: "a", name: "Laptop" }, { id: "b", name: "Work" }]);
    await removeInstanceConnection("a");
    expect((await readInstanceConnections()).map(({ id }) => id)).toEqual(["b"]);
  });
});
