import { app } from "electron";
import { join } from "node:path";
import { enableCompileCacheSafely, flushCompileCacheSafely } from "./compile-cache";
import { bufferEarlyOpenUrls } from "./early-open-url";

// One process per data directory. A second launch (a `buildwarden://` link on Windows/Linux, or the
// user starting the app again) hands its arguments to the running app through `second-instance`
// and exits before it opens the database. Development builds use a different userData directory,
// so a dev build and the installed app still run side by side.
const primaryInstance = app.requestSingleInstanceLock();

if (!primaryInstance) {
  app.quit();
} else {
  // A macOS cold-start link can arrive during the import below; index.ts takes these over.
  bufferEarlyOpenUrls(app);
  try {
    const root = join(app.getPath("userData"), "v8-cache");
    // Development chunks change without an app version bump; rotate them weekly.
    const name = app.isPackaged ? `app-${app.getVersion().replace(/[^a-zA-Z0-9.-]/g, "_")}`
      : `dev-${Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000))}`;
    if (enableCompileCacheSafely(join(root, name))) {
      app.once("browser-window-created", (_event, window) => {
        window.once("ready-to-show", () => {
          void import("./compile-cache-cleanup").then(({ pruneCompileCaches }) => pruneCompileCaches(root, name)).catch(() => {});
        });
      });
    }
  } catch {
    // Even a failure to resolve the optional cache directory must not stop startup.
  }

  // Keep this dynamic boundary: static application imports compile before caching
  // is enabled. Await it so Electron's pre-ready initialization retains its order.
  await import("./index");
  setImmediate(flushCompileCacheSafely).unref();
  app.on("will-quit", flushCompileCacheSafely);
}
