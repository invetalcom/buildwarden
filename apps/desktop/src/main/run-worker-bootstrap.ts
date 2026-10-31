import { loadCachedWorker } from "./worker-bootstrap";

await loadCachedWorker(() => import("./run-worker"));
