import { readFileSync } from "node:fs";
import { availableParallelism, cpus, loadavg, totalmem } from "node:os";
import type { BrowserCapacitySample } from "./browser-capacity";

/** Linux resource observation; all filesystem accesses may fail independently. */
export interface BrowserResourceRead {
  read(path: string): string | null;
  cpuCount(): number;
  loadOneMinute(): number;
  totalMemoryBytes(): number;
}

const hostRead: BrowserResourceRead = {
  read(path) {
    try { return readFileSync(path, "utf8"); } catch { return null; }
  },
  cpuCount: () => typeof availableParallelism === "function" ? availableParallelism() : cpus().length,
  loadOneMinute: () => loadavg()[0] ?? Number.NaN,
  totalMemoryBytes: () => totalmem(),
};

function bytesFromMemInfo(value: string | null): number | null {
  const match = value?.match(/^MemAvailable:\s*(\d+)\s+kB\s*$/m);
  return match ? Number(match[1]) * 1024 : null;
}

function cgroupBound(value: string | null): number | null {
  if (!value || value.trim() === "max") return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function cgroupHeadroom(reader: BrowserResourceRead): number | null {
  // cgroup v2. cgroup v1 or absent metrics conservatively use host availability.
  const limit = cgroupBound(reader.read("/sys/fs/cgroup/memory.max"));
  const used = cgroupBound(reader.read("/sys/fs/cgroup/memory.current"));
  if (limit === null || used === null) return null;
  return Math.max(0, limit - used);
}

function cgroupCpuCount(reader: BrowserResourceRead): number | null {
  const quota = reader.read("/sys/fs/cgroup/cpu.max")?.trim().split(/\s+/);
  if (!quota || quota.length < 2 || quota[0] === "max") return null;
  const q = Number(quota[0]);
  const period = Number(quota[1]);
  return Number.isSafeInteger(q) && q > 0 && Number.isSafeInteger(period) && period > 0
    ? Math.max(1, Math.floor(q / period))
    : null;
}

/**
 * Fail closed to null when key host measurements are unavailable. No network,
 * browser, or session lifecycle access, and no modifications to the OS.
 */
export function sampleLinuxBrowserResources(reader: BrowserResourceRead = hostRead): BrowserCapacitySample | null {
  const available = bytesFromMemInfo(reader.read("/proc/meminfo"));
  const cpus = reader.cpuCount();
  const load = reader.loadOneMinute();
  const total = reader.totalMemoryBytes();
  if (available === null || !Number.isFinite(total) || total < 0 ||
      !Number.isFinite(cpus) || cpus < 1 || !Number.isFinite(load) || load < 0) return null;
  const bounded = cgroupHeadroom(reader);
  const quota = cgroupCpuCount(reader);
  return {
    availableMemoryBytes: Math.max(0, Math.min(total, available, bounded ?? Infinity)),
    cpuCount: Math.min(cpus, quota ?? Infinity),
    loadAverageOneMinute: load,
  };
}
