import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Points at a key kept elsewhere, for example a systemd credential. */
export const SECRET_KEY_FILE_ENV = "BUILDWARDEN_SECRET_KEY_FILE";
/** A colon never occurs in the base64 that other entries hold, so the prefix is unambiguous. */
const ENTRY_PREFIX = "bwkey1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Encrypts secrets with a local key when the operating system offers no keyring. */
export class SecretKeyFile {
  private key: Buffer | null = null;

  constructor(
    readonly path: string,
    /** An operator-provided key must exist; only BuildWarden's own one is created on demand. */
    private readonly createWhenMissing: boolean,
  ) {}

  static forDataDirectory(dataDir: string, env: NodeJS.ProcessEnv = process.env): SecretKeyFile {
    const configured = env[SECRET_KEY_FILE_ENV]?.trim();
    return configured ? new SecretKeyFile(configured, false) : new SecretKeyFile(join(dataDir, "secret.key"), true);
  }

  static isEntry(value: string): boolean {
    return value.startsWith(ENTRY_PREFIX);
  }

  encrypt(value: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.loadKey(), iv, { authTagLength: TAG_BYTES });
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ENTRY_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  }

  decrypt(entry: string): string {
    const data = Buffer.from(entry.slice(ENTRY_PREFIX.length), "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.loadKey(), data.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  }

  private loadKey(): Buffer {
    if (this.key) return this.key;
    if (!existsSync(this.path)) {
      if (!this.createWhenMissing) throw new Error(`The secret key file does not exist: ${this.path}`);
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, `${randomBytes(KEY_BYTES).toString("base64")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    const key = Buffer.from(readFileSync(this.path, "utf8").trim(), "base64");
    if (key.byteLength !== KEY_BYTES) {
      throw new Error(`The secret key file must contain ${String(KEY_BYTES)} base64-encoded bytes: ${this.path}`);
    }
    this.key = key;
    return key;
  }
}
