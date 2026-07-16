import type { RunBrowserBounds } from "@buildwarden/shared";

const BLOCKING_OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  "[data-radix-popper-content-wrapper]",
  "[data-native-surface-occluder]",
].join(",");

const manualOccluders = new Set<string>();
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

const isVisibleElement = (element: Element): boolean => {
  const html = element as HTMLElement;
  const style = window.getComputedStyle(html);
  const bounds = html.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
};

const notify = (): void => {
  for (const listener of listeners) listener();
};

const startObserving = (): void => {
  if (observer || typeof MutationObserver === "undefined") return;
  observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "open", "aria-hidden"],
  });
  window.addEventListener("focus", notify);
  window.addEventListener("blur", notify);
  window.addEventListener("resize", notify);
  document.addEventListener("visibilitychange", notify);
};

const stopObserving = (): void => {
  if (listeners.size > 0) return;
  observer?.disconnect();
  observer = null;
  window.removeEventListener("focus", notify);
  window.removeEventListener("blur", notify);
  window.removeEventListener("resize", notify);
  document.removeEventListener("visibilitychange", notify);
};

export const setNativeSurfaceOccluded = (source: string, occluded: boolean): void => {
  if (occluded) manualOccluders.add(source);
  else manualOccluders.delete(source);
  notify();
};

export const isNativeSurfaceOccluded = (): boolean => {
  if (document.visibilityState === "hidden" || manualOccluders.size > 0) return true;
  return [...document.querySelectorAll(BLOCKING_OVERLAY_SELECTOR)].some(isVisibleElement);
};

export const subscribeNativeSurfaceOcclusion = (listener: () => void): (() => void) => {
  listeners.add(listener);
  startObserving();
  return () => {
    listeners.delete(listener);
    stopObserving();
  };
};

export const intersectNativeSurfaceBounds = (first: RunBrowserBounds, second: RunBrowserBounds): RunBrowserBounds | null => {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  if (right - x < 1 || bottom - y < 1) return null;
  return { x, y, width: right - x, height: bottom - y };
};

const elementBounds = (element: Element): RunBrowserBounds => {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
};

export const getNativeSurfaceBounds = (element: HTMLElement): RunBrowserBounds | null => {
  let clipped = intersectNativeSurfaceBounds(elementBounds(element), {
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  });
  let ancestor = element.parentElement;
  while (clipped && ancestor) {
    const style = window.getComputedStyle(ancestor);
    const clipsX = ["auto", "scroll", "hidden", "clip"].includes(style.overflowX);
    const clipsY = ["auto", "scroll", "hidden", "clip"].includes(style.overflowY);
    if (clipsX || clipsY) {
      const bounds = elementBounds(ancestor);
      clipped = intersectNativeSurfaceBounds(clipped, {
        x: clipsX ? bounds.x : clipped.x,
        y: clipsY ? bounds.y : clipped.y,
        width: clipsX ? bounds.width : clipped.width,
        height: clipsY ? bounds.height : clipped.height,
      });
    }
    ancestor = ancestor.parentElement;
  }
  if (!clipped) return null;
  return {
    x: Math.round(clipped.x),
    y: Math.round(clipped.y),
    width: Math.max(1, Math.round(clipped.width)),
    height: Math.max(1, Math.round(clipped.height)),
  };
};
