import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const keyring = vi.hoisted(() => ({ available: true }));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => keyring.available,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value: Buffer) => {
      const decoded = value.toString("utf8");
      if (!decoded.startsWith("encrypted:")) throw new Error("invalid ciphertext");
      return decoded.slice("encrypted:".length);
    },
  },
}));

import { SecretKeyFile } from "./secret-key-file";
import { ElectronSecretStore } from "./secret-store";

const directories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "buildwarden-secret-store-"));
  directories.push(directory);
  return directory;
};
const createStore = (directory: string, fileName = "secrets.json", ignoreKeyring = false) =>
  new ElectronSecretStore(join(directory, fileName), { keyFile: SecretKeyFile.forDataDirectory(directory, {}), ignoreKeyring });

afterEach(async () => {
  keyring.available = true;
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("ElectronSecretStore portable copies", () => {
  it("exports plaintext only in memory and re-encrypts a copy for the destination store", async () => {
    const directory = await temporaryDirectory();
    const source = createStore(directory, "source.json");
    await source.saveSecret("provider:test", "api-key");
    await source.saveSecret("project:forge-token:project-1", "github-token");

    const exported = await source.exportSecrets();
    expect(exported).toEqual({
      "provider:test": "api-key",
      "project:forge-token:project-1": "github-token",
    });

    const copyPath = join(directory, "copy.json");
    await source.writeEncryptedCopy(copyPath, exported);
    const restored = createStore(directory, "copy.json");
    expect(await restored.readSecret("provider:test")).toBe("api-key");
    expect(await restored.readSecret("project:forge-token:project-1")).toBe("github-token");
  });
});

describe("ElectronSecretStore without a keyring", () => {
  const readEntries = async (directory: string) =>
    JSON.parse(await readFile(join(directory, "secrets.json"), "utf8")) as Record<string, string>;

  it("encrypts with the key file, which a later keyring does not break", async () => {
    keyring.available = false;
    const directory = await temporaryDirectory();
    await createStore(directory).saveSecret("provider:test", "api-key");

    const entry = (await readEntries(directory))["provider:test"];
    expect(SecretKeyFile.isEntry(entry)).toBe(true);
    expect(Buffer.from(entry.split(":")[1], "base64").toString("utf8")).not.toContain("api-key");
    expect(await createStore(directory).readSecret("provider:test")).toBe("api-key");
    keyring.available = true;
    expect(await createStore(directory).readSecret("provider:test")).toBe("api-key");
  });

  it("re-encrypts secrets an older version stored as plain base64", async () => {
    keyring.available = false;
    const directory = await temporaryDirectory();
    const osCiphertext = Buffer.concat([Buffer.from("v11"), Buffer.from([0xff, 0xfe, 0x80, 0x81])]).toString("base64");
    await writeFile(join(directory, "secrets.json"), JSON.stringify({
      old: Buffer.from("api-key").toString("base64"),
      fromKeyring: osCiphertext,
    }));
    const store = createStore(directory);
    store.protectPlaintextEntries();

    const entries = await readEntries(directory);
    expect(SecretKeyFile.isEntry(entries.old)).toBe(true);
    expect(entries.fromKeyring).toBe(osCiphertext);
    expect(await store.readSecret("old")).toBe("api-key");
  });

  it("never takes keyring ciphertext for plaintext, even when its bytes are valid text", async () => {
    keyring.available = false;
    const directory = await temporaryDirectory();
    const ciphertext = {
      oneBlock: Buffer.from(`v10${"a".repeat(16)}`).toString("base64"),
      twoBlocks: Buffer.from(`v11${"a".repeat(32)}`).toString("base64"),
      otherFormat: Buffer.from([0x01, 0x00, 0xff, 0xfe]).toString("base64"),
    };
    await writeFile(join(directory, "secrets.json"), JSON.stringify({ ...ciphertext, plain: Buffer.from("v10-token").toString("base64") }));
    const store = createStore(directory);
    store.protectPlaintextEntries();

    expect(await readEntries(directory)).toMatchObject(ciphertext);
    for (const key of Object.keys(ciphertext)) expect(await store.readSecret(key)).toBeNull();
    expect(await store.readSecret("plain")).toBe("v10-token");
    expect(await readEntries(directory)).toMatchObject(ciphertext);
  });

  it("keeps entries it cannot read, because the keyring or key file may come back", async () => {
    keyring.available = false;
    const directory = await temporaryDirectory();
    const osCiphertext = Buffer.concat([Buffer.from("v11"), Buffer.from([0xff, 0xfe, 0x80, 0x81])]).toString("base64");
    const store = createStore(directory);
    await store.saveSecret("other", "value");
    const entries = { ...(await readEntries(directory)), fromKeyring: osCiphertext };
    await writeFile(join(directory, "secrets.json"), JSON.stringify(entries));
    await rm(join(directory, "secret.key"));

    const reopened = createStore(directory);
    expect(await reopened.readSecret("fromKeyring")).toBeNull();
    expect(await reopened.readSecret("other")).toBeNull();
    expect(await readEntries(directory)).toEqual(entries);
  });

  it("does not use an available keyring on a headless host", async () => {
    const directory = await temporaryDirectory();
    await createStore(directory, "secrets.json", true).saveSecret("provider:test", "api-key");
    expect(SecretKeyFile.isEntry((await readEntries(directory))["provider:test"])).toBe(true);
  });

  it("never creates a key file the operator configured", async () => {
    keyring.available = false;
    const directory = await temporaryDirectory();
    const keyFile = SecretKeyFile.forDataDirectory(directory, { BUILDWARDEN_SECRET_KEY_FILE: join(directory, "missing.key") });
    const store = new ElectronSecretStore(join(directory, "secrets.json"), { keyFile });
    await expect(store.saveSecret("provider:test", "api-key")).rejects.toThrow("does not exist");
  });
});

