import { expect, test } from "bun:test";
import { BrowserWorkloadSampler, type BrowserWorkloadObservation } from "../src/adapters/chatgpt-web/browser-workload";
import { estimateBrowserCapacity } from "../src/adapters/chatgpt-web/browser-capacity";

const GiB = 1024 ** 3;
const host = { availableMemoryBytes: 20 * GiB, cpuCount: 32, loadAverageOneMinute: 1 };

test("learns incremental RAM and CPU, retains peaks, and excludes idle retained pages", () => {
  let now = 0;
  let observation: BrowserWorkloadObservation = { memoryBytes: GiB, cpuTicks: new Map([['1:stable', 0]]), hostTicks: 0, hostCpuCount: 32 };
  const sampler = new BrowserWorkloadSampler(() => host, () => observation, () => now);
  expect(sampler.sample(0)?.workloadMemoryBytes).toBe(0);
  now = 10_000;
  observation = { ...observation, memoryBytes: 3 * GiB, hostTicks: 32_000, cpuTicks: new Map([['1:stable', 1000]]) };
  expect(sampler.sample(1)?.turnRssBytes).toBeUndefined();
  now = 30_000;
  observation = { ...observation, hostTicks: 96_000, cpuTicks: new Map([['1:stable', 3000]]) };
  const learned = sampler.sample(1)!;
  expect(learned.turnRssBytes).toBe(2.5 * GiB);
  expect(learned.turnCpuCores).toBe(1.25);
  expect(learned.workloadCpuCores).toBe(1);
  expect(estimateBrowserCapacity(learned)).toBeGreaterThan(5);
  now = 40_000;
  observation = { ...observation, memoryBytes: 2 * GiB, hostTicks: 128_000, cpuTicks: new Map([['1:stable', 3500]]) };
  expect(sampler.sample(1)!.turnRssBytes!).toBeGreaterThan(2 * GiB);
  // Once idle, retained pages become baseline, not reclaimable headroom.
  expect(sampler.sample(0)?.workloadMemoryBytes).toBe(0);
  now = 50_000;
  observation = { ...observation, memoryBytes: 2.5 * GiB };
  expect(sampler.sample(1)?.workloadMemoryBytes).toBe(0.5 * GiB);
});

test("measurement failures and recycled process IDs do not invent spare CPU", () => {
  let observation: BrowserWorkloadObservation | null = null;
  const sampler = new BrowserWorkloadSampler(() => host, () => observation, () => 0);
  expect(sampler.sample(1)).toEqual(host);
  observation = { memoryBytes: GiB, hostTicks: 10, hostCpuCount: 32, cpuTicks: new Map([['1:old', 500]]) };
  expect(sampler.sample(1)?.workloadCpuCores).toBeUndefined();
  observation = { ...observation, hostTicks: 1010, cpuTicks: new Map([['1:new', 10_000]]) };
  expect(sampler.sample(1)?.workloadCpuCores).toBe(0);
  const unavailable = new BrowserWorkloadSampler(() => null, () => observation);
  expect(unavailable.sample(1)).toBeNull();
});

test("finished turns' retained pages are not charged to the last active turn", () => {
  let now = 0;
  let bytes = GiB;
  const sampler = new BrowserWorkloadSampler(() => host,
    () => ({ memoryBytes: bytes, cpuTicks: new Map(), hostTicks: now, hostCpuCount: 32 }), () => now);
  sampler.sample(0);
  now = 10_000; bytes = 9 * GiB; sampler.sample(8);
  now = 30_000;
  expect(sampler.sample(8)?.turnRssBytes).toBe(1.25 * GiB);
  now = 40_000; sampler.sample(1);
  now = 70_000;
  const remaining = sampler.sample(1)!;
  expect(remaining.turnRssBytes!).toBeLessThan(1.25 * GiB);
  expect(remaining.workloadMemoryBytes!).toBeLessThanOrEqual(GiB);
  expect(remaining.browserTreeRssBytes).toBe(9 * GiB);
});
