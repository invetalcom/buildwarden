import { BuildWardenClientProvider } from "@buildwarden/renderer";
import { useRemoteSession } from "../session/use-remote-session";
import { MobileShell } from "./MobileShell";
import { PairingScreen } from "./screens/PairingScreen";
import { CenteredSpinner } from "./components/primitives";
import "./styles/mobile.css";

/**
 * Mobile entry point.
 *
 * Shares the pairing/session state machine and the remote transport with the desktop shell, and
 * keeps its own shell and layout. Focused shared surfaces, including the run browser,
 * use the mobile stylesheet's explicit Tailwind sources; the desktop stylesheet is not loaded.
 */
const MobileWebApp = () => {
  const { state, client, pairingHint, pair, disconnect } = useRemoteSession();

  if (state.status === "checking") {
    return (
      <main className="m-shell items-center justify-center">
        <CenteredSpinner label="Checking remote session" />
      </main>
    );
  }

  if (state.status === "pairing" || !client) {
    return (
      <PairingScreen
        initialError={state.status === "pairing" ? state.error : undefined}
        initialCode={pairingHint.code}
        initialHostOrigin={pairingHint.hostOrigin}
        onPair={pair}
      />
    );
  }

  return (
    <BuildWardenClientProvider client={client}>
      <MobileShell client={client} disconnect={disconnect} />
    </BuildWardenClientProvider>
  );
};

export default MobileWebApp;
