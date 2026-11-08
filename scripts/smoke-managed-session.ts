/** Explicit live smoke test. Uses an isolated browser and copied login state; never runs in bun test. */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, providerConfig } from "../src/config";
import { loginVerificationMarkerPath } from "../src/browser-login";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { parseRequest } from "../src/responses/parser";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { retainedConversationResumeRequest } from "../src/adapters/chatgpt-web/conversation-key";
import { conversationHistoryFingerprint, conversationPredecessorFingerprint } from "../src/adapters/chatgpt-web/managed-conversation";

const home = mkdtempSync(join(tmpdir(), "dsh-managed-session-smoke-"));
const config = loadConfig();
const storage = join(home, "storage-state.json");
copyFileSync(config.storageStatePath, storage);
copyFileSync(loginVerificationMarkerPath(config.storageStatePath), loginVerificationMarkerPath(storage));
const provider = providerConfig({ ...config, externalMcp: undefined, storageStatePath: storage });
provider.chatgptWeb!.localToolsEnabled = false;
provider.chatgptWeb!.browserDiagnosticsPath = join(home, "diagnostics");
const worker = ChatGptBrowserWorker.forProvider(provider);
const capabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: false };
const key = `smoke-${Date.now()}`;
const marker = `BLUE-${Math.random().toString(36).slice(2, 8)}`;
const firstInput = [{ role: "user", content: `Remember this exact code for my next message: ${marker}. Do not use tools. Reply only READY.` }];
const first = parseRequest({ model: "gpt-6", reasoning: { effort: "low" }, input: firstInput });
const prepare = (parsed: typeof first) => async () => ({ ...compileChatGptWebPrompt(parsed, capabilities), release() {} });
const signal = AbortSignal.timeout(120_000);
let reused = false;
try {
  const answer = await worker.run({ traceId: key + "-one", modelId: "gpt-6", reasoning: "low", capabilities,
    prepare: prepare(first), retainConversation: true, conversationKey: key, onTextDelta() {}, abortSignal: signal });
  worker.commitManagedConversation(key, conversationHistoryFingerprint([...first.context.messages,
    { role: "assistant", content: [{ type: "text", text: answer }], timestamp: 0 }]));
  const second = parseRequest({ model: "gpt-6", reasoning: { effort: "low" }, input: [...firstInput,
    { role: "assistant", content: answer }, { role: "user", content: "What exact code did I give you? No tools. Reply with the code only." }] });
  const reply = await worker.run({ traceId: key + "-two", modelId: "gpt-6", reasoning: "low", capabilities,
    prepare: prepare(second), prepareResume: prepare(retainedConversationResumeRequest(second)!),
    retainConversation: true, conversationKey: key, conversationPredecessor: conversationPredecessorFingerprint(second.context.messages),
    onPreparedSelected(value) { reused = value; }, onTextDelta() {}, abortSignal: signal });
  if (!reused || !reply.includes(marker)) throw new Error(`Retained conversation failed: reused=${reused}, remembered=${reply.includes(marker)}`);
  console.log(JSON.stringify({ ok: true, reused, remembered: true, diagnostics: home }));
} finally {
  await worker.close();
  rmSync(storage, { force: true });
  rmSync(loginVerificationMarkerPath(storage), { force: true });
}
