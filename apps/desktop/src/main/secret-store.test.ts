import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value: Buffer) => {
      const decoded = value.toString("utf8");
      if (!decoded.startsWith("encrypted:")) throw new Error("invalid ciphertext");
      return decoded.slice("encrypted:".length);
    },
  },
}));

import { ElectronSecretStore } from "./secret-store";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("ElectronSecretStore portable copies", () => {
  it("exports plaintext only in memory and re-encrypts a copy for the destination store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buildwarden-secret-store-"));
    directories.push(directory);
    const source = new ElectronSecretStore(join(directory, "source.json"));
    await source.saveSecret("provider:test", "api-key");
    await source.saveSecret("project:forge-token:project-1", "github-token");

    const exported = await source.exportSecrets();
    expect(exported).toEqual({
      "provider:test": "api-key",
      "project:forge-token:project-1": "github-token",
    });

    const copyPath = join(directory, "copy.json");
    await source.writeEncryptedCopy(copyPath, exported);
    const restored = new ElectronSecretStore(copyPath);
    expect(await restored.readSecret("provider:test")).toBe("api-key");
    expect(await restored.readSecret("project:forge-token:project-1")).toBe("github-token");
  });
});

