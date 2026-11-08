import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

test("lost completion acknowledgement retries only the result and rejects conflicting or retired receipts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-receipt-"));
  const broker = TurnBroker.forSocket(join(dir, "broker.sock"));
  let completions = 0;
  const proxy = createServer(socket => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", async chunk => {
      input += chunk;
      if (!input.includes("\n")) return;
      const { id, ...request } = JSON.parse(input);
      try {
        const result = await callTurnBroker(broker.socketPath, request);
        // The broker has accepted the result; its owner loses just the ACK.
        if (++completions === 1) socket.destroy();
        else socket.end(JSON.stringify({ id, result }) + "\n");
      } catch (error) {
        completions++;
        socket.end(JSON.stringify({ id, error: (error as Error).message }) + "\n");
      }
    });
  });
  try {
    const token = await broker.register({ cwd: dir, roots: [dir], writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [] });
    const activityId = "activity_receipt_regression";
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(broker.socketPath, { method: "claim", token, activityId });
    const batch = broker.nextToolBatch(token);
    const invocation = callTurnBroker(broker.socketPath, { method: "invoke", bindingId, wireName: "read", arguments: {} });
    const [call] = await batch;
    await new Promise<void>(resolve => proxy.listen(join(dir, "proxy.sock"), resolve));
    const owner = new RemoteTurnBroker(join(dir, "proxy.sock"));
    const result = { content: [{ type: "text", text: "original result" }], structuredContent: { b: 2, a: 1 } };
    await owner.completeTool(token, call!.callId, result);
    expect(completions).toBe(2);
    expect(await invocation).toEqual(result);
    // Wire-equivalent reordered keys are accepted, with no invocation to execute again.
    await owner.completeTool(token, call!.callId, { structuredContent: { a: 1, b: 2 }, content: result.content });
    await callTurnBroker(broker.socketPath, { method: "activity_complete", token, activityId });
    expect(broker.beginCompletionFence(token)).toBeDefined();
    await expect(owner.completeTool(token, call!.callId, { content: [{ type: "text", text: "conflicting result" }] }))
      .rejects.toThrow("conflicts");
    expect(completions).toBe(4); // Server rejection is not retried.
    await expect(owner.completeTool(token, "unknown-call", result)).rejects.toThrow("not pending");
    expect(completions).toBe(5);
    broker.requestCompaction(token, { content: [{ type: "text", text: "checkpoint requested" }] });
    await owner.completeTool(token, call!.callId, result);
    expect(completions).toBe(6); // Accepted results remain retryable across compaction.
    broker.revoke(token);
    await expect(owner.completeTool(token, call!.callId, result)).rejects.toThrow("invalid or expired");
    expect(completions).toBe(7);
  } finally {
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
