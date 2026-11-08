import { describe, expect, test } from "bun:test";
import { ChatGptBrowserAdmission } from "../src/adapters/chatgpt-web/browser-admission";

describe("bounded browser admission", () => {
  test("a saturated 256-owner queue drains FIFO through cancellations and pressure reduction", async () => {
    const admission = new ChatGptBrowserAdmission(5, 256);
    const initial = await Promise.all(Array.from({ length: 5 }, () => admission.acquire()));
    const order: number[] = [];
    const controllers = Array.from({ length: 256 }, () => new AbortController());
    const cancelled: number[] = [];
    const pending = controllers.map((controller, index) => admission.acquire(controller.signal).then(release => {
      order.push(index);
      expect(admission.snapshot().active).toBeLessThanOrEqual(1);
      release();
    }, error => {
      expect(error.name).toBe("AbortError");
      cancelled.push(index);
    }));
    await expect(admission.acquire()).rejects.toThrow("queue is full");
    admission.setCapacity(1);
    controllers.forEach((controller, index) => { if (index % 8 === 0) controller.abort(); });
    initial.slice(0, 4).forEach(release => release());
    await Promise.resolve();
    expect(order).toEqual([]);
    initial[4]!();
    await Promise.all(pending);
    expect(order).toEqual(Array.from({ length: 256 }, (_, index) => index).filter(index => index % 8 !== 0));
    expect(cancelled).toHaveLength(32);
    expect(admission.metrics()).toMatchObject({ active: 0, pending: 0, admitted: 229, cancelled: 32, rejected: 1 });
  });

  test("queue metrics distinguish overload, cancellation and actual admission latency", async () => {
    let now = 100;
    const queue = new ChatGptBrowserAdmission(1, 2, () => now);
    const first = await queue.acquire();
    const cancelled = new AbortController();
    const second = queue.acquire(cancelled.signal).catch(error => error.name);
    const third = queue.acquire();
    await expect(queue.acquire()).rejects.toThrow("queue is full");
    now = 150;
    expect(queue.metrics().oldestPendingMs).toBe(50);
    cancelled.abort();
    expect(await second).toBe("AbortError");
    now = 200;
    first();
    const release = await third;
    expect(queue.metrics()).toMatchObject({ active: 1, pending: 0, admitted: 2, cancelled: 1,
      rejected: 1, totalQueueWaitMs: 100, maxQueueWaitMs: 100, oldestPendingMs: 0 });
    release();
  });

  test("admits FIFO without exceeding the physical limit", async () => {
    const queue = new ChatGptBrowserAdmission(2);
    const a = await queue.acquire();
    const b = await queue.acquire();
    const granted: string[] = [];
    const c = queue.acquire().then(release => { granted.push("c"); return release; });
    const d = queue.acquire().then(release => { granted.push("d"); return release; });
    expect(queue.snapshot()).toEqual({ active: 2, pending: 2, capacity: 2 });
    b();
    const releaseC = await c;
    expect(granted).toEqual(["c"]);
    expect(queue.snapshot().active).toBe(2);
    a();
    const releaseD = await d;
    expect(granted).toEqual(["c", "d"]);
    releaseC();
    releaseC();
    releaseD();
    expect(queue.snapshot()).toEqual({ active: 0, pending: 0, capacity: 2 });
  });

  test("removes aborted waiters and preserves the next turn", async () => {
    const queue = new ChatGptBrowserAdmission(1);
    const a = await queue.acquire();
    const controller = new AbortController();
    const aborted = queue.acquire(controller.signal).then(() => "unexpected", error => error.name);
    const next = queue.acquire();
    controller.abort();
    expect(await aborted).toBe("AbortError");
    expect(queue.snapshot().pending).toBe(1);
    a();
    const releaseNext = await next;
    releaseNext();
    expect(queue.snapshot().active).toBe(0);
  });

  test("rejects bounded overload without affecting existing work", async () => {
    const queue = new ChatGptBrowserAdmission(1, 1);
    const release = await queue.acquire();
    const waiting = queue.acquire();
    expect(queue.acquire()).rejects.toThrow("queue is full");
    release();
    (await waiting)();
  });

  test("rejects an already-aborted request without using a slot", async () => {
    const queue = new ChatGptBrowserAdmission(1);
    const controller = new AbortController();
    controller.abort();
    expect(queue.acquire(controller.signal)).rejects.toHaveProperty("name", "AbortError");
    expect(queue.snapshot().active).toBe(0);
  });

  test("increases capacity while retaining FIFO order", async () => {
    const queue = new ChatGptBrowserAdmission(1);
    const first = await queue.acquire();
    const order: string[] = [];
    const second = queue.acquire().then(release => { order.push("second"); return release; });
    const third = queue.acquire().then(release => { order.push("third"); return release; });
    queue.setCapacity(3);
    const [releaseSecond, releaseThird] = await Promise.all([second, third]);
    expect(order).toEqual(["second", "third"]);
    expect(queue.snapshot()).toEqual({ active: 3, pending: 0, capacity: 3 });
    first();
    releaseSecond();
    releaseThird();
  });

  test("shrinks capacity without cancelling existing browser turns", async () => {
    const queue = new ChatGptBrowserAdmission(3);
    const first = await queue.acquire();
    const second = await queue.acquire();
    const third = await queue.acquire();
    queue.setCapacity(1);
    const next = queue.acquire();
    expect(queue.snapshot()).toEqual({ active: 3, pending: 1, capacity: 1 });
    first();
    second();
    await Promise.resolve();
    expect(queue.snapshot()).toEqual({ active: 1, pending: 1, capacity: 1 });
    third();
    (await next)();
    expect(queue.snapshot()).toEqual({ active: 0, pending: 0, capacity: 1 });
  });

  test("rejects invalid capacity changes without changing admission state", async () => {
    const queue = new ChatGptBrowserAdmission(2);
    expect(() => queue.setCapacity(0)).toThrow("Invalid browser admission capacity");
    expect(() => queue.setCapacity(1.5)).toThrow("Invalid browser admission capacity");
    expect(queue.snapshot()).toEqual({ active: 0, pending: 0, capacity: 2 });
  });
});
