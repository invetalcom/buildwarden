import type { RunRecord } from "@buildwarden/shared";
import { AppService } from "./app-service";

/** How a run's turn ended. The run's own state is already saved when listeners hear about it. */
export interface RunEnded {
  /** The run as it was when the turn started. */
  run: RunRecord;
  status: "completed" | "failed" | "cancelled";
  /** False when the worker reported an error or crashed instead of finishing the turn. */
  turnFinished: boolean;
  /** A coordinator whose turn ended while its delegated tasks continue. */
  waitingForSubagents: boolean;
  /** Why the turn did not succeed. Null when it completed or the user cancelled it. */
  failureReason: string | null;
}

export interface RunEndedListener {
  onRunEnded(ended: RunEnded): void | Promise<void>;
}

/** Tells the services that act on finished turns, in order. One failing listener does not stop the others. */
export class RunEndedNotifier extends AppService {
  private listeners: ReadonlyArray<readonly [name: string, listener: RunEndedListener]> = [];

  setListeners(listeners: ReadonlyArray<readonly [name: string, listener: RunEndedListener]>): void {
    this.listeners = listeners;
  }

  async notify(ended: RunEnded): Promise<void> {
    for (const [name, listener] of this.listeners) {
      try {
        // Listeners without asynchronous work run in the same tick.
        const pending = listener.onRunEnded(ended);
        if (pending) await pending;
      } catch (error) {
        this.logControllerError("A service could not handle the end of a run.", error, { runId: ended.run.id, service: name });
      }
    }
  }
}
