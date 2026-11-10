import { ChatGptBrowserAdmission } from "./browser-admission";
import { BrowserCapacityController, type BrowserCapacitySample } from "./browser-capacity";

/**
 * Observes host pressure only while turns are active or queued. Concurrency normally runs at the
 * user-selected ceiling; real memory/CPU pressure throttles new admissions without preempting
 * turns already running. An invalid sample is treated as pressure.
 */
export class BrowserAdmissionCapacityMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private latestSample: BrowserCapacitySample | null = null;

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
    this.latestSample = sample;
    const previous = this.admission.snapshot().capacity;
    const capacity = this.controller.update(sample, this.clock());
    this.admission.setCapacity(capacity);
    if (capacity !== previous) {
      const pressure = this.controller.pressureState();
      const mb = (bytes: number | undefined): string => bytes === undefined
        ? "?"
        : `${Math.round(bytes / 1024 ** 2)}MiB`;
      console.info(
        `[chatgpt-web] browser tab capacity ${previous}->${capacity}`
        + ` (${pressure.throttled ? `throttled: ${pressure.reason ?? "pressure"}` : "healthy"},`
        + ` available=${mb(sample?.availableMemoryBytes)},`
        + ` load=${sample?.loadAverageOneMinute ?? "?"}/${sample?.cpuCount ?? "?"},`
        + ` active=${sample?.activeTurns ?? "?"})`,
      );
    }
    return capacity;
  }

  resources(): BrowserCapacitySample | null { return this.latestSample; }

  pressure() {
    return this.controller.pressureState();
  }

  /** Start observing lazily; a queued request can gain capacity on future samples. */
  start(): void {
    if (this.timer) return;
    this.observe();
    this.timer = setInterval(() => {
      this.observe();
      if (this.admission.snapshot().active === 0 && this.admission.snapshot().pending === 0) {
        this.stop();
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
