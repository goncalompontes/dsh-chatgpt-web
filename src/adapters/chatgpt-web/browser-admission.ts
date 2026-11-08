/** FIFO admission for physical ChatGPT browser turns, separate from logical native sessions. */
export class ChatGptBrowserAdmission {
  private active = 0;
  private capacity: number;
  private readonly pending: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(
    capacity: number,
    private readonly maxPending = 256,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid browser admission capacity");
    if (!Number.isSafeInteger(maxPending) || maxPending < 0) throw new Error("Invalid browser admission queue limit");
    this.capacity = capacity;
  }

  /** Adjust future admissions without interrupting already-running browser turns. */
  setCapacity(capacity: number): void {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid browser admission capacity");
    if (capacity === this.capacity) return;
    this.capacity = capacity;
    this.drain();
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
    if (this.active < this.capacity && this.pending.length === 0) {
      this.active += 1;
      return Promise.resolve(this.lease());
    }
    if (this.pending.length >= this.maxPending) {
      return Promise.reject(new Error(`ChatGPT web browser admission queue is full (${this.maxPending} pending turns)`));
    }
    return new Promise((resolve, reject) => {
      const waiter: (typeof this.pending)[number] = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.pending.indexOf(waiter);
          if (index !== -1) this.pending.splice(index, 1);
          reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.pending.push(waiter);
    });
  }

  snapshot(): { active: number; pending: number; capacity: number } {
    return { active: this.active, pending: this.pending.length, capacity: this.capacity };
  }

  private lease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.capacity && this.pending.length > 0) {
      const waiter = this.pending.shift()!;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.lease());
    }
  }
}
