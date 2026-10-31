import { app } from "electron";
import { join } from "node:path";
import { enableCompileCacheSafely, flushCompileCacheSafely } from "./compile-cache";

try {
  enableCompileCacheSafely(join(app.getPath("userData"), "v8-cache"));
} catch {
  // Even a failure to resolve the optional cache directory must not stop startup.
}

// Keep this dynamic boundary: static application imports compile before caching
// is enabled. Await it so Electron's pre-ready initialization retains its order.
await import("./index");
setImmediate(flushCompileCacheSafely).unref();
app.on("will-quit", flushCompileCacheSafely);
