import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  APP_SETTING_KEYS,
  buildNetworkProxyRuntimeConfig,
  type NetworkProxyRuntimeConfig,
  type NetworkProxySettingsInput,
  type NetworkProxySettingsSnapshot,
  parseCouncilSettings,
  parseHomeLayout,
  parseNetworkProxySettings,
  parseProjectForgePrMonitorIntervalMinutes,
  parseProjectForgePrMonitorSettingsSetting,
  parseProviderCliUpdateSettings,
  parseWorkspaceSetupSettings,
  serializeHomeLayout,
  serializeProjectForgePrMonitorSettingsSetting,
  serializeProviderCliUpdateSettings,
} from "@buildwarden/shared";
import { hostDefaultTerminalShell, terminalShells } from "../terminal-shells";
import { AppService } from "./app-service";
import { NETWORK_PROXY_SECRET_KEY } from "./app-service-constants";

/** Reads and changes app settings. */
export class SettingsService extends AppService<"providerRuntime" | "runForge" | "titles"> {
  setProjectForgePrMonitorInterval(projectId: string, intervalMinutes: number): void {
    const settings = parseProjectForgePrMonitorSettingsSetting(
      this.db.getSettings()[APP_SETTING_KEYS.projectForgePrMonitorSettings],
    );
    const normalized = parseProjectForgePrMonitorIntervalMinutes(intervalMinutes);
    if (normalized > 0) {
      settings[projectId] = { intervalMinutes: normalized };
    } else {
      delete settings[projectId];
    }
    const serialized = serializeProjectForgePrMonitorSettingsSetting(settings);
    if (serialized === "{}") {
      this.db.deleteSetting(APP_SETTING_KEYS.projectForgePrMonitorSettings);
    } else {
      this.db.setSetting(APP_SETTING_KEYS.projectForgePrMonitorSettings, serialized);
    }
    for (const run of this.db.listRunsForProject(projectId, true)) this.services.runForge.runForgeViewRefreshedAt.delete(run.id);
    this.services.runForge.projectForgeDiscoveryRetryAt.delete(projectId);
    this.services.runForge.runForgeDiscovery?.refresh(projectId, true);
  }

  async getNetworkProxySettings(): Promise<NetworkProxySettingsSnapshot> {
    const settings = parseNetworkProxySettings(this.db.getSettings()[APP_SETTING_KEYS.networkProxyConfig]);
    const hasPassword = (await this.secrets.readSecret(NETWORK_PROXY_SECRET_KEY)) != null;
    return {
      ...settings,
      hasPassword,
    };
  }

  async saveNetworkProxySettings(input: NetworkProxySettingsInput): Promise<NetworkProxySettingsSnapshot> {
    const host = input.host.trim();
    const port = input.port.trim();
    const username = input.username.trim();
    const enabled = input.enabled === true;
    const protocol = input.protocol;

    if (enabled) {
      if (!host) {
        throw new Error("Proxy host is required when the network proxy is enabled.");
      }
      if (!port) {
        throw new Error("Proxy port is required when the network proxy is enabled.");
      }
      const portNumber = Number(port);
      if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
        throw new Error("Proxy port must be a whole number between 1 and 65535.");
      }
      if (/\s/.test(host)) {
        throw new Error("Proxy host cannot contain spaces.");
      }
      if (username.includes("\n") || username.includes("\r")) {
        throw new Error("Proxy username cannot contain line breaks.");
      }
    }

    this.db.setSetting(
      APP_SETTING_KEYS.networkProxyConfig,
      JSON.stringify({
        enabled,
        protocol,
        host,
        port,
        username,
      }),
    );

    if (input.clearSavedPassword === true) {
      await this.secrets.deleteSecret(NETWORK_PROXY_SECRET_KEY);
    } else if (typeof input.password === "string") {
      if (input.password.length > 0) {
        await this.secrets.saveSecret(NETWORK_PROXY_SECRET_KEY, input.password);
      }
    }

