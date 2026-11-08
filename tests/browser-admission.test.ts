import { describe, expect, test } from "bun:test";
import { ChatGptBrowserAdmission } from "../src/adapters/chatgpt-web/browser-admission";

describe("bounded browser admission", () => {
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
