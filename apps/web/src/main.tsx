import React from "react";
import ReactDOM from "react-dom/client";
import { RemoteWebApp } from "./RemoteWebApp";
import "@buildwarden/renderer/styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RemoteWebApp />
  </React.StrictMode>,
);
