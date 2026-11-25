import { randomBytes } from "node:crypto";
import type { SecretStore } from "@buildwarden/shared";

const AUTH_KEY = "app:remote-access-auth-key:v1";
/** Numbered; used while every other stored key is unreadable, for example without the desktop's keyring. */
const SUBSTITUTE_PREFIX = `${AUTH_KEY}:substitute-`;
const AUTH_KEY_BYTES = 32;

export interface RemoteAuthKeyStore extends Pick<SecretStore, "readSecret" | "saveSecret"> {
  listSecretKeys(): Promise<string[]>;
}

/**
 * The key that paired devices are checked with. One that cannot be read right now is never replaced: the
 * devices paired with it work again once it can be, and remote access stays usable until then.
 */
export const loadRemoteAuthKey = async (store: RemoteAuthKeyStore): Promise<Buffer> => {
  // Sorting puts the first key first, so it is used again as soon as it can be read.
  const stored = (await store.listSecretKeys()).filter((id) => id === AUTH_KEY || id.startsWith(SUBSTITUTE_PREFIX)).sort();
  for (const id of stored) {
    const key = Buffer.from(await store.readSecret(id) ?? "", "base64");
    if (key.byteLength >= AUTH_KEY_BYTES) return key;
  }
  const key = randomBytes(AUTH_KEY_BYTES);
  let target = AUTH_KEY;
  for (let number = 1; stored.includes(target); number += 1) target = `${SUBSTITUTE_PREFIX}${String(number)}`;
  await store.saveSecret(target, key.toString("base64"));
  return key;
};
