export const pairingCodeFromFragment = (): string => {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const value = fragment.get("pair") ?? "";
  if (fragment.has("pair")) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  return value.replace(/\s+/g, "").toUpperCase().slice(0, 64);
};
