import { IntegratedRemoteApp } from "../instances/IntegratedRemoteApp";
import { MobileShell } from "./MobileShell";
import "./styles/mobile.css";

const MobileWebApp = () => <IntegratedRemoteApp>{(client, manage) => <MobileShell client={client} disconnect={async () => manage()} />}</IntegratedRemoteApp>;
export default MobileWebApp;
