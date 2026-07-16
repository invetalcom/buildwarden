/** Injected at build/dev time by Vite (`electron.vite.config.ts` and `apps/web/vite.config.ts`). */
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION ?? "0.0.0";
export const APP_VERSION_DATE: string = import.meta.env.VITE_APP_VERSION_DATE ?? "—";
