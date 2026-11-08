import { describe, expect, test } from "bun:test";
import {
  ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions,
  type ChatGptTurnRuntime,
} from "../src/adapters/chatgpt-web/turn-execution";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function mockRuntime() {
  const browser = deferred<string>();
  const physical = deferred<void>();
  const runtime: ChatGptTurnRuntime = {
    mode: "read-only", browser: browser.promise, physicalSettlement: physical.promise,
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel: () => {
      browser.resolve("cancelled"); physical.resolve();
    },
  };
  return { runtime, browser, physical };
}

const microtasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("native session admission", () => {
  test("queues a sixth owner without creating a browser until physical settlement", async () => {
    const sessions = new ChatGptTurnSessions();
    const runtimes: ReturnType<typeof mockRuntime>[] = [];
    const start = () => { const r = mockRuntime(); runtimes.push(r); return r.runtime; };
    const first = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      sessions.getOrCreateAfterOwnerRetirement(`key-${i}`, `owner-${i}`, start)));
    expect(first).toHaveLength(5);
    expect(runtimes).toHaveLength(5);
    const sixth = sessions.getOrCreateAfterOwnerRetirement("key-5", "owner-5", start);
    await microtasks();
    expect(runtimes).toHaveLength(5);
    runtimes[0]!.browser.resolve("done");
    await microtasks();
    expect(runtimes).toHaveLength(5);
    runtimes[0]!.physical.resolve();
    const admitted = await sixth;
    expect(admitted.ownerKey).toBe("owner-5");
    expect(runtimes).toHaveLength(6);
    for (const r of runtimes) { r.browser.resolve("done"); r.physical.resolve(); }
  });

  test("a rejected physical settlement does not poison later same-owner admission", async () => {
    const sessions = new ChatGptTurnSessions();
    const first = mockRuntime();
    first.runtime.cancel = () => { first.browser.resolve("cancelled"); };
    const session = await sessions.getOrCreateAfterOwnerRetirement(
      "first", "same-owner", () => first.runtime,
    );
    const retirement = sessions.retireAndWait("first");
    const failure = new Error("launcher cleanup failed");
    first.physical.reject(failure);
    await expect(retirement).rejects.toThrow("launcher cleanup failed");
    expect(session.isPhysicallySettled()).toBe(true);
    const second = mockRuntime();
    const admitted = await sessions.getOrCreateAfterOwnerRetirement(
      "second", "same-owner", () => second.runtime,
    );
    expect(admitted.ownerKey).toBe("same-owner");
    second.browser.resolve("done");
    second.physical.resolve();
  });

  test("turn capability is retired even when physical teardown rejects", async () => {
    const sessions = new ChatGptTurnSessions();
    const first = mockRuntime();
    let retirements = 0;
    first.runtime.retireCapability = async () => { retirements += 1; };
    const session = await sessions.getOrCreateAfterOwnerRetirement(
      "failed-capability", "capability-owner", () => first.runtime,
    );
    await session.runExclusive(async () => {});
    const failure = new Error("launcher capability teardown failed");
    first.physical.reject(failure);
    await expect(session.physicalSettlement).rejects.toBe(failure);
    await microtasks();
    expect(retirements).toBe(1);
    first.browser.resolve("done");
  });

  test("retained conversation release runs even when physical teardown rejects", async () => {
    const sessions = new ChatGptTurnSessions();
    const first = mockRuntime();
    let releases = 0;
    first.runtime.conversationKey = "conversation-1";
    first.runtime.releaseRetainedConversation = async () => { releases += 1; };
    first.runtime.cancel = () => { first.browser.resolve("cancelled"); };
    await sessions.getOrCreateAfterOwnerRetirement("first", "same-owner", () => first.runtime);
    const closing = sessions.retireConversationAndWait("conversation-1");
    const failure = new Error("launcher teardown failed");
    first.physical.reject(failure);
    await expect(closing).rejects.toThrow("launcher teardown failed");
    expect(releases).toBe(1);
  });

  test("aborted waiter never invokes the runtime factory", async () => {
    const sessions = new ChatGptTurnSessions();
    const runtimes: ReturnType<typeof mockRuntime>[] = [];
    const start = () => { const r = mockRuntime(); runtimes.push(r); return r.runtime; };
    await Promise.all(Array.from({ length: 5 }, (_, i) =>
      sessions.getOrCreateAfterOwnerRetirement(`key-${i}`, `owner-${i}`, start)));
    const controller = new AbortController();
    const blocked = sessions.getOrCreateAfterOwnerRetirement("blocked", "other", start, undefined, controller.signal);
    await microtasks();
    controller.abort();
    expect(blocked).rejects.toHaveProperty("name", "AbortError");
    expect(runtimes).toHaveLength(5);
    for (const r of runtimes) { r.browser.resolve("done"); r.physical.resolve(); }
  });
});
