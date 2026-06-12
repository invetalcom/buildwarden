/// <reference types="vite/client" />

import type { DesktopApi } from "@buildwarden/shared";

declare global {
  interface ImportMetaEnv {
    readonly VITE_APP_VERSION: string;
    readonly VITE_APP_VERSION_DATE: string;
    /** Set only in the `@buildwarden/web` Vite build (browser preview). */
    readonly VITE_BROWSER_PREVIEW?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    buildwarden: DesktopApi;
  }
}

export {};
