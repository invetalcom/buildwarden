import { IntegratedRemoteApp } from "../instances/IntegratedRemoteApp";
import { MobileShell } from "./MobileShell";
import "./styles/mobile.css";

const MobileWebApp = () => <IntegratedRemoteApp standaloneNotifications>{(client, manage) => <MobileShell client={client} disconnect={async () => manage()} />}</IntegratedRemoteApp>;
export default MobileWebApp;
