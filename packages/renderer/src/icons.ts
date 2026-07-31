/**
 * Small presentational marks shared between the desktop renderer UI and the mobile web UI
 * (`apps/web/src/mobile`). Kept out of `./logic` (which is JSX-free by contract) and out of `./index.ts`
 * (which pulls in the whole desktop app), so the mobile bundle can import a single icon.
 *
 * Consumed as `@buildwarden/renderer/icons`. Anything exported here must style itself only through the
 * `className` its caller passes: the mobile Tailwind build scans `apps/web/src` only, so utility classes
 * written inside these components would never be generated for that bundle.
 */

export { ProviderBrandIcon } from "./components/app/provider-brand-icons";
