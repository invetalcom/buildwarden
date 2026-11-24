import { isUtf8 } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import type { SecretStore } from "@buildwarden/shared";
import { logInfo, logWarn } from "./logger";
import { SecretKeyFile } from "./secret-key-file";

type EncryptedMap = Record<string, string>;

/** Chromium marks what its OS encryption wrote on Linux; anything else was stored without a keyring. */
const isOsCiphertext = (value: Buffer): boolean =>
  /^v1[01]/.test(value.subarray(0, 3).toString("latin1")) && !isUtf8(value);

/** An entry that another key or keyring may still be able to read, so it must be kept. */
class SecretUnavailableError extends Error {}

export interface SecretStoreOptions {
  /** Protects secrets where the operating system has no keyring. */
  keyFile: SecretKeyFile;
  /** Never ask the keyring: nobody can unlock it on a headless host. */
  ignoreKeyring?: boolean;
}

export class ElectronSecretStore implements SecretStore {
  constructor(private readonly filePath: string, private readonly options: SecretStoreOptions) {}

  describeProtection(): string {
    return this.keyringAvailable() ? "encrypted by the operating system" : `encrypted with ${this.options.keyFile.path}`;
  }

  /** Older versions stored secrets without encryption where no keyring was available. */
  protectPlaintextEntries(): void {
    if (this.keyringAvailable()) return;
    const map = this.readMap();
    let count = 0;
    for (const [key, entry] of Object.entries(map)) {
      if (SecretKeyFile.isEntry(entry)) continue;
      const value = Buffer.from(entry, "base64");
      if (isOsCiphertext(value)) continue;
      map[key] = this.options.keyFile.encrypt(value.toString("utf8"));
      count += 1;
    }
    if (count === 0) return;
    this.writeMap(map);
    logInfo("Encrypted secrets that were stored without a keyring.", { count });
  }

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
      if (error instanceof SecretUnavailableError) return null;
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
    return this.keyringAvailable()
      ? safeStorage.encryptString(value).toString("base64")
      : this.options.keyFile.encrypt(value);
  }

  private decryptValue(encrypted: string): string {
    if (SecretKeyFile.isEntry(encrypted)) {
      try {
        return this.options.keyFile.decrypt(encrypted);
      } catch (error) {
        throw new SecretUnavailableError("The secret key file cannot decrypt this entry.", { cause: error });
      }
    }
    const buffer = Buffer.from(encrypted, "base64");
    if (this.keyringAvailable()) return safeStorage.decryptString(buffer);
    if (isOsCiphertext(buffer)) throw new SecretUnavailableError("This entry was encrypted by a keyring that is not available.");
    return buffer.toString("utf8");
  }

  private keyringAvailable(): boolean {
    return this.options.ignoreKeyring !== true && safeStorage.isEncryptionAvailable();
  }

  private writeMapTo(targetFilePath: string, map: EncryptedMap): void {
    mkdirSync(dirname(targetFilePath), { recursive: true });
    const temporaryPath = `${targetFilePath}.tmp`;
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    writeFileSync(temporaryPath, JSON.stringify(map, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, targetFilePath);
  }
}
