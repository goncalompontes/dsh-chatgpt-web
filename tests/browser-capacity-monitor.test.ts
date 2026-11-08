import { describe, expect, test } from "bun:test";
import { ChatGptBrowserAdmission } from "../src/adapters/chatgpt-web/browser-admission";
import { BrowserCapacityController } from "../src/adapters/chatgpt-web/browser-capacity";
import { BrowserAdmissionCapacityMonitor } from "../src/adapters/chatgpt-web/browser-capacity-monitor";

const GiB = 1024 ** 3;
const healthy = { availableMemoryBytes: 64 * GiB, cpuCount: 32, loadAverageOneMinute: 0 };
const constrained = { availableMemoryBytes: 4 * GiB, cpuCount: 32, loadAverageOneMinute: 0 };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("adaptive admission monitor", () => {
  test("starts at one, scales up through healthy observations, and grants FIFO waiters", async () => {
    const admission = new ChatGptBrowserAdmission(5);
    const monitor = new BrowserAdmissionCapacityMonitor(
      admission, new BrowserCapacityController(undefined, 2, 0), () => healthy, 60_000, () => 10,
    );
    try {
      monitor.start();
      expect(admission.snapshot()).toEqual({ active: 0, pending: 0, capacity: 1 });
      const releaseFirst = await admission.acquire();
      const order: string[] = [];
      const second = admission.acquire().then(release => { order.push("second"); return release; });
      const third = admission.acquire().then(release => { order.push("third"); return release; });
      await tick();
      expect(admission.snapshot()).toEqual({ active: 1, pending: 2, capacity: 1 });
      monitor.observe();
      const releaseSecond = await second;
      expect(order).toEqual(["second"]);
      expect(admission.snapshot()).toEqual({ active: 2, pending: 1, capacity: 2 });
      releaseFirst();
      const releaseThird = await third;
      expect(order).toEqual(["second", "third"]);
      releaseSecond();
      releaseThird();
      expect(admission.snapshot().active).toBe(0);
    } finally {
      monitor.stop();
    }
  });

  test("pressure reduces future capacity without preempting existing leases", async () => {
    const admission = new ChatGptBrowserAdmission(5);
    let current = healthy;
    const monitor = new BrowserAdmissionCapacityMonitor(
      admission, new BrowserCapacityController(undefined, 1, 0), () => current, 60_000,
    );
    try {
      monitor.start();
      const first = await admission.acquire();
      const second = await admission.acquire();
      expect(admission.snapshot().capacity).toBe(2);
      current = constrained;
      monitor.observe();
      expect(admission.snapshot()).toEqual({ active: 2, pending: 0, capacity: 1 });
      const ctrl = new AbortController();
      const blocked = admission.acquire(ctrl.signal);
      await tick();
      expect(admission.snapshot().pending).toBe(1);
      ctrl.abort();
      await expect(blocked).rejects.toHaveProperty("name", "AbortError");
      first();
      second();
      expect(admission.snapshot()).toEqual({ active: 0, pending: 0, capacity: 1 });
    } finally {
      monitor.stop();
    }
  });

  test("sampling failures fail closed and repeated starts do not double sample", () => {
    const admission = new ChatGptBrowserAdmission(5);
    let calls = 0;
    const monitor = new BrowserAdmissionCapacityMonitor(
      admission, new BrowserCapacityController(undefined, 1, 0),
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
