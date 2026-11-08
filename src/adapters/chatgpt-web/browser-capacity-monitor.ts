import { ChatGptBrowserAdmission } from "./browser-admission";
import { BrowserCapacityController, type BrowserCapacitySample } from "./browser-capacity";

/**
 * Observes host pressure only while turns are active or queued. All admission
 * decisions remain capped by BrowserCapacityController; existing leases are
 * never preempted. An invalid sample conservatively reduces future admission.
 */
export class BrowserAdmissionCapacityMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly admission: ChatGptBrowserAdmission,
    private readonly controller: BrowserCapacityController,
    private readonly sample: () => BrowserCapacitySample | null,
    private readonly intervalMs = 10_000,
    private readonly clock: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new Error("Invalid browser resource sampling interval");
    }
    this.admission.setCapacity(controller.current());
  }

  observe(): number {
    let sample: BrowserCapacitySample | null;
    try {
      sample = this.sample();
    } catch {
      sample = null;
    }
    const capacity = this.controller.update(sample, this.clock());
    this.admission.setCapacity(capacity);
    return capacity;
  }

  /** Start observing lazily; a queued request can gain capacity on future samples. */
  start(): void {
    if (this.timer) return;
    this.observe();
    this.timer = setInterval(() => {
      if (this.admission.snapshot().active === 0 && this.admission.snapshot().pending === 0) {
        this.stop();
        return;
      }
      this.observe();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
