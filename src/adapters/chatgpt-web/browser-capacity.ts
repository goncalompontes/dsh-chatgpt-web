import { MAX_CHATGPT_BROWSER_TABS, MIN_CHATGPT_BROWSER_TURNS, browserMemoryReserveBytes } from "./concurrency";

/**
 * Host/resource observation used for admission backpressure. The per-turn fields are diagnostic
 * only: concurrency is user-selected and throttled reactively, never predicted from a memory model.
 */
export interface BrowserCapacitySample {
  availableMemoryBytes: number;
  cpuCount: number;
  loadAverageOneMinute: number;
  /** Optional measured per-active-turn browser/launcher incremental RSS (diagnostics only). */
  turnRssBytes?: number;
  turnCpuCores?: number;
  /** Resources already occupied by this sidecar's browser process tree (diagnostics only). */
  workloadMemoryBytes?: number;
  workloadCpuCores?: number;
  browserTreeRssBytes?: number;
  activeTurns?: number;
}

export interface BrowserCapacityLimits {
  min: number;
  max: number;
  /** Memory kept available for the rest of the host before new admissions are throttled. */
  memoryReserveBytes: number;
  /** Retained for config compatibility; predictive budgeting is no longer used. */
  defaultTurnRssBytes?: number;
  /** Host load fraction at which new admissions are throttled (0..1). */
  cpuHeadroomFraction: number;
}

export const DEFAULT_BROWSER_CAPACITY_LIMITS: BrowserCapacityLimits = {
  min: MIN_CHATGPT_BROWSER_TURNS,
  max: MAX_CHATGPT_BROWSER_TABS,
  memoryReserveBytes: browserMemoryReserveBytes(),
  cpuHeadroomFraction: 0.75,
};

export type BrowserPressureReason = "memory" | "cpu" | "invalid";

export interface BrowserPressure {
  throttled: boolean;
  reason?: BrowserPressureReason;
}

function validLimits(limits: BrowserCapacityLimits): boolean {
  return Number.isSafeInteger(limits.min) && limits.min >= 1
    && Number.isSafeInteger(limits.max) && limits.max >= limits.min
    && Number.isFinite(limits.memoryReserveBytes) && limits.memoryReserveBytes >= 0
    && Number.isFinite(limits.cpuHeadroomFraction)
    && limits.cpuHeadroomFraction > 0 && limits.cpuHeadroomFraction <= 1;
}

/** True when the host is genuinely under memory or CPU pressure right now. */
export function browserPressure(
  sample: BrowserCapacitySample | null,
  limits: BrowserCapacityLimits = DEFAULT_BROWSER_CAPACITY_LIMITS,
): BrowserPressure {
  if (!sample
    || !Number.isFinite(sample.availableMemoryBytes) || sample.availableMemoryBytes < 0
    || !Number.isFinite(sample.cpuCount) || sample.cpuCount < 1
    || !Number.isFinite(sample.loadAverageOneMinute) || sample.loadAverageOneMinute < 0) {
    return { throttled: true, reason: "invalid" };
  }
  if (sample.availableMemoryBytes <= limits.memoryReserveBytes) {
    return { throttled: true, reason: "memory" };
  }
  if (sample.loadAverageOneMinute >= sample.cpuCount * limits.cpuHeadroomFraction) {
    return { throttled: true, reason: "cpu" };
  }
  return { throttled: false };
}

/**
 * Admission capacity under the reactive policy:
 * - healthy: the user-selected ceiling (all configured tabs may run);
 * - under pressure: no new admissions beyond the tabs already running, so existing turns finish
 *   and the queue waits instead of the process being pushed into swap or CPU starvation.
 * The minimum still allows one probe tab so an idle host can always make progress.
 */
export function estimateBrowserCapacity(
  sample: BrowserCapacitySample | null,
  limits: BrowserCapacityLimits = DEFAULT_BROWSER_CAPACITY_LIMITS,
): number {
  if (!validLimits(limits)) throw new Error("Invalid browser capacity limits");
  const pressure = browserPressure(sample, limits);
  if (!pressure.throttled) return limits.max;
  const active = sample && Number.isSafeInteger(sample.activeTurns) && sample.activeTurns! > 0
    ? sample.activeTurns!
    : 0;
  return Math.max(limits.min, Math.min(limits.max, active));
}

/**
 * Admission backpressure controller. Throttling applies immediately; the full ceiling returns
 * only after several consecutive healthy samples and a cooldown, so a transient peak cannot
 * trigger a start/stop oscillation.
 */
export class BrowserCapacityController {
  private capacity: number;
  private positiveSamples = 0;
  private lastChangeMs = Number.NEGATIVE_INFINITY;
  private pressure: BrowserPressure = { throttled: false };

  constructor(
    private readonly limits: BrowserCapacityLimits = DEFAULT_BROWSER_CAPACITY_LIMITS,
    private readonly upwardSamples = 3,
    private readonly cooldownMs = 10_000,
  ) {
    if (!Number.isSafeInteger(upwardSamples) || upwardSamples < 1 ||
        !Number.isFinite(cooldownMs) || cooldownMs < 0) {
      throw new Error("Invalid browser capacity controller settings");
    }
    if (!validLimits(limits)) throw new Error("Invalid browser capacity limits");
    this.capacity = limits.max;
  }

  current(): number { return this.capacity; }

  pressureState(): BrowserPressure { return this.pressure; }

  update(sample: BrowserCapacitySample | null, nowMs: number): number {
    if (!Number.isFinite(nowMs)) throw new Error("Invalid capacity observation time");
    this.pressure = browserPressure(sample, this.limits);
    const target = estimateBrowserCapacity(sample, this.limits);
    if (target <= this.capacity) {
      this.positiveSamples = 0;
      if (target < this.capacity) {
        this.capacity = target;
        this.lastChangeMs = nowMs;
      }
      return this.capacity;
    }
    // Healthy again: restore the user-selected ceiling once, after sustained evidence.
    if (++this.positiveSamples >= this.upwardSamples && nowMs - this.lastChangeMs >= this.cooldownMs) {
      this.capacity = target;
      this.positiveSamples = 0;
      this.lastChangeMs = nowMs;
    }
    return this.capacity;
  }
}
