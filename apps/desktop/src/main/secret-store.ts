import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import type { SecretStore } from "@buildwarden/shared";
import { logWarn } from "./logger";

type EncryptedMap = Record<string, string>;

export class ElectronSecretStore implements SecretStore {
  constructor(private readonly filePath: string) {}

  async saveSecret(key: string, value: string): Promise<void> {
    const map = this.readMap();
    map[key] = this.encryptValue(value);
    this.writeMap(map);
  }

  async readSecret(key: string): Promise<string | null> {
    const map = this.readMap();
    const encrypted = map[key];

    if (!encrypted) {
      return null;
    }

    try {
      return this.decryptValue(encrypted);
    } catch (error) {
      logWarn("Ignoring unreadable secret-store entry.", {
        key,
        error,
      });
      delete map[key];
      this.writeMap(map);
      return null;
    }
  }

  async deleteSecret(key: string): Promise<void> {
    const map = this.readMap();
    delete map[key];
    this.writeMap(map);
  }

  /** Returns plaintext entries for an encrypted, user-authorized portable backup. */
  async exportSecrets(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const [key, encrypted] of Object.entries(this.readMap())) {
      try {
        result[key] = this.decryptValue(encrypted);
      } catch (error) {
        logWarn("Skipping unreadable secret-store entry during backup.", { key, error });
      }
    }
    return result;
  }

  /** Writes a destination-machine encrypted secret store without changing the active store. */
  async writeEncryptedCopy(targetFilePath: string, secrets: Readonly<Record<string, string>>): Promise<void> {
    const encrypted: EncryptedMap = {};
    for (const [key, value] of Object.entries(secrets)) {
      encrypted[key] = this.encryptValue(value);
    }
    this.writeMapTo(targetFilePath, encrypted);
  }

  private readMap(): EncryptedMap {
    if (!existsSync(this.filePath)) {
      return {};
    }

    const content = readFileSync(this.filePath, "utf8");
    return content ? (JSON.parse(content) as EncryptedMap) : {};
  }

  private writeMap(map: EncryptedMap): void {
    this.writeMapTo(this.filePath, map);
  }

  private encryptValue(value: string): string {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(value).toString("base64")
      : Buffer.from(value, "utf8").toString("base64");
  }

  private decryptValue(encrypted: string): string {
    const buffer = Buffer.from(encrypted, "base64");
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buffer) : buffer.toString("utf8");
  }

  private writeMapTo(targetFilePath: string, map: EncryptedMap): void {
    mkdirSync(dirname(targetFilePath), { recursive: true });
    const temporaryPath = `${targetFilePath}.tmp`;
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    writeFileSync(temporaryPath, JSON.stringify(map, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, targetFilePath);
  }
}
