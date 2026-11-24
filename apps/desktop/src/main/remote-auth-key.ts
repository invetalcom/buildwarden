import { randomBytes } from "node:crypto";
import type { SecretStore } from "@buildwarden/shared";

const AUTH_KEY = "app:remote-access-auth-key:v1";
/** Used while the first key is stored but cannot be read, for example without the desktop's keyring. */
const SUBSTITUTE_AUTH_KEY = "app:remote-access-auth-key:v1:substitute";
const AUTH_KEY_BYTES = 32;

export interface RemoteAuthKeyStore extends Pick<SecretStore, "readSecret" | "saveSecret"> {
  hasSecret(key: string): Promise<boolean>;
}

/**
 * The key that paired devices are checked with. One that cannot be read right now is never replaced: the
 * devices paired with it work again once it can be, and remote access stays usable until then.
 */
export const loadRemoteAuthKey = async (store: RemoteAuthKeyStore): Promise<Buffer> => {
  for (const id of [AUTH_KEY, SUBSTITUTE_AUTH_KEY]) {
    const key = Buffer.from(await store.readSecret(id) ?? "", "base64");
    if (key.byteLength >= AUTH_KEY_BYTES) return key;
  }
  const key = randomBytes(AUTH_KEY_BYTES);
  await store.saveSecret(await store.hasSecret(AUTH_KEY) ? SUBSTITUTE_AUTH_KEY : AUTH_KEY, key.toString("base64"));
  return key;
};
