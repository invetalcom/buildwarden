import { RemoteWebApp } from "./RemoteWebApp";
import "@buildwarden/renderer/styles.css";

/**
 * Lazy entry for the desktop UI. Keeping the stylesheet import here (rather than in `main.tsx`)
 * keeps the desktop renderer CSS out of the mobile chunk.
 */
export default RemoteWebApp;
