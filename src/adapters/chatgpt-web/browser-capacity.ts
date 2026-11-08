import { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";

/** Pure, conservative resource-bound capacity estimator. No browser lifecycle side effects. */
export interface BrowserCapacitySample {
  availableMemoryBytes: number;
  cpuCount: number;
  loadAverageOneMinute: number;
  /** Optional measured per-active-turn browser/launcher incremental RSS. */
  turnRssBytes?: number;
  turnCpuCores?: number;
  /** Resources already occupied by this sidecar's browser process tree. */
  workloadMemoryBytes?: number;
  workloadCpuCores?: number;
  browserTreeRssBytes?: number;
  activeTurns?: number;
}

export interface BrowserCapacityLimits {
  min: number;
  max: number;
  memoryReserveBytes: number;
  defaultTurnRssBytes: number;
  /** Fraction of host CPUs allowed for estimated admission; 0..1. */
  cpuHeadroomFraction: number;
}

export const DEFAULT_BROWSER_CAPACITY_LIMITS: BrowserCapacityLimits = {
  min: 1,
  max: MAX_CHATGPT_BROWSER_TABS,
  memoryReserveBytes: 4 * 1024 ** 3,
  // Cold-start allowance until sustained live work supplies measured costs.
  defaultTurnRssBytes: 3 * 1024 ** 3,
  cpuHeadroomFraction: 0.75,
};

export function estimateBrowserCapacity(
  sample: BrowserCapacitySample | null,
  limits: BrowserCapacityLimits = DEFAULT_BROWSER_CAPACITY_LIMITS,
): number {
  if (!Number.isSafeInteger(limits.min) || limits.min < 1 ||
      !Number.isSafeInteger(limits.max) || limits.max < limits.min ||
      !Number.isFinite(limits.memoryReserveBytes) || limits.memoryReserveBytes < 0 ||
      !Number.isFinite(limits.defaultTurnRssBytes) || limits.defaultTurnRssBytes <= 0 ||
      !Number.isFinite(limits.cpuHeadroomFraction) ||
      limits.cpuHeadroomFraction <= 0 || limits.cpuHeadroomFraction > 1) {
    throw new Error("Invalid browser capacity limits");
  }
  if (!sample ||
      !Number.isFinite(sample.availableMemoryBytes) || sample.availableMemoryBytes < 0 ||
      !Number.isFinite(sample.cpuCount) || sample.cpuCount < 1 ||
      !Number.isFinite(sample.loadAverageOneMinute) || sample.loadAverageOneMinute < 0) {
    return limits.min;
  }

  const rss = sample.turnRssBytes && Number.isFinite(sample.turnRssBytes) && sample.turnRssBytes > 0
    ? Math.max(sample.turnRssBytes, 512 * 1024 ** 2)
    : limits.defaultTurnRssBytes;
  const ownMemory = Number.isFinite(sample.workloadMemoryBytes) && sample.workloadMemoryBytes! > 0
    ? sample.workloadMemoryBytes! : 0;
  const ownCpu = Number.isFinite(sample.workloadCpuCores) && sample.workloadCpuCores! > 0
    ? Math.min(sample.workloadCpuCores!, sample.loadAverageOneMinute) : 0;
  const turnCpu = Number.isFinite(sample.turnCpuCores) && sample.turnCpuCores! > 0
    ? Math.max(0.5, sample.turnCpuCores!) : 1;
  // Availability already excludes running browsers. Credit only their observed
  // usage, rather than counting the current workload twice or inventing headroom.
  const memoryBudget = Math.max(0, sample.availableMemoryBytes - limits.memoryReserveBytes + ownMemory);
  const memorySlots = Math.floor(memoryBudget / rss);
  const cpuBudget = Math.max(0, sample.cpuCount * limits.cpuHeadroomFraction - sample.loadAverageOneMinute + ownCpu);
  // Host load is an imperfect pressure signal; measured per-turn CPU retains
  // a half-core floor and never expands capacity beyond the shared ceiling.
  const cpuSlots = Math.floor(cpuBudget / turnCpu);
  return Math.max(limits.min, Math.min(limits.max, memorySlots, cpuSlots));
}

/** Scale down immediately; require repeated healthy samples before scaling up. */
export class BrowserCapacityController {
  private capacity: number;
  private positiveSamples = 0;
  private lastChangeMs = Number.NEGATIVE_INFINITY;
  constructor(
    private readonly limits: BrowserCapacityLimits = DEFAULT_BROWSER_CAPACITY_LIMITS,
    private readonly upwardSamples = 3,
    private readonly cooldownMs = 30_000,
  ) {
    if (!Number.isSafeInteger(upwardSamples) || upwardSamples < 1 ||
        !Number.isFinite(cooldownMs) || cooldownMs < 0) {
      throw new Error("Invalid browser capacity controller settings");
    }
    this.capacity = limits.min;
    estimateBrowserCapacity(null, limits);
  }

  current(): number { return this.capacity; }

  update(sample: BrowserCapacitySample | null, nowMs: number): number {
    if (!Number.isFinite(nowMs)) throw new Error("Invalid capacity observation time");
    const target = estimateBrowserCapacity(sample, this.limits);
    if (target <= this.capacity) {
      this.positiveSamples = 0;
      if (target < this.capacity) {
        this.capacity = target;
        this.lastChangeMs = nowMs;
      }
      return this.capacity;
    }
    if (++this.positiveSamples >= this.upwardSamples && nowMs - this.lastChangeMs >= this.cooldownMs) {
      this.capacity = Math.min(this.capacity + 1, target);
      this.positiveSamples = 0;
      this.lastChangeMs = nowMs;
    }
    return this.capacity;
  }
}
