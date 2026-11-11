import { describe, expect, test } from "bun:test";
import {
  BrowserCapacityController,
  estimateBrowserCapacity,
  DEFAULT_BROWSER_CAPACITY_LIMITS,
} from "../src/adapters/chatgpt-web/browser-capacity";
import { browserTurnCeiling, MAX_CHATGPT_BROWSER_TABS, retainedChatGptTabs } from "../src/adapters/chatgpt-web/concurrency";

const GiB = 1024 ** 3;
const sample = (memoryGiB: number, load = 1, cpus = 16, activeTurns = 0) =>
  ({ availableMemoryBytes: memoryGiB * GiB, cpuCount: cpus, loadAverageOneMinute: load, activeTurns });

describe("reactive browser admission capacity", () => {
  test("a healthy host may use the whole user-selected ceiling", () => {
    expect(estimateBrowserCapacity(sample(1024, 0, 256))).toBe(MAX_CHATGPT_BROWSER_TABS);
    expect(estimateBrowserCapacity(sample(20, 4, 32))).toBe(MAX_CHATGPT_BROWSER_TABS);
    expect(estimateBrowserCapacity(sample(20, 4, 32), { ...DEFAULT_BROWSER_CAPACITY_LIMITS, max: 7 })).toBe(7);
  });

  test("memory pressure stops new admissions without preempting running turns", () => {
    // Four GiB is the default reserve; one tab may still be probed on an idle host.
    expect(estimateBrowserCapacity(sample(4, 0, 64))).toBe(1);
    expect(estimateBrowserCapacity(sample(3, 0, 64, 6))).toBe(6);
  });

  test("CPU pressure stops new admissions without preempting running turns", () => {
    expect(estimateBrowserCapacity(sample(32, 12, 16))).toBe(1);
    expect(estimateBrowserCapacity(sample(32, 12, 16, 4))).toBe(4);
  });

  test("invalid or missing samples fall back to the minimum probe", () => {
    expect(estimateBrowserCapacity(null)).toBe(1);
    expect(estimateBrowserCapacity(sample(Number.NaN))).toBe(1);
    expect(estimateBrowserCapacity(sample(20, -1))).toBe(1);
    expect(estimateBrowserCapacity(sample(20, 1, 0))).toBe(1);
  });

  test("validates the shared configurable physical ceiling", () => {
    expect(browserTurnCeiling('12')).toBe(12);
    for (const value of ['0', '-1', '129', 'Infinity', '4.5', '']) expect(() => browserTurnCeiling(value)).toThrow();
  });

  test("keeps idle conversation tabs on their own small ceiling", () => {
    // One retained tab is a full ChatGPT renderer, so retention must not scale with the turn limit.
    expect(retainedChatGptTabs('', 32)).toBe(2);
    expect(retainedChatGptTabs('0', 32)).toBe(0);
    expect(retainedChatGptTabs('4', 32)).toBe(4);
    expect(retainedChatGptTabs('1', 1)).toBe(1);
    for (const value of ['-1', '33', '2.5', 'many']) expect(() => retainedChatGptTabs(value, 32)).toThrow();
  });

  test("rejects unsafe capacity policy settings", () => {
    expect(() => estimateBrowserCapacity(sample(32), { ...DEFAULT_BROWSER_CAPACITY_LIMITS, min: 0 })).toThrow();
    expect(() => new BrowserCapacityController(DEFAULT_BROWSER_CAPACITY_LIMITS, 0)).toThrow();
  });

  test("throttles immediately and restores the ceiling after sustained healthy samples", () => {
    const controller = new BrowserCapacityController(DEFAULT_BROWSER_CAPACITY_LIMITS, 3, 10_000);
    const healthy = sample(64, 0, 32);
    expect(controller.current()).toBe(MAX_CHATGPT_BROWSER_TABS);
    expect(controller.update(sample(4, 0, 32, 2), 0)).toBe(2);
    expect(controller.update(healthy, 1)).toBe(2);
    expect(controller.update(healthy, 2)).toBe(2);
    expect(controller.update(healthy, 11_000)).toBe(MAX_CHATGPT_BROWSER_TABS);
  });

  test("invalid samples never restore capacity on stale confidence", () => {
    const controller = new BrowserCapacityController(DEFAULT_BROWSER_CAPACITY_LIMITS, 2, 0);
    expect(controller.update(null, 0)).toBe(1);
    expect(controller.update(sample(64, 0, 32), 1)).toBe(1);
    expect(controller.update(null, 2)).toBe(1);
    expect(controller.update(sample(64, 0, 32), 3)).toBe(1);
    expect(controller.update(sample(64, 0, 32), 4)).toBe(MAX_CHATGPT_BROWSER_TABS);
  });
});
