import { lazy } from "react";

/**
 * The two shell chunks, resolved lazily so a phone never downloads the desktop bundle (CodeMirror,
 * xterm, mermaid, diff rendering) and the desktop bundle never carries the mobile UI.
 *
 * They live here rather than in `main.tsx` so the entry module stays free of component exports.
 */
export const MobileShellEntry = lazy(() => import("../mobile/MobileWebApp"));
export const DesktopShellEntry = lazy(() => import("../desktop-shell"));
