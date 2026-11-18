import { resolve } from "node:path";
import {
  DEEP_LINK_SCHEME,
  DEV_DEEP_LINK_SCHEME,
  findDeepLinkInArgv,
  parseDeepLinkUrl,
  type DeepLinkOpenedPayload,
} from "@buildwarden/shared";

export const deepLinkSchemeFor = (isPackaged: boolean): string => (isPackaged ? DEEP_LINK_SCHEME : DEV_DEEP_LINK_SCHEME);

interface DeepLinkHandlerOptions {
  scheme: string;
  /** Brings the main window forward. Must tolerate being called before the app is ready. */
  focusWindow: () => void;
  /** Tells a loaded renderer that a link is waiting; the renderer pulls it with {@link DeepLinkHandler.consumePending}. */
  notifyRenderer: () => void;
  log?: (message: string, metadata: Record<string, unknown>) => void;
}

/**
 * Holds the most recent link the OS handed to the app until the renderer collects it.
 *
 * Links arrive at cold start (process arguments, or `open-url` before the window exists) and while
 * running (`second-instance`, `open-url`). One pull path for both avoids racing a push against
 * React subscribing: main stores the link and pings, and the renderer always pulls, both on mount
 * and on every ping. Only the newest link is kept; an older one would open a page the user already
 * moved past.
 */
export class DeepLinkHandler {
  private pending: DeepLinkOpenedPayload | null = null;

  constructor(private readonly options: DeepLinkHandlerOptions) {}

  get scheme(): string {
    return this.options.scheme;
  }

  /** Returns true when `url` is a link for this app; anything else is left to the caller. */
  handleUrl(url: string): boolean {
    const target = parseDeepLinkUrl(url, { schemes: [this.options.scheme] });
    if (!target) return false;
    this.pending = { target, url };
    this.options.log?.("Received deep link.", { kind: target.kind });
    this.options.focusWindow();
    this.options.notifyRenderer();
    return true;
  }

  /** Windows and Linux pass the link as a process argument, at cold start and to `second-instance`. */
  handleArgv(argv: readonly string[]): boolean {
    const found = findDeepLinkInArgv(argv, [this.options.scheme]);
    return found ? this.handleUrl(found.url) : false;
  }

  consumePending(): DeepLinkOpenedPayload | null {
    const pending = this.pending;
    this.pending = null;
    return pending;
  }
}

interface ProtocolClientApp {
  isPackaged: boolean;
  setAsDefaultProtocolClient(protocol: string, path?: string, args?: string[]): boolean;
}

/**
 * Registers the app as the OS handler for its scheme. Packaged builds also declare the scheme in
 * their installer metadata; runtime registration covers portable builds and development. A
 * development Electron runs the app by path, so that path is registered along with the executable.
 */
export const registerDeepLinkProtocol = (
  app: ProtocolClientApp,
  scheme: string,
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
): boolean => {
  if (app.isPackaged) return app.setAsDefaultProtocolClient(scheme);
  const appPath = argv.slice(1).find((arg) => !arg.startsWith("-"));
  if (!appPath || appPath.includes("://")) return false;
  return app.setAsDefaultProtocolClient(scheme, execPath, [resolve(appPath)]);
};
