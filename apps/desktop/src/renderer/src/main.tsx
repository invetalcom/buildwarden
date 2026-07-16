import React from "react";
import ReactDOM from "react-dom/client";
import {
  App,
  BuildWardenClientProvider,
  createElectronBuildWardenClient,
  setActiveBuildWardenClient,
} from "@buildwarden/renderer";
import "@buildwarden/renderer/styles.css";

const buildwardenClient = createElectronBuildWardenClient(window.buildwarden);
setActiveBuildWardenClient(buildwardenClient);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BuildWardenClientProvider client={buildwardenClient}>
      <App />
    </BuildWardenClientProvider>
  </React.StrictMode>,
);
