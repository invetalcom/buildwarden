import { isUtf8 } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import type { SecretStore } from "@buildwarden/shared";
import { logError, logInfo, logWarn } from "./logger";
import { SecretKeyFile } from "./secret-key-file";

type EncryptedMap = Record<string, string>;

const OS_CIPHERTEXT_PREFIX_BYTES = 3;
const OS_CIPHERTEXT_BLOCK_BYTES = 16;

/**
 * Whether the operating system's encryption may have written this value. Plaintext of older versions is
 * always UTF-8. Ciphertext can be too by chance, but then has Chromium's "v10" or "v11" mark and whole
 * AES-CBC blocks. A plaintext of that exact form is left alone, because re-encrypting ciphertext destroys it.
 */
const mayBeOsCiphertext = (value: Buffer): boolean =>
  !isUtf8(value) || (
    /^v1[01]/.test(value.subarray(0, OS_CIPHERTEXT_PREFIX_BYTES).toString("latin1")) &&
    value.byteLength > OS_CIPHERTEXT_PREFIX_BYTES &&
    (value.byteLength - OS_CIPHERTEXT_PREFIX_BYTES) % OS_CIPHERTEXT_BLOCK_BYTES === 0
  );

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
    try {
      this.encryptPlaintextEntries();
    } catch (error) {
      // The entries stay as they were and readable; providers that need none of them must still work.
      logError("Could not encrypt secrets that were stored without a keyring. They remain unencrypted.", { error });
    }
  }

  private encryptPlaintextEntries(): void {
    const map = this.readMap();
    let count = 0;
    for (const [key, entry] of Object.entries(map)) {
      if (SecretKeyFile.isEntry(entry)) continue;
      const value = Buffer.from(entry, "base64");
      if (mayBeOsCiphertext(value)) continue;
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

  /** An entry that cannot be read is kept, because another key or keyring may still be able to read it. */
  async readSecret(key: string): Promise<string | null> {
    const encrypted = this.readMap()[key];

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
      return null;
    }
  }

  /** Includes entries that cannot be read at the moment. */
  async listSecretKeys(): Promise<string[]> {
    return Object.keys(this.readMap());
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
        throw new Error("The secret key file cannot decrypt this entry.", { cause: error });
      }
    }
    const buffer = Buffer.from(encrypted, "base64");
    if (this.keyringAvailable()) return safeStorage.decryptString(buffer);
    if (mayBeOsCiphertext(buffer)) throw new Error("This entry was encrypted by a keyring that is not available.");
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
