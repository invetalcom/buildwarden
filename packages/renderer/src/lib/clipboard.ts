import { deepLinkTargetFor, shareableDeepLink } from "./deep-links";

/**
 * Plain-HTTP pages (a phone on a Tailscale address) have no async clipboard API, so fall back to
 * the legacy copy command on a temporary selection.
 */
export const writeClipboardText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
};

/** Copies a link that reopens a run or chat: `buildwarden://…` on the desktop, this page's URL in a browser. */
export const copyDeepLink = (kind: "run" | "chat", id: string, platform: "electron" | "web"): Promise<boolean> =>
  writeClipboardText(shareableDeepLink(deepLinkTargetFor(kind, id), platform));
