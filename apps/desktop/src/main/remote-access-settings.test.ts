import {
  APP_SETTING_KEYS,
  DEFAULT_REMOTE_ACCESS_ENABLED,
  normalizeRemoteAccessWebOrigin,
  parseRemoteAccessEnabledSetting,
  parseRemoteAccessWebOriginsSetting,
  serializeRemoteAccessWebOriginsSetting,
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

  it("normalizes exact hosted origins and rejects unsafe origin syntax", () => {
    expect(normalizeRemoteAccessWebOrigin("https://buildwarden.example.com/")).toBe("https://buildwarden.example.com");
    expect(normalizeRemoteAccessWebOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeRemoteAccessWebOrigin("http://buildwarden.example.com")).toBeNull();
    expect(normalizeRemoteAccessWebOrigin("https://*.example.com")).toBeNull();
    expect(normalizeRemoteAccessWebOrigin("https://buildwarden.example.com/path")).toBeNull();
    const stored = serializeRemoteAccessWebOriginsSetting([
      "https://buildwarden.example.com/",
      "https://buildwarden.example.com",
      "https://preview.example.com",
    ]);
    expect(parseRemoteAccessWebOriginsSetting(stored)).toEqual([
      "https://buildwarden.example.com",
      "https://preview.example.com",
    ]);
  });
});
