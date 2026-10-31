import { loadCachedWorker } from "./worker-bootstrap";

await loadCachedWorker(() => import("./chat-worker"));
