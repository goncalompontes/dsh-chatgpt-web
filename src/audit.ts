/**
 * Native tool-call audit sink.
 *
 * The bridge is the single choke point for the connector's `tool_call`
 * surface. Writing the nested call's arguments and result here means the
 * audit console sees full payloads without requiring a separate HTTP proxy.
 * Set DSH_AUDIT_NATIVE=0 when running the recording proxy to avoid duplicate
 * records.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DISABLED = process.env.DSH_AUDIT_NATIVE === "0"
  || process.env.DSH_AUDIT_NATIVE === "false"
  || process.env.NODE_ENV === "test"
  || process.env.BUN_TEST === "1"
  || process.env.VITEST === "true";
const LOG_PATH = process.env.DSH_AUDIT_LOG
  || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "dsh-audit", "capture.jsonl");

let announced = false;

function marker(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `[redacted sha256=${hash} len=${value.length}]`;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

const SENSITIVE = /^(authorization|cookie|set-cookie|mcp-session-id|session_?token|turn_?token|request_?id|access_?token|refresh_?token|client_?secret|client_?assertion|code_?verifier|api_?key|password|passwd|secret|token)$/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
      if (SENSITIVE.test(key) && typeof child === "string") {
        out[key] = marker(child);
      } else if (key === "url" || key === "uri" || key === "href" || key === "endpoint") {
        out[key] = typeof child === "string"
          ? child.replace(/(\/mcp(?:-v2)?\/)([A-Za-z0-9._~-]{16,})/g, (_all, prefix, token) => `${prefix}${marker(token)}`)
          : redact(child);
      } else {
        out[key] = redact(child);
      }
    }
    return out;
  }
  if (typeof value === "string") {
    return value
      .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi, (_all, prefix, token) => `${prefix}${marker(token)}`)
      .replace(/(\/mcp(?:-v2)?\/)([A-Za-z0-9._~-]{16,})/g, (_all, prefix, token) => `${prefix}${marker(token)}`);
  }
  return value;
}

function write(event: Record<string, unknown>): void {
  if (DISABLED) return;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true, mode: 0o700 });
    appendFileSync(LOG_PATH, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`[chatgpt-web-audit] capture write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function announce(): void {
  if (announced || DISABLED) return;
  announced = true;
  write({
    kind: "capture_started",
    v: 1,
    ts: new Date().toISOString(),
    version: "native",
    pid: process.pid,
    mode: "bridge-native",
    upstream: null,
    redaction: "redact",
  });
}

export interface AuditBatchCall {
  wireName: string;
  payload: { arguments?: Record<string, unknown>; input?: string };
}

export interface AuditBatchResult {
  result?: {
    content?: unknown[];
    structuredContent?: unknown;
    isError?: boolean;
    _meta?: unknown;
  };
  error?: string;
}

export interface AuditToolBatch {
  turnToken: string;
  calls: AuditBatchCall[];
  results: AuditBatchResult[];
  startedAt: number;
  endedAt: number;
}

export function auditToolBatch(batch: AuditToolBatch): void {
  if (DISABLED || !batch.turnToken || batch.calls.length === 0) return;
  announce();
  const id = randomUUID();
  const rpcId = 1;
  const session = fingerprint(batch.turnToken);
  const request = {
    jsonrpc: "2.0",
    id: rpcId,
    method: "tools/call",
    params: {
      name: "tool_call",
      arguments: {
        session_token: batch.turnToken,
        calls: batch.calls.map(call => ({
          wire_name: call.wireName,
          ...(call.payload.input !== undefined
            ? { input: call.payload.input }
            : { arguments: call.payload.arguments ?? {} }),
        })),
      },
    },
  };
  write({
    kind: "mcp",
    v: 1,
    ts: new Date(batch.startedAt).toISOString(),
    id,
    direction: "request",
    transport: "http",
    message: redact(request),
    method: "tools/call",
    rpc_id: rpcId,
    session,
    trace: null,
    action: null,
    tools: batch.calls.map(call => call.wireName),
    error: null,
  });

  const entries = batch.calls.map((call, index) => {
    const outcome = batch.results[index];
    const isError = outcome?.error !== undefined || outcome?.result?.isError === true;
    const content = isError
      ? [{ type: "text", text: outcome?.error ?? "tool call failed" }]
      : Array.isArray(outcome?.result?.content) ? outcome!.result!.content : [];
    return {
      index,
      wire_name: call.wireName,
      isError,
      content,
    };
  });
  const anyError = entries.some(entry => entry.isError);
  const response = {
    jsonrpc: "2.0",
    id: rpcId,
    result: {
      content: entries.flatMap(entry => [
        { type: "text", text: JSON.stringify({ index: entry.index, wire_name: entry.wire_name, isError: entry.isError }) },
        ...entry.content,
      ]),
      structuredContent: { results: entries },
      ...(anyError ? { isError: true } : {}),
    },
  };
  write({
    kind: "mcp",
    v: 1,
    ts: new Date(batch.endedAt).toISOString(),
    id,
    direction: "response",
    transport: "http",
    message: redact(response),
    method: null,
    rpc_id: rpcId,
    session: null,
    trace: null,
    action: null,
    tools: null,
    error: entries.find(entry => entry.isError)?.content?.[0] &&
      (entries.find(entry => entry.isError)!.content[0] as { text?: string }).text
      || null,
  });
}

// Announce the sink at bridge startup so operators can see it is active.
if (!DISABLED) announce();
