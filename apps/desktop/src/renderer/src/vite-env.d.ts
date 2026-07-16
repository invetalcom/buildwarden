/// <reference types="vite/client" />

import type { DesktopApi } from "@buildwarden/shared";

declare global {
  interface Window {
    buildwarden: DesktopApi;
  }
}

export {};
