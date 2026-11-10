import { describe, expect, test } from "bun:test";
import { ChatGptBrowserAdmission } from "../src/adapters/chatgpt-web/browser-admission";
import { BrowserCapacityController, DEFAULT_BROWSER_CAPACITY_LIMITS } from "../src/adapters/chatgpt-web/browser-capacity";
import { BrowserAdmissionCapacityMonitor } from "../src/adapters/chatgpt-web/browser-capacity-monitor";

const GiB = 1024 ** 3;
const healthy = { availableMemoryBytes: 64 * GiB, cpuCount: 32, loadAverageOneMinute: 0 };
const constrained = { availableMemoryBytes: 4 * GiB, cpuCount: 32, loadAverageOneMinute: 0, activeTurns: 2 };
const limits = { ...DEFAULT_BROWSER_CAPACITY_LIMITS, min: 1, max: 5 };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("adaptive admission monitor", () => {
  test("starts at the ceiling on a healthy host and grants FIFO waiters", async () => {
    const admission = new ChatGptBrowserAdmission(5);
    const monitor = new BrowserAdmissionCapacityMonitor(
      admission, new BrowserCapacityController(limits, 2, 0), () => healthy, 60_000, () => 10,
    );
    try {
      monitor.start();
      expect(admission.snapshot()).toEqual({ active: 0, pending: 0, capacity: 5 });
      const releases = [] as Array<() => void>;
      for (let index = 0; index < 5; index++) releases.push(await admission.acquire());
      expect(admission.snapshot()).toEqual({ active: 5, pending: 0, capacity: 5 });
      const order: string[] = [];
      const blocked = admission.acquire().then(release => { order.push("sixth"); return release; });
      await tick();
      expect(admission.snapshot()).toEqual({ active: 5, pending: 1, capacity: 5 });
      releases[0]!();
      const sixth = await blocked;
      expect(order).toEqual(["sixth"]);
      sixth();
      for (const release of releases.slice(1)) release();
      expect(admission.snapshot().active).toBe(0);
    } finally {
      monitor.stop();
    }
  });

  test("pressure reduces future capacity to the running turns without preempting leases", async () => {
    const admission = new ChatGptBrowserAdmission(5);
    let current = healthy;
    const monitor = new BrowserAdmissionCapacityMonitor(
      admission, new BrowserCapacityController(limits, 1, 0), () => current, 60_000,
    );
    try {
      monitor.start();
      const first = await admission.acquire();
      const second = await admission.acquire();
      expect(admission.snapshot().capacity).toBe(5);
      current = constrained;
      monitor.observe();
      expect(admission.snapshot()).toEqual({ active: 2, pending: 0, capacity: 2 });
      const ctrl = new AbortController();
      const blocked = admission.acquire(ctrl.signal);
      await tick();
      expect(admission.snapshot().pending).toBe(1);
      ctrl.abort();
      await expect(blocked).rejects.toHaveProperty("name", "AbortError");
      first();
      second();
      expect(admission.snapshot()).toEqual({ active: 0, pending: 0, capacity: 2 });
    } finally {
      monitor.stop();
    }
  });

  test("sampling failures fail closed and repeated starts do not double sample", () => {
    const admission = new ChatGptBrowserAdmission(5);
    let calls = 0;
    const monitor = new BrowserAdmissionCapacityMonitor(
      admission, new BrowserCapacityController(limits, 1, 0),
      () => { calls++; throw new Error("host temporarily unavailable"); }, 60_000,
    );
    try {
      monitor.start();
      monitor.start();
      expect(calls).toBe(1);
      expect(admission.snapshot().capacity).toBe(1);
    } finally {
      monitor.stop();
    }
  });
});
