import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../src/plugin";

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
