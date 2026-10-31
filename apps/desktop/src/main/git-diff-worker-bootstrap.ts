import { loadCachedWorker } from "./worker-bootstrap";

await loadCachedWorker(() => import("./git-diff-worker"));
