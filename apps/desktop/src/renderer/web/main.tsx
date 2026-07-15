import React from "react";
import ReactDOM from "react-dom/client";
import { RemoteWebApp } from "../src/RemoteWebApp";
import "../src/styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RemoteWebApp />
  </React.StrictMode>,
);
