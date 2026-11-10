import { describe, expect, test } from "bun:test";
import { browserTurnFloor, MAX_CHATGPT_BROWSER_TABS } from "../src/adapters/chatgpt-web/concurrency";
import { BrowserCapacityController } from "../src/adapters/chatgpt-web/browser-capacity";
import {
  ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions, chatGptWebMaxAdmissionWaitMs,
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
      browser.resolve("cancelled");
      physical.resolve();
    },
  };
  return { runtime, browser, physical };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe("multi-tab browser admission", () => {
  test("a rate-limited memory host can opt into a tab floor without exceeding the ceiling", () => {
    expect(browserTurnFloor(undefined)).toBe(1);
    expect(browserTurnFloor("3", MAX_CHATGPT_BROWSER_TABS)).toBe(3);
    expect(() => browserTurnFloor("0", 8)).toThrow("between 1 and 128");
    expect(() => browserTurnFloor("9", 8)).toThrow("must not exceed");
    expect(() => browserTurnFloor("many", 8)).toThrow("between 1 and 128");
  });

  test("the capacity controller runs at the ceiling and throttles to the configured floor under pressure", () => {
    const controller = new BrowserCapacityController({
      min: 2, max: 8, memoryReserveBytes: 2 * 1024 ** 3, cpuHeadroomFraction: 0.5,
    });
    expect(controller.current()).toBe(8);
    // Real pressure reduces admission to the running/floor count, not the predictive slot model.
    expect(controller.update({ availableMemoryBytes: 1 * 1024 ** 3, cpuCount: 8, loadAverageOneMinute: 0, activeTurns: 1 }, 0)).toBe(2);
  });
});

describe("stalled continuation recovery", () => {
  test("tool results join the active turn even when the caller changed the execution key", async () => {
    const sessions = new ChatGptTurnSessions();
    const first = mockRuntime();
    const active = await sessions.getOrCreateAfterOwnerRetirement(
      "original-key", "owner", () => first.runtime, "trace-original",
      undefined, "native-turn", "native-thread",
    );
    active.setOutstanding([{
      callId: "call-1", wireName: "bash", freeform: false, arguments: {},
    }], [], []);

    let started = 0;
    const joined = await sessions.getOrCreateAfterOwnerRetirement(
      "rewritten-key", "owner", () => { started++; return mockRuntime().runtime; },
      "trace-continuation", undefined, "native-turn", "native-thread",
      undefined, new Set(["call-1|response-item-suffix"]),
    );
    expect(joined).toBe(active);
    expect(started).toBe(0);
    first.runtime.cancel();
  });

  test("unrelated results still wait for the active turn to settle", async () => {
    const sessions = new ChatGptTurnSessions();
    const first = mockRuntime();
    const active = await sessions.getOrCreateAfterOwnerRetirement(
      "original-key", "owner", () => first.runtime, "trace-original",
      undefined, "native-turn", "native-thread",
    );
    active.setOutstanding([{
      callId: "call-1", wireName: "bash", freeform: false, arguments: {},
    }], [], []);
    const abort = new AbortController();
    const waiting = sessions.getOrCreateAfterOwnerRetirement(
      "other-turn", "owner", () => mockRuntime().runtime, "trace-next",
      abort.signal, "native-turn", "native-thread",
      undefined, new Set(["someone-else"]),
    );
    await sleep(5);
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    first.runtime.cancel();
  });

  test("a queued turn eventually fails instead of hanging behind a wedged lane", () => {
    expect(chatGptWebMaxAdmissionWaitMs(undefined)).toBe(10 * 60_000);
    expect(chatGptWebMaxAdmissionWaitMs("1500")).toBe(1_500);
    expect(() => chatGptWebMaxAdmissionWaitMs("999")).toThrow("between 1000 and 86400000");
    expect(() => chatGptWebMaxAdmissionWaitMs("later")).toThrow("between 1000 and 86400000");
  });

  test("a joined continuation retires the registry key that owns the session", async () => {
    const sessions = new ChatGptTurnSessions();
    const first = mockRuntime();
    const active = await sessions.getOrCreateAfterOwnerRetirement(
      "original-key", "owner", () => first.runtime, "trace-original",
      undefined, "native-turn", "native-thread",
    );
    active.setOutstanding([{
      callId: "call-1", wireName: "bash", freeform: false, arguments: {},
    }], [], []);
    const joined = await sessions.getOrCreateAfterOwnerRetirement(
      "rewritten-key", "owner", () => mockRuntime().runtime, "trace-continuation",
      undefined, "native-turn", "native-thread", undefined, new Set(["call-1"]),
    );
    expect(sessions.keyFor(joined)).toBe("original-key");
    expect(sessions.retireSession(joined)).toBe(true);
    expect(sessions.find("original-key")).toBeUndefined();
  });

  test("an abandoned turn releases its browser lease instead of blocking the queue", async () => {
    const sessions = new ChatGptTurnSessions();
    const abandoned = mockRuntime();
    const session = await sessions.getOrCreateAfterOwnerRetirement(
      "abandoned-key", "owner", () => abandoned.runtime, "trace-abandoned",
    );
    sessions.scheduleAbandonedRetirement("abandoned-key", session, 10);
    await sleep(30);
    expect(sessions.find("abandoned-key")).toBeUndefined();
    // The retired turn's own runtime was cancelled, so its admission lease is released.
    expect(abandoned.browser.promise).resolves.toBe("cancelled");
  });

  test("a reconnecting continuation cancels the abandonment timer", async () => {
    const sessions = new ChatGptTurnSessions();
    const runtime = mockRuntime();
    const session = await sessions.getOrCreateAfterOwnerRetirement(
      "reconnect-key", "owner", () => runtime.runtime, "trace-reconnect",
    );
    sessions.scheduleAbandonedRetirement("reconnect-key", session, 20);
    await sessions.getOrCreateAfterOwnerRetirement(
      "reconnect-key", "owner", () => mockRuntime().runtime, "trace-reconnect",
    );
    await sleep(40);
    expect(sessions.find("reconnect-key")).toBe(session);
    runtime.runtime.cancel();
  });
});
