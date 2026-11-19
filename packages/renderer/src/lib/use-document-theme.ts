import { useSyncExternalStore } from "react";

export type DocumentTheme = "light" | "dark";

/** The app is dark unless the body or root says `data-theme="light"` (desktop and mobile alike). */
const readTheme = (): DocumentTheme =>
  typeof document !== "undefined" && (document.body?.dataset.theme ?? document.documentElement.dataset.theme) === "light" ? "light" : "dark";

const subscribe = (onChange: () => void) => {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  const options: MutationObserverInit = { attributes: true, attributeFilter: ["data-theme"] };
  observer.observe(document.documentElement, options);
  if (document.body) observer.observe(document.body, options);
  return () => observer.disconnect();
};

export const useDocumentTheme = (): DocumentTheme => useSyncExternalStore(subscribe, readTheme, () => "dark");
