const DEFAULT_HOST_TOOL_TIMEOUT_MS = 5 * 60_000;

type PendingRequest<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class PendingHostToolRequests<T> {
  private readonly pending = new Map<string, PendingRequest<T>>();

  constructor(private readonly timeoutMs = DEFAULT_HOST_TOOL_TIMEOUT_MS) {}

  create(callId: string): Promise<T> {
    const existing = this.pending.get(callId);
    if (existing) {
      clearTimeout(existing.timeout);
      this.pending.delete(callId);
      existing.reject(new Error(`A newer BuildWarden host-tool request reused call ID ${callId}.`));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest<T> = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          if (this.pending.get(callId) !== entry) return;
          this.pending.delete(callId);
          reject(new Error(`Timed out waiting for BuildWarden host tool ${callId}.`));
        }, this.timeoutMs),
      };
      this.pending.set(callId, entry);
    });
  }

  resolve(callId: string, value: T): boolean {
    const entry = this.take(callId);
    if (!entry) return false;
    entry.resolve(value);
    return true;
  }

  reject(callId: string, error: Error): boolean {
    const entry = this.take(callId);
    if (!entry) return false;
    entry.reject(error);
    return true;
  }

  rejectAll(error: Error): void {
    for (const [callId, entry] of this.pending) {
      clearTimeout(entry.timeout);
      this.pending.delete(callId);
      entry.reject(error);
    }
  }

  private take(callId: string): PendingRequest<T> | null {
    const entry = this.pending.get(callId);
    if (!entry) return null;
    clearTimeout(entry.timeout);
    this.pending.delete(callId);
    return entry;
  }
}
