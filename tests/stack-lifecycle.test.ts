import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../src/plugin";
import { defaultConfig } from "../src/config";

test("DSH unsuccessful termination forwards only the exact turn sent to this sidecar", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-cancel-plugin-"));
  const previous = process.env.DSH_CHATGPT_WEB_HOME;
  const previousFree = process.env.DSH_CHATGPT_FREE_HOME;
  process.env.DSH_CHATGPT_WEB_HOME = root;
  delete process.env.DSH_CHATGPT_FREE_HOME;
  const config = defaultConfig();
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const calls: Array<{ url: string; body: any }> = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: any, options: any) => {
    expect(options.headers.Authorization).toBe(`Bearer ${config.controlToken}`);
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json({ status: "ok" });
  }) as typeof fetch);
  try {
    const hooks = new Map<string, (...args: any[]) => any>();
    apply({ on: (name, callback) => hooks.set(name, callback), effect: () => {} }, { autoStart: false });
    const event = hooks.get("session/event")!;
    const headers = hooks.get("llm-pi-ai/request-headers")!;
    const start = (id: string, turn: number) => event({ id }, { type: "turn/start", data: { turn } });
    const end = (id: string, turn: number, kind = "aborted") => event({ id }, { type: "turn/end", data: { turn, reason: { kind } } });
    const request = (id: string, baseURL = "http://127.0.0.1:17841/v1") => {
      const result = new Headers();
      return headers({ sessionId: id, baseURL }, result, () => result);
    };
    start("session-a", 1);
    expect(request("session-a").get("x-dsh-turn-id")).toBe("dsh-turn-1");
    await end("session-a", 1);
    expect(calls).toEqual([{ url: "http://127.0.0.1:17841/admin/interrupt-turn",
      body: { threadId: "dsh-session-a", turnId: "dsh-turn-1" } }]);
    start("session-a", 2);
    request("session-a");
    await end("session-a", 1); // delayed old event cannot cancel the replacement
    start("other-provider", 1);
    request("other-provider", "https://api.example.com/v1");
    await end("other-provider", 1);
    await end("session-a", 2, "completed");
    expect(calls).toHaveLength(1);
    for (const kind of ["error", "blocked", "max-tokens"]) {
      start("session-a", 3);
      request("session-a");
      await end("session-a", 3, kind);
      await end("session-a", 3, kind); // duplicate terminal event is idempotent
      expect(calls.at(-1)?.body).toEqual({ threadId: "dsh-session-a", turnId: "dsh-turn-3" });
    }
    expect(calls).toHaveLength(4);
  } finally {
    fetchSpy.mockRestore();
    if (previous === undefined) delete process.env.DSH_CHATGPT_WEB_HOME;
    else process.env.DSH_CHATGPT_WEB_HOME = previous;
    if (previousFree !== undefined) process.env.DSH_CHATGPT_FREE_HOME = previousFree;
    rmSync(root, { recursive: true, force: true });
  }
});

test("native DSH header hook carries stable session and compaction purpose only to this sidecar", () => {
  let hook: ((...args: any[]) => Headers) | undefined;
  apply({ on: (event, callback) => { if (event === "llm-pi-ai/request-headers") hook = callback; },
    effect: () => {} }, { autoStart: false });
  const headers = new Headers({ "x-existing": "keep" });
  const result = hook!({ baseURL: "http://127.0.0.1:17841/v1", sessionId: "session-123", purpose: "compaction" }, headers, () => headers);
  expect(result.get("x-dsh-session-id")).toBe("session-123");
  expect(result.get("x-dsh-request-purpose")).toBe("compaction");
  expect(result.get("x-existing")).toBe("keep");
  const other = new Headers();
  hook!({ baseURL: "https://api.openai.com/v1", sessionId: "private-session" }, other, () => other);
  expect(other.get("x-dsh-session-id")).toBeNull();
});

test("shared stack receives a host PID lease and survives plugin disposal", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-stack-plugin-"));
  const record = join(root, "args.json");
  const script = join(root, "fake-stack.cjs");
  writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)))`);
  let dispose: (() => void) | undefined;
  try {
    apply({ effect: (effect: () => (() => void)) => { dispose = effect(); } } as any,
      { stackCommand: [process.execPath, script] });
    for (let i = 0; i < 100 && !existsSync(record); i++) await Bun.sleep(20);
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual(["ensure", "--client-pid", String(process.pid)]);
    dispose?.();
    expect(existsSync(record)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
