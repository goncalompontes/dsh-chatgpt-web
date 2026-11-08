import { describe, expect, test } from "bun:test";
import {
  BrowserCapacityController,
  estimateBrowserCapacity,
  DEFAULT_BROWSER_CAPACITY_LIMITS,
} from "../src/adapters/chatgpt-web/browser-capacity";

const GiB = 1024 ** 3;
const sample = (memoryGiB: number, load = 1, cpus = 16) =>
  ({ availableMemoryBytes: memoryGiB * GiB, cpuCount: cpus, loadAverageOneMinute: load });

describe("resource-aware browser capacity", () => {
  test("never exceeds the separately enforced physical limit", () => {
    expect(estimateBrowserCapacity(sample(128, 0, 64))).toBe(5);
  });

  test("conservatively clamps under memory or CPU pressure", () => {
    expect(estimateBrowserCapacity(sample(4, 0, 64))).toBe(1);
    expect(estimateBrowserCapacity(sample(32, 12, 16))).toBe(1);
    expect(estimateBrowserCapacity(sample(10, 0, 64))).toBe(2);
  });

  test("falls back safely on unavailable or invalid samples", () => {
    expect(estimateBrowserCapacity(null)).toBe(1);
    expect(estimateBrowserCapacity(sample(Number.NaN))).toBe(1);
    expect(estimateBrowserCapacity(sample(20, -1))).toBe(1);
    expect(estimateBrowserCapacity(sample(20, 1, 0))).toBe(1);
  });

  test("uses bounded measured turn RSS when provided", () => {
    expect(estimateBrowserCapacity({ ...sample(12, 0, 64), turnRssBytes: 3 * GiB })).toBe(2);
    expect(estimateBrowserCapacity({ ...sample(12, 0, 64), turnRssBytes: Number.NaN })).toBe(2);
  });

  test("rejects unsafe capacity policy settings", () => {
    expect(() => estimateBrowserCapacity(sample(32), { ...DEFAULT_BROWSER_CAPACITY_LIMITS, min: 0 })).toThrow();
    expect(() => new BrowserCapacityController(DEFAULT_BROWSER_CAPACITY_LIMITS, 0)).toThrow();
  });

  test("scales down immediately and requires sustained samples to scale up", () => {
    const controller = new BrowserCapacityController(DEFAULT_BROWSER_CAPACITY_LIMITS, 3, 10_000);
    const healthy = sample(64, 0, 32);
    expect(controller.current()).toBe(1);
    expect(controller.update(healthy, 0)).toBe(1);
    expect(controller.update(healthy, 1)).toBe(1);
    expect(controller.update(healthy, 2)).toBe(2);
    expect(controller.update(healthy, 3)).toBe(2);
    expect(controller.update(sample(4, 0, 32), 4)).toBe(1);
    expect(controller.update(healthy, 5)).toBe(1);
    expect(controller.update(healthy, 6)).toBe(1);
    expect(controller.update(healthy, 10_005)).toBe(2);
  });

  test("bad samples rapidly reduce but do not preempt active leases", () => {
    const controller = new BrowserCapacityController(DEFAULT_BROWSER_CAPACITY_LIMITS, 1, 0);
    expect(controller.update(sample(64, 0, 32), 1)).toBe(2);
    expect(controller.update(null, 2)).toBe(1);
  });
});
