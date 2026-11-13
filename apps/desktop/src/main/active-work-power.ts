interface PowerBlocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}

/** One application-suspension blocker for all active runs, chats and their startup reservations. */
export class ActiveWorkPower {
  private id: number | undefined;
  private disposed = false;

  constructor(private readonly blocker: PowerBlocker) {}

  setActive(active: boolean): void {
    if (this.disposed) return;
    if (active && this.id === undefined) this.id = this.blocker.start("prevent-app-suspension");
    else if (!active && this.id !== undefined) {
      this.blocker.stop(this.id);
      this.id = undefined;
    }
  }

  dispose(): void {
    this.setActive(false);
    this.disposed = true;
  }
}
