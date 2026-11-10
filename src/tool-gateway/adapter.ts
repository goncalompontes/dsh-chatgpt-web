/**
 * Harness-agnostic Tool Gateway adapter SDK.
 *
 * The gateway exposes one stable MCP tool (`tool_call`). A harness connects to
 * the gateway's session broker, registers the tools it can execute for a
 * session, and then serves pending calls until the session ends. The gateway
 * owns naming, inventory, validation and batching; the adapter owns execution,
 * approvals, sandboxing, cancellation and result content.
 *
 * This is the only integration surface a harness needs. DSH, OpenCode, Codex,
 * Claude and future harnesses can all use the same protocol.
 */
import type { ChatGptTurnEnvironment } from "../adapters/chatgpt-web/environment";
import {
  callTurnBroker,
  type BrokerToolRequest,
  type BrokerToolResult,
} from "../adapters/chatgpt-web/turn-broker";

export type ToolGatewaySession = ChatGptTurnEnvironment;

export type ToolGatewayCall = BrokerToolRequest;
export type ToolGatewayResult = BrokerToolResult;

export interface ToolGatewayRegisterOptions {
  /** Session lifetime hint. The gateway may prune the session after this. */
  ttlMs?: number;
  /** Optional trace id for diagnostics (6-128 chars, [A-Za-z0-9_-]). */
  traceId?: string;
}

export type ToolGatewayHandler = (
  call: ToolGatewayCall,
  signal: AbortSignal,
) => Promise<ToolGatewayResult> | ToolGatewayResult;

/**
 * Client side of the session broker. Use `connect()` once per harness process
 * and `register()` once per agent session.
 */
export class ToolGatewayAdapter {
  private constructor(private readonly socketPath: string) {}

  static connect(socketPath: string): ToolGatewayAdapter {
    return new ToolGatewayAdapter(socketPath);
  }

  /** Publish a session's tool inventory and receive its opaque session token. */
  async register(
    session: ToolGatewaySession,
    options: ToolGatewayRegisterOptions = {},
  ): Promise<string> {
    const response = await callTurnBroker<{ token: string }>(this.socketPath, {
      method: "owner_register",
      environment: session,
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
    });
    return response.token;
  }

  /** Replace the session's inventory or workspace metadata. */
  async update(sessionToken: string, session: ToolGatewaySession): Promise<void> {
    await callTurnBroker(this.socketPath, {
      method: "owner_update",
      token: sessionToken,
      environment: session,
    });
  }

  /** Long-poll for the next batch of tool calls for this session. */
  async next(sessionToken: string, signal?: AbortSignal): Promise<ToolGatewayCall[]> {
    const response = await callTurnBroker<{ requests: ToolGatewayCall[] }>(
      this.socketPath,
      { method: "owner_next", token: sessionToken },
      null,
      signal,
    );
    return response.requests;
  }

  /** Complete one pending call. The result content is forwarded to the model. */
  async complete(
    sessionToken: string,
    callId: string,
    result: ToolGatewayResult,
  ): Promise<void> {
    await callTurnBroker(this.socketPath, {
      method: "owner_complete",
      token: sessionToken,
      callId,
      toolResult: result,
    });
  }

  /** Revoke the session and reject any pending calls. */
  async revoke(sessionToken: string, reason?: string): Promise<void> {
    await callTurnBroker(this.socketPath, {
      method: "owner_revoke",
      token: sessionToken,
      ...(reason === undefined ? {} : { summary: reason }),
    });
  }

  /**
   * Serve a session until the signal aborts. Handler failures are returned to
   * the model as per-call errors so one bad tool cannot strand the session.
   */
  async run(
    sessionToken: string,
    handler: ToolGatewayHandler,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      let calls: ToolGatewayCall[];
      try {
        calls = await this.next(sessionToken, signal);
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      for (const call of calls) {
        let result: ToolGatewayResult;
        try {
          result = await handler(call, signal);
        } catch (error) {
          result = {
            isError: true,
            content: [{
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            }],
          };
        }
        await this.complete(sessionToken, call.callId, result).catch(error => {
          if (!signal.aborted) throw error;
        });
        if (signal.aborted) return;
      }
    }
  }
}
