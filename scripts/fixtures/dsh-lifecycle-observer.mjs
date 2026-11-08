// Explicit smoke-test overlay. It is never loaded by the production profile.
import { createServer } from "node:net";
import { appendFileSync, chmodSync, rmSync } from "node:fs";

export const name = "dsh-lifecycle-smoke-observer";
export const inject = ["agents", "compaction"];

export function apply(ctx, config) {
  const owned = new Set();
  const pending = new Set();
  const compacted = new Set();
  ctx.on("session/event", (session, event) => {
    const sessionId = session.header.id;
    if (event.type === "turn/start") owned.add(sessionId);
    if (!owned.has(sessionId)) return;
    if ((config.activeCompaction || config.activeFailure) && event.type === "tool/result"
      && event.data.turn >= 2 && !compacted.has(sessionId)) pending.add(sessionId);
    const { turn, step, compactionId, shadowedSeqs, error } = event.data;
    const callId = event.data.callId ?? event.data.message?.toolCallId;
    appendFileSync(config.events, JSON.stringify({ sessionId, type: event.type, seq: event.seq,
      turn, step, callId, compactionId, shadowedItems: shadowedSeqs?.length,
      ...(event.type === "tool/result" ? { isError: Boolean(event.data.message?.isError) } : {}),
      ...(event.type === "compaction/end" ? { error } : {}), time: Date.now() }) + "\n");
  });
  if (config.activeCompaction || config.activeFailure) ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const sessionId = agent.session.header.id;
    if (pending.delete(sessionId)) {
      compacted.add(sessionId);
      if (config.activeFailure) throw new Error("DSH_SMOKE_INJECTED_NATIVE_FAILURE");
      const result = await ctx.compaction.compactIfNeeded(agent, "context-overflow", signal);
      if (!result?.shadowedSeqs.length) throw new Error("No compactable history at the smoke tool boundary");
    }
    return next();
  });
  const server = createServer(socket => {
    socket.setEncoding("utf8");
    let input = "";
    let handled = false;
    socket.on("data", async chunk => {
      if (handled) return;
      input += chunk;
      if (input.length > 1024) { socket.destroy(); return; }
      if (!input.includes("\n")) return;
      handled = true;
      try {
        const command = JSON.parse(input);
        if (command.operation !== "compact" || !owned.has(command.sessionId)) throw new Error("unknown smoke session/operation");
        const agent = ctx.agents.get(command.sessionId);
        if (!agent || agent.session.header.id !== command.sessionId) throw new Error("smoke agent unavailable");
        const result = await ctx.compaction.compactNow(agent, AbortSignal.timeout(300_000));
        socket.end(JSON.stringify({ ok: true, shadowedItems: result?.shadowedSeqs.length ?? 0,
          summarySeq: result?.summarySeq }) + "\n");
      } catch (error) {
        socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n");
      }
    });
  });
  server.listen(config.socket, () => chmodSync(config.socket, 0o600));
  ctx.effect(() => () => { server.close(); rmSync(config.socket, { force: true }); });
}
