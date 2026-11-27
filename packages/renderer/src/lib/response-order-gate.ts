/**
 * Orders the answers of overlapping requests for the same data. A remote host can answer out of
 * order, so an answer to an earlier request may arrive after the answer to a later one; applying it
 * then would bring older data back. Each request takes a number when it starts, and an answer older
 * than one already applied is dropped.
 */
export interface ResponseOrderGate {
  /** Numbers a request that is about to start. */
  start(): number;
  /** True when the answer to `request` is at least as new as every applied one; it then counts as applied. */
  accept(request: number): boolean;
}

export const createResponseOrderGate = (): ResponseOrderGate => {
  let started = 0;
  let applied = 0;
  return {
    start() {
      started += 1;
      return started;
    },
    accept(request) {
      if (request < applied) return false;
      applied = request;
      return true;
    },
  };
};
