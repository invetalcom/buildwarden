import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import { applyDesignSchemeToDocument, readCachedBrowserDesignScheme } from "@buildwarden/renderer/design-scheme";
import { selectShell } from "./shell/select-shell";
import { DesktopShellEntry, MobileShellEntry } from "./shell/shell-entries";

/** One HTML entry, two UIs; the shell is picked before React mounts. */
const shell = selectShell(window);
document.documentElement.dataset.shell = shell;
applyDesignSchemeToDocument(readCachedBrowserDesignScheme(), false);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={<div className="boot-splash" aria-label="Loading BuildWarden" />}>
      {shell === "mobile" ? <MobileShellEntry /> : <DesktopShellEntry />}
    </Suspense>
  </React.StrictMode>,
);
