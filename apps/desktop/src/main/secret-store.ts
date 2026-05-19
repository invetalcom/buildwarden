import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import type { SecretStore } from "@easycode/shared";

type EncryptedMap = Record<string, string>;

export class ElectronSecretStore implements SecretStore {
  constructor(private readonly filePath: string) {}

  async saveSecret(key: string, value: string): Promise<void> {
    const map = this.readMap();
    const encrypted = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(value).toString("base64")
      : Buffer.from(value, "utf8").toString("base64");
    map[key] = encrypted;
    this.writeMap(map);
  }

  async readSecret(key: string): Promise<string | null> {
    const map = this.readMap();
    const encrypted = map[key];

    if (!encrypted) {
      return null;
    }

    const buffer = Buffer.from(encrypted, "base64");
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buffer) : buffer.toString("utf8");
  }

  async deleteSecret(key: string): Promise<void> {
    const map = this.readMap();
    delete map[key];
    this.writeMap(map);
  }

  private readMap(): EncryptedMap {
    if (!existsSync(this.filePath)) {
      return {};
    }

    const content = readFileSync(this.filePath, "utf8");
    return content ? (JSON.parse(content) as EncryptedMap) : {};
  }

  private writeMap(map: EncryptedMap): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(map, null, 2), "utf8");
  }
}
