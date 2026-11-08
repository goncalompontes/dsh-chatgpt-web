import { expect, test } from "bun:test";
import { chatGptMcpInvocationTimeout } from "../src/adapters/chatgpt-web/mcp-server";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

const environment: ChatGptTurnEnvironment = {
  cwd: '/tmp', roots: ['/tmp'], writableRoots: [], tools: [],
  sandboxPolicy: { type: 'readOnly', networkAccess: false },
};

test('external MCP tool calls outlive the legacy tunnel deadline but respect turn expiry', () => {
  expect(chatGptMcpInvocationTimeout(environment, 100)).toBe(90_000);
  expect(chatGptMcpInvocationTimeout({ ...environment, mcpTransport: 'external' }, 100)).toBe(600_000);
  expect(chatGptMcpInvocationTimeout({ ...environment, mcpTransport: 'external', expiresAt: 180_100 }, 100)).toBe(180_000);
  expect(chatGptMcpInvocationTimeout({ ...environment, mcpTransport: 'external', expiresAt: 50 }, 100)).toBe(1);
});
