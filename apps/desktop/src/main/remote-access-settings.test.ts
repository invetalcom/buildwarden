import {
  APP_SETTING_KEYS,
  DEFAULT_REMOTE_ACCESS_ENABLED,
  parseRemoteAccessEnabledSetting,
} from "@buildwarden/shared";
import { describe, expect, it } from "vitest";

describe("remote access baseline", () => {
  it("uses an additive setting key and remains disabled for existing databases", () => {
    const existingSettings: Record<string, string> = {};

    expect(APP_SETTING_KEYS.remoteAccessEnabled).toBe("remoteAccess.enabled");
    expect(DEFAULT_REMOTE_ACCESS_ENABLED).toBe(false);
    expect(parseRemoteAccessEnabledSetting(existingSettings[APP_SETTING_KEYS.remoteAccessEnabled])).toBe(false);
  });

  it("requires the explicit persisted true value", () => {
    expect(parseRemoteAccessEnabledSetting("true")).toBe(true);
    expect(parseRemoteAccessEnabledSetting("false")).toBe(false);
    expect(parseRemoteAccessEnabledSetting("TRUE")).toBe(false);
    expect(parseRemoteAccessEnabledSetting("1")).toBe(false);
    expect(parseRemoteAccessEnabledSetting(null)).toBe(false);
  });
});
