import { readFileSync, readdirSync } from "node:fs";
import { cpus } from "node:os";
import { sampleLinuxBrowserResources } from "./browser-resources";
import type { BrowserCapacitySample } from "./browser-capacity";

export interface BrowserWorkloadObservation {
  memoryBytes: number;
  cpuTicks: Map<string, number>;
  hostTicks: number;
  hostCpuCount: number;
}

/** Observe only this sidecar and its descendants; never attach to other Chrome sessions. */
export function observeBrowserWorkload(rootPid = process.pid): BrowserWorkloadObservation | null {
  try {
    const processes = new Map<number, { parent: number; identity: string; ticks: number }>();
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8").split(/\) /).at(-1)!.split(" ");
        processes.set(Number(name), { parent: Number(stat[1]), identity: `${name}:${stat[19]}`,
          ticks: Number(stat[11]) + Number(stat[12]) });
      } catch { /* Processes can exit between enumeration and read. */ }
    }
    if (!processes.has(rootPid)) return null;
    const descendants = new Set([rootPid]);
    let previousSize = 0;
    while (previousSize !== descendants.size) {
      previousSize = descendants.size;
      for (const [pid, process] of processes) if (descendants.has(process.parent)) descendants.add(pid);
    }
    let memoryBytes = 0;
    const cpuTicks = new Map<string, number>();
    for (const pid of descendants) {
      try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const rss = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
        if (rss) memoryBytes += Number(rss[1]) * 1024;
        const process = processes.get(pid)!;
        cpuTicks.set(process.identity, process.ticks);
      } catch { /* Exited descendants contribute nothing to this sample. */ }
    }
    // Linux exposes host and process CPU time in the same tick units. Exclude
    // guest counters, which are already included in user/nice CPU time.
    const host = readFileSync("/proc/stat", "utf8").split("\n")[0]!.trim().split(/\s+/).slice(1, 9).map(Number);
    if (host.length !== 8 || !host.every(Number.isFinite) || memoryBytes <= 0) return null;
    return { memoryBytes, cpuTicks, hostTicks: host.reduce((a, b) => a + b, 0), hostCpuCount: cpus().length };
  } catch { return null; }
}

/** Learn a conservative per-turn allowance from sustained, observed work. */
export class BrowserWorkloadSampler {
  private previous?: BrowserWorkloadObservation;
  private active = 0;
  private activeSince = 0;
  private lastTime?: number;
  private rssPeak = 0;
  private cpuPeak = 0;
  private idleMemoryBytes = 0;
  private peakActive = 0;

  constructor(
    private readonly host: () => BrowserCapacitySample | null = sampleLinuxBrowserResources,
    private readonly workload: () => BrowserWorkloadObservation | null = observeBrowserWorkload,
    private readonly clock: () => number = Date.now,
  ) {}

  sample(active: number): BrowserCapacitySample | null {
    const host = this.host();
    if (!host) return null;
    const now = this.clock();
    const observed = this.workload();
    if (!observed) { this.previous = undefined; return host; }
    if (active === 0) this.idleMemoryBytes = observed.memoryBytes;
    this.peakActive = active === 0 ? 0 : Math.max(this.peakActive, active);
    const activeMemoryBytes = active > 0 ? Math.max(0, observed.memoryBytes - this.idleMemoryBytes) : 0;
    if (active !== this.active) { this.active = active; this.activeSince = now; }
    const elapsed = this.lastTime === undefined ? 0 : Math.max(0, now - this.lastTime);
    // Keep workload peaks for minutes rather than instantly trusting a cheaper sample.
    const decay = Math.pow(0.5, elapsed / (10 * 60_000));
    this.rssPeak *= decay;
    this.cpuPeak *= decay;
    let cpuCores: number | undefined;
    if (this.previous && observed.hostTicks > this.previous.hostTicks) {
      let ticks = 0;
      for (const [identity, current] of observed.cpuTicks) {
        const previous = this.previous.cpuTicks.get(identity);
        if (previous !== undefined) ticks += Math.max(0, current - previous);
      }
      cpuCores = Math.min(host.cpuCount, ticks / (observed.hostTicks - this.previous.hostTicks) * observed.hostCpuCount);
    }
    this.previous = observed;
    this.lastTime = now;
    // Do not learn an unrealistically cheap turn from initial browser startup.
    // After turns finish, their pages may remain resident. Do not attribute all
    // those retained pages to the few remaining turns and inflate their cost.
    if (active > 0 && active === this.peakActive && now - this.activeSince >= 20_000) {
      this.rssPeak = Math.max(this.rssPeak, activeMemoryBytes / active * 1.25);
      if (cpuCores !== undefined) this.cpuPeak = Math.max(this.cpuPeak, cpuCores / active * 1.25);
    }
    const activeMemoryCredit = Math.min(activeMemoryBytes,
      active * (this.rssPeak > 0 ? Math.max(512 * 1024 ** 2, this.rssPeak / 1.25) : 3 * 1024 ** 3));
    return { ...host, workloadMemoryBytes: activeMemoryCredit, browserTreeRssBytes: observed.memoryBytes, activeTurns: active,
      ...(cpuCores === undefined ? {} : { workloadCpuCores: cpuCores }),
      ...(this.rssPeak > 0 ? { turnRssBytes: this.rssPeak } : {}),
      ...(this.cpuPeak > 0 ? { turnCpuCores: this.cpuPeak } : {}) };
  }
}
