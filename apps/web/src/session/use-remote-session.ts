import { useCallback, useEffect, useMemo, useState } from "react";
import {
  REMOTE_ACCESS_PAIRING_PATH,
  REMOTE_ACCESS_SESSION_PATH,
  type RemoteAccessPairingExchangeResponse,
  type RemoteAccessSession,
} from "@buildwarden/shared";
import { createRemoteBuildWardenClient, setActiveBuildWardenClient, type BuildWardenClient } from "@buildwarden/renderer";
import {
  clearHostedConnection,
  readHostedConnection,
  saveHostedConnection,
  type HostedConnection,
} from "../hosted-connection-store";
import { normalizeRemoteHostOrigin, pairingDetailsFromFragment, type RemotePairingFragment } from "../remote-pairing-code";

/**
 * Pairing, session verification and disconnect for the browser entry — transport and token
 * handling only, no UI. The desktop shell (`RemoteWebApp`) and the mobile shell
 * (`mobile/MobileWebApp`) render completely different gates on top of this one state machine so
 * session and token handling never gets duplicated.
 */

export const HOSTED_MODE = import.meta.env.VITE_WEB_MODE === "hosted";

export type RemoteSessionState =
  | { status: "checking" }
  | { status: "pairing"; error?: string }
  | { status: "authenticated"; session: RemoteAccessSession; connection?: HostedConnection };

export interface RemoteSession {
  state: RemoteSessionState;
  /** Non-null exactly when `state.status === "authenticated"`. */
  client: BuildWardenClient | null;
  pairingHint: RemotePairingFragment;
  /** Resolves to an error message to show, or null when the browser is now paired. */
  pair: (code: string, hostOrigin: string) => Promise<string | null>;
  disconnect: (changeHost?: boolean) => Promise<void>;
}

export const browserLabel = (): string => `Web · ${navigator.platform || "browser"}`.slice(0, 80);

export const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const payload = await response.json() as { error?: unknown };
    return typeof payload.error === "string" ? payload.error : fallback;
  } catch {
    return fallback;
  }
};

export const sessionHeaders = (token: string | undefined): HeadersInit => token
  ? { Authorization: `Bearer ${token}` }
  : {};

export const useRemoteSession = (): RemoteSession => {
  const [pairingHint, setPairingHint] = useState(pairingDetailsFromFragment);
  const [state, setState] = useState<RemoteSessionState>({ status: "checking" });

  useEffect(() => {
    let disposed = false;
    const check = async () => {
      if (HOSTED_MODE && pairingHint.code && pairingHint.hostOrigin) {
        let replacementWarning: string | undefined;
        const existing = await readHostedConnection().catch(() => null);
        if (existing) {
          try {
            await fetch(`${existing.hostOrigin}${REMOTE_ACCESS_SESSION_PATH}`, {
              method: "DELETE",
              credentials: "omit",
              headers: sessionHeaders(existing.token),
            });
          } catch {
            replacementWarning = "The previous host was unreachable. Revoke that browser session from its desktop settings when possible.";
          }
          await clearHostedConnection().catch(() => undefined);
        }
        setState({ status: "pairing", ...(replacementWarning ? { error: replacementWarning } : {}) });
        return;
      }
      let connection: HostedConnection | undefined;
      try {
        connection = HOSTED_MODE ? await readHostedConnection() ?? undefined : undefined;
        if (HOSTED_MODE && !connection) {
          setState({ status: "pairing" });
          return;
        }
        const response = await fetch(`${connection?.hostOrigin ?? ""}${REMOTE_ACCESS_SESSION_PATH}`, {
          credentials: connection ? "omit" : "same-origin",
          headers: sessionHeaders(connection?.token),
        });
        if (disposed) return;
        if (!response.ok) {
          if (connection) await clearHostedConnection();
          setState({
            status: "pairing",
            error: response.status === 401
              ? "Your remote session expired or was revoked."
              : await readErrorMessage(response, "Could not verify the remote session."),
          });
          return;
        }
        const payload = await response.json() as RemoteAccessPairingExchangeResponse;
        if (connection) {
          connection = { ...connection, session: payload.session };
          await saveHostedConnection(connection);
        }
        setState({ status: "authenticated", session: payload.session, ...(connection ? { connection } : {}) });
      } catch {
        if (!disposed) setState({ status: "pairing", error: "The BuildWarden host is unavailable." });
      }
    };
    void check();
    return () => { disposed = true; };
  }, [pairingHint]);

  const client = useMemo(() => {
    if (state.status !== "authenticated") return null;
    return createRemoteBuildWardenClient({
      baseUrl: state.connection?.hostOrigin,
      sessionToken: state.connection?.token,
      scopes: state.session.scopes,
      onSessionExpired: () => {
        void clearHostedConnection();
        setState({ status: "pairing", error: "Your remote session expired or was revoked." });
      },
    });
  }, [state]);

  useEffect(() => {
    setActiveBuildWardenClient(client);
    return () => setActiveBuildWardenClient(null);
  }, [client]);

  const pair = useCallback(async (code: string, hostOrigin: string): Promise<string | null> => {
    const normalizedCode = code.replace(/\s+/g, "").toUpperCase();
    const normalizedHost = HOSTED_MODE ? normalizeRemoteHostOrigin(hostOrigin) : "";
    if (!normalizedCode) return null;
    if (HOSTED_MODE && !normalizedHost) {
      return "Enter the Tailscale HTTPS URL shown by the BuildWarden desktop app.";
    }
    try {
      const response = await fetch(`${normalizedHost}${REMOTE_ACCESS_PAIRING_PATH}`, {
        method: "POST",
        credentials: HOSTED_MODE ? "omit" : "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: normalizedCode, label: browserLabel() }),
      });
      if (!response.ok) {
        return await readErrorMessage(response, "Pairing failed. Request a fresh code from the desktop app.");
      }
      const payload = await response.json() as RemoteAccessPairingExchangeResponse;
      if (HOSTED_MODE) {
        if (!payload.token || !normalizedHost) {
          return "The host did not issue an origin-bound browser session.";
        }
        const connection = { hostOrigin: normalizedHost, token: payload.token, session: payload.session };
        await saveHostedConnection(connection);
        setPairingHint({ code: "", hostOrigin: "" });
        setState({ status: "authenticated", session: payload.session, connection });
      } else {
        setPairingHint({ code: "", hostOrigin: "" });
        setState({ status: "authenticated", session: payload.session });
      }
      return null;
    } catch {
      return "The BuildWarden host is unavailable. Keep the desktop app and Tailscale running, then try again.";
    }
  }, []);

  const disconnect = useCallback(async (changeHost = false) => {
    const connection = state.status === "authenticated" ? state.connection : undefined;
    let revokeFailed = false;
    try {
      const response = await fetch(`${connection?.hostOrigin ?? ""}${REMOTE_ACCESS_SESSION_PATH}`, {
        method: "DELETE",
        credentials: connection ? "omit" : "same-origin",
        headers: sessionHeaders(connection?.token),
      });
      if (!response.ok && response.status !== 401) revokeFailed = Boolean(connection);
    } catch {
      revokeFailed = Boolean(connection);
    } finally {
      await clearHostedConnection().catch(() => undefined);
      setPairingHint({ code: "", hostOrigin: "" });
      setActiveBuildWardenClient(null);
      setState({
        status: "pairing",
        error: revokeFailed && changeHost
          ? "The previous host was unreachable. Revoke that browser session from its desktop settings when possible."
          : undefined,
      });
    }
  }, [state]);

  return { state, client, pairingHint, pair, disconnect };
};
