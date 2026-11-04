import { parentPort, workerData } from "node:worker_threads";
import { LocalSessionUsage, type SessionUsageRoot } from "./local-session-usage";
const scanner = new LocalSessionUsage({ cacheFilePath: workerData.cacheFilePath as string });
parentPort!.on("message", (request: { roots: SessionUsageRoot[]; force: boolean }) => {
  void scanner.load(request.roots, request.force).then(
    (result) => parentPort!.postMessage({ result }),
    () => parentPort!.postMessage({ error: "Could not scan local usage history." }),
  );
});
