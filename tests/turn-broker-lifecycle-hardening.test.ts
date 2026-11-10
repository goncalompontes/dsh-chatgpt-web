import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

const environment = (cwd: string) => ({
  cwd,
  roots: [cwd],
  writableRoots: [],
  sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
  tools: [],
});

async function withBroker(run: (broker: TurnBroker, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dsh-broker-lifecycle-"));
  const broker = TurnBroker.forSocket(join(dir, "broker.sock"));
  try {
    await run(broker, dir);
  } finally {
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("completion fence prevents new invocations through an already-issued binding", async () => {
  await withBroker(async (broker, dir) => {
    const token = await broker.register(environment(dir));
    const activityId = "activity_fence_regression";
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim", token, activityId,
    });
    await callTurnBroker(broker.socketPath, { method: "activity_complete", token, activityId });
    const revision = broker.beginCompletionFence(token);
    expect(revision).toBeDefined();
    expect(broker.commitCompletionFence(token, revision!)).toBe(true);
    expect(broker.commitCompletionFence(token, revision!)).toBe(true); // Retried ACK.

    // Before the fix, invoke is accepted and hangs waiting for a finalized owner's next batch.
    await expect(callTurnBroker(broker.socketPath, {
      method: "invoke", bindingId, wireName: "read", arguments: {},
    }, 100)).rejects.toThrow(/already finished|completion/);
    expect(broker.beginCompletionFence(token)).toBe(revision);
    const aborted = new AbortController();
    aborted.abort();
    await expect(broker.nextToolBatch(token, aborted.signal)).rejects.toThrow("aborted");
  });
});

test("cancelled owner poll cannot redeliver an outstanding invocation", async () => {
  await withBroker(async (broker, dir) => {
    const token = await broker.register(environment(dir));
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim", token, activityId: "activity_cancel_regression",
    });
    const pending = callTurnBroker(broker.socketPath, {
      method: "invoke", bindingId, wireName: "read", arguments: {},
    });
    const [tool] = await broker.nextToolBatch(token);
    const controller = new AbortController();
    controller.abort();
    await expect(broker.nextToolBatch(token, controller.signal)).rejects.toThrow("aborted");
    // The original delivered call remains recoverable by a live owner, not lost by cancellation.
    expect(await broker.nextToolBatch(token)).toEqual([tool]);
    const result = { content: [{ type: "text", text: "once" }] };
    broker.completeTool(token, tool!.callId, result);
    broker.completeTool(token, tool!.callId, result);
    expect(await pending).toEqual(result);
  });
});

test("cancelled waiting poll does not consume a later queued invocation", async () => {
  await withBroker(async (broker, dir) => {
    const token = await broker.register(environment(dir));
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim", token, activityId: "activity_waiter_regression",
    });
    const controller = new AbortController();
    const poll = broker.nextToolBatch(token, controller.signal);
    controller.abort();
    await expect(poll).rejects.toThrow("aborted");
    const pending = callTurnBroker(broker.socketPath, {
      method: "invoke", bindingId, wireName: "read", arguments: {},
    });
    const [tool] = await broker.nextToolBatch(token);
    broker.completeTool(token, tool!.callId, { content: [] });
    expect(await pending).toEqual({ content: [] });
  });
});