    return this.getNetworkProxySettings();
  }

  async setAppSetting(key: string, value: string): Promise<void> {
    if (key === APP_SETTING_KEYS.designScheme) {
      // The user chose this design themselves, so no agent change is left to undo.
      this.db.setSetting(APP_SETTING_KEYS.designSchemeBeforeAgent, "");
      this.db.setSetting(APP_SETTING_KEYS.designSchemePrevious, "");
    }
    if (key === APP_SETTING_KEYS.homeLayout) {
      // Stored in full and checked, so a damaged value never reaches the page. The user arranged
      // Home themselves, so an agent's undo must not take this back.
      this.db.setSetting(key, serializeHomeLayout(parseHomeLayout(value)));
      this.db.setSetting(APP_SETTING_KEYS.homeLayoutPrevious, "");
      return;
    }
    if (key === APP_SETTING_KEYS.sessionTitlesEnabled) {
      if (value !== "true" && value !== "false") throw new Error("Title generation must be enabled or disabled.");
      this.db.setSetting(key, value);
      if (value === "false") this.services.titles.sessionTitles.cancelAll();
      this.events.publish("appSettingsChanged", undefined);
      return;
    }
    if (key === APP_SETTING_KEYS.sessionTitleModelId) {
      value = value.trim();
      if (value && !this.db.getModel(value).enabled) throw new Error("Choose an enabled title model.");
    }
    if (key === APP_SETTING_KEYS.sessionTitleInstructions && value.length > 2000) throw new Error("Title instructions must be at most 2000 characters.");
    if (key === APP_SETTING_KEYS.terminalDefaultShell && !terminalShells().some((shell) => shell === value)) {
      throw new Error("This terminal shell is not supported on the host.");
    }
    if (key === APP_SETTING_KEYS.council) {
      this.db.setSetting(key, JSON.stringify(parseCouncilSettings(value)));
      return;
    }
    if (key === APP_SETTING_KEYS.providerCliUpdates) {
      this.db.setSetting(key, serializeProviderCliUpdateSettings(parseProviderCliUpdateSettings(value)));
      this.services.providerRuntime.providerCliUpdates.applySettings();
      return;
    }
    if (key === APP_SETTING_KEYS.worktreeRootOverride) {
      const trimmed = value.trim();
      if (!trimmed) {
        this.db.setSetting(key, "");
        return;
      }
      if (!isAbsolute(trimmed)) {
        throw new Error("Custom managed workspace folder must be an absolute path.");
      }
      if (existsSync(trimmed) && !statSync(trimmed).isDirectory()) {
        throw new Error("Custom managed workspace folder must point to a directory.");
      }
      this.db.setSetting(key, trimmed);
      return;
    }
    this.db.setSetting(key, value);
  }

  async getTerminalSettings() {
    return { defaultShell: hostDefaultTerminalShell(this.db.getTerminalDefaultShell()), shells: terminalShells() };
  }

  getWorkspaceSetupProfile(projectId: string) {
    const setup = parseWorkspaceSetupSettings(this.db.getSettings()[APP_SETTING_KEYS.workspaceSetupProfiles])[projectId];
    return setup?.profiles.find((profile) => profile.id === setup.activeProfileId);
  }

  isSettingEnabled(key: string, defaultValue: boolean): boolean {
    const value = this.db.getSettings()[key];
    if (value == null) {
      return defaultValue;
    }

    return value === "true";
  }

  async resolveNetworkProxyRuntimeConfig(): Promise<NetworkProxyRuntimeConfig | undefined> {
    const settings = parseNetworkProxySettings(this.db.getSettings()[APP_SETTING_KEYS.networkProxyConfig]);
    const password = await this.secrets.readSecret(NETWORK_PROXY_SECRET_KEY);
    return buildNetworkProxyRuntimeConfig(settings, password ?? undefined);
  }
}
