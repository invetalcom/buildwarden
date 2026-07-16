export interface RemotePairingFragment {
  code: string;
  hostOrigin: string;
}

export const normalizeRemoteHostOrigin = (raw: string): string | null => {
  try {
    const url = new URL(raw.trim());
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    const tailscaleHttps = url.protocol === "https:" && url.hostname.toLowerCase().endsWith(".ts.net");
    if (!tailscaleHttps && !(url.protocol === "http:" && loopback)) return null;
    if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) return null;
    return url.origin;
  } catch {
    return null;
  }
};

export const pairingDetailsFromFragment = (): RemotePairingFragment => {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const code = (fragment.get("pair") ?? "").replace(/\s+/g, "").toUpperCase().slice(0, 64);
  const hostOrigin = normalizeRemoteHostOrigin(fragment.get("host") ?? "") ?? "";
  if (fragment.has("pair") || fragment.has("host")) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  return { code, hostOrigin };
};
