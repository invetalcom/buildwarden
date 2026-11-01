import { App } from "@buildwarden/renderer";
import { IntegratedRemoteApp } from "./instances/IntegratedRemoteApp";

export const RemoteWebApp = () => <IntegratedRemoteApp>{() => <App />}</IntegratedRemoteApp>;
