import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { BuildWardenClientProvider } from "./lib/buildwarden-client";
import { createElectronBuildWardenClient, setActiveBuildWardenClient } from "./lib/buildwarden-client-core";
import "./styles.css";

const buildwardenClient = createElectronBuildWardenClient(window.buildwarden);
setActiveBuildWardenClient(buildwardenClient);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BuildWardenClientProvider client={buildwardenClient}>
      <App />
    </BuildWardenClientProvider>
  </React.StrictMode>,
);
