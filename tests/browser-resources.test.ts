import { describe, expect, test } from "bun:test";
import { sampleLinuxBrowserResources, type BrowserResourceRead } from "../src/adapters/chatgpt-web/browser-resources";
import { estimateBrowserCapacity } from "../src/adapters/chatgpt-web/browser-capacity";

const GiB = 1024 ** 3;
function reader(files: Record<string, string | null>, overrides: Partial<BrowserResourceRead> = {}): BrowserResourceRead {
  return {
    read: path => files[path] ?? null,
    cpuCount: () => 16,
    loadOneMinute: () => 2,
    totalMemoryBytes: () => 32 * GiB,
    ...overrides,
  };
}
const host = { "/proc/meminfo": "MemTotal: 33554432 kB\nMemAvailable: 16777216 kB\n" };

describe("Linux browser resource sampler", () => {
  test("reads host available memory and CPU headroom", () => {
    expect(sampleLinuxBrowserResources(reader(host))).toEqual({
      availableMemoryBytes: 16 * GiB, cpuCount: 16, loadAverageOneMinute: 2,
    });
  });

  test("honors cgroup v2 memory headroom and CPU quota", () => {
    const measured = sampleLinuxBrowserResources(reader({
      ...host,
      "/sys/fs/cgroup/memory.max": String(8 * GiB),
      "/sys/fs/cgroup/memory.current": String(6 * GiB),
      "/sys/fs/cgroup/cpu.max": "400000 100000",
    }));
    expect(measured).toEqual({
      availableMemoryBytes: 2 * GiB, cpuCount: 4, loadAverageOneMinute: 2,
    });
    expect(estimateBrowserCapacity(measured)).toBe(1);
  });

  test("unlimited or unavailable cgroup controls do not invent finite ceilings", () => {
    expect(sampleLinuxBrowserResources(reader({
      ...host, "/sys/fs/cgroup/memory.max": "max", "/sys/fs/cgroup/cpu.max": "max 100000",
    }))?.availableMemoryBytes).toBe(16 * GiB);
  });

  test("rejects missing or invalid host metrics rather than assuming spare resources", () => {
    expect(sampleLinuxBrowserResources(reader({}))).toBeNull();
    expect(sampleLinuxBrowserResources(reader(host, { loadOneMinute: () => Number.NaN }))).toBeNull();
    expect(sampleLinuxBrowserResources(reader(host, { cpuCount: () => 0 }))).toBeNull();
  });

  test("clamps inconsistent memory data to non-negative physical headroom", () => {
    expect(sampleLinuxBrowserResources(reader({
      ...host, "/sys/fs/cgroup/memory.max": "1024", "/sys/fs/cgroup/memory.current": "2048",
    }))?.availableMemoryBytes).toBe(0);
  });
});
