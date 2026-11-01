import { useState } from "react";
import type { ConnectedInstance } from "./instance-manager";

/** Report initial failures as they settle; background retries must not resurrect dismissed errors. */
export const useConnectionError = (instances: readonly ConnectedInstance[]) => {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const unavailable = instances.filter((entry) =>
    (entry.status === "offline" || entry.status === "pairing-required") && !dismissed.has(entry.connection.id));
  if (!unavailable.length) return undefined;
  return {
    message: "Could not connect to these BuildWarden instances:\n"
      + unavailable.map(({ connection, status }) =>
        `${connection.name} (${new URL(connection.hostOrigin).host}) — ${status === "offline" ? "Offline" : "Pairing required"}`).join("\n")
      + "\nOpen Manage instances to reconnect or pair again. Other connected instances remain available.",
    onDismiss: () => setDismissed((current) => new Set([...current, ...unavailable.map((entry) => entry.connection.id)])),
  };
};
