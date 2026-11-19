import type { App } from "electron";

/**
 * macOS delivers a cold-start `buildwarden://` link through `open-url`, possibly while bootstrap.ts
 * is still importing the main module. Electron does not replay the event for listeners attached
 * later, so bootstrap holds the URLs here until index.ts takes them over.
 */
type OpenUrlListener = (event: { preventDefault: () => void }, url: string) => void;
type OpenUrlEmitter = Pick<App, "on" | "removeListener">;

let buffered: string[] = [];
let listener: OpenUrlListener | null = null;

export const bufferEarlyOpenUrls = (app: OpenUrlEmitter): void => {
  if (listener) return;
  listener = (event, url) => {
    event.preventDefault();
    buffered.push(url);
  };
  app.on("open-url", listener);
};

/** Stops buffering and returns what arrived so far, oldest first. */
export const takeEarlyOpenUrls = (app: OpenUrlEmitter): string[] => {
  if (listener) app.removeListener("open-url", listener);
  listener = null;
  const urls = buffered;
  buffered = [];
  return urls;
};
