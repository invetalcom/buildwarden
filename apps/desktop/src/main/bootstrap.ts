import { app, protocol } from "electron";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { enableCompileCacheSafely, flushCompileCacheSafely } from "./compile-cache";
import { bufferEarlyOpenUrls } from "./early-open-url";
import { currentLaunch, headlessRestartArgs } from "./headless/launch";
import { registerRendererSchemePrivileges } from "./renderer-protocol";

/** Chromium reads its display platform before this file runs, so the host replaces itself to choose it. */
const restartWithoutDisplay = (): void => {
  const args = headlessRestartArgs(process.argv, process.platform);
  if (!args) return;
  // Keeps the process id, which service managers and shells watch.
  if (process.execve) process.execve(process.execPath, [process.execPath, ...args], process.env);
  process.exit(spawnSync(process.execPath, args, { stdio: "inherit" }).status ?? 1);
};

const exitUnlessHeadlessSupported = (): void => {
  if (process.platform !== "win32") return;
  console.error("The headless host runs on Linux and macOS.");
  process.exit(1);
};

if (currentLaunch.kind === "command") {
  const { runCommandLineProcess } = await import("./headless/command-line-process");
  process.exit(await runCommandLineProcess(currentLaunch.args, { dataDir: app.getPath("userData"), version: app.getVersion() }));
}
if (currentLaunch.kind === "serve") {
  exitUnlessHeadlessSupported();
  restartWithoutDisplay();
  app.dock?.hide();
}

// One process per data directory. A second launch (a `buildwarden://` link on Windows/Linux, or the
// user starting the app again) hands its arguments to the running app through `second-instance`
// and exits before it opens the database. Development builds use a different userData directory,
// so a dev build and the installed app still run side by side.
const primaryInstance = app.requestSingleInstanceLock();

if (!primaryInstance) {
  if (currentLaunch.kind === "serve") {
    console.error("BuildWarden is already running for this data directory.");
    process.exit(1);
  }
  app.quit();
} else {
  // A macOS cold-start link can arrive during the import below; index.ts takes these over.
  bufferEarlyOpenUrls(app);
  // Scheme privileges, including the renderer's V8 code cache, only apply when set before ready.
  registerRendererSchemePrivileges(protocol);
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
