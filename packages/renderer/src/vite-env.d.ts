/// <reference types="vite/client" />

declare global {
  interface ImportMetaEnv {
    readonly VITE_APP_VERSION: string;
    readonly VITE_APP_VERSION_DATE: string;
    /** Set only in the `@buildwarden/web` build. */
    readonly VITE_WEB_MODE?: "embedded" | "hosted";
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
