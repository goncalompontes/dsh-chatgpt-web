/** Explicit live smoke: isolated browser/login copy, native ACP request, no work tools. */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, providerConfig } from "../src/config";
import { loginVerificationMarkerPath } from "../src/browser-login";
import { responseRequest } from "../src/server";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { closeChatGptBrowserWorkers } from "../src/adapters/chatgpt-web/browser-worker";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

const home = mkdtempSync(join(tmpdir(), "dsh-acp-compaction-smoke-"));
const saved = loadConfig();
const storage = join(home, "storage-state.json");
copyFileSync(saved.storageStatePath, storage);
copyFileSync(loginVerificationMarkerPath(saved.storageStatePath), loginVerificationMarkerPath(storage));
const config = { ...saved, purpose: "dsh" as const, mode: "browser-only" as const,
  browserHost: "managed-chrome" as const, externalMcp: undefined,
  storageStatePath: storage, brokerSocketPath: join(home, "broker.sock") };
const provider = providerConfig(config);
provider.chatgptWeb!.threadEnvironmentStatePath = join(home, "environments.json");
provider.chatgptWeb!.lunaCheckpointStatePath = join(home, "checkpoints.json");
provider.chatgptWeb!.browserDiagnosticsPath = join(home, "diagnostics");
const broker = TurnBroker.forSocket(config.brokerSocketPath);
const adapter = createChatGptWebAdapter(provider, { broker });
const directive = readFileSync(new URL("../tests/fixtures/dsh-compaction-instruction.txt", import.meta.url), "utf8").trim();
const oldest = "ACP_OLDEST_CONSTRAINT_PRESERVE_EXISTING_FILES";
const newest = "ACP_NEXT_STEP_RETRY_THE_INTERRUPTED_TURN";
const started = Date.now();
try {
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(240_000),
    body: JSON.stringify({ model: "chatgpt-web/gpt-6-light", prompt_cache_key: `smoke-${started}`,
      input: [
        { role: "user", content: `${oldest}\n${"Historical evidence was reviewed; no files were modified.\n".repeat(5_500)}` },
        { role: "assistant", content: "The prior turn was interrupted before completion." },
        { role: "user", content: newest }, { role: "user", content: directive },
      ],
      // Native DSH advertises tools on compaction requests; none may execute here.
      tools: [{ type: "function", name: "bash", parameters: { type: "object" } }],
    }),
  }), config, () => adapter, { rememberState: false });
  const result = await response.json() as any;
  const text = JSON.stringify(result.output);
  if (result.status !== "completed" || !text?.includes(oldest) || !text.includes(newest)
    || result.output.some((item: any) => item.type === "function_call" || item.type === "compaction")) {
    throw new Error(`ACP compaction smoke failed: ${JSON.stringify(result.error ?? { status: result.status, preservedOldest: text?.includes(oldest), preservedNewest: text?.includes(newest) })}`);
  }
  console.log(JSON.stringify({ ok: true, seconds: (Date.now() - started) / 1_000,
    preservedOldest: true, preservedNewest: true, diagnostics: home }));
} finally {
  await closeChatGptBrowserWorkers();
  await broker.close();
  rmSync(storage, { force: true });
  rmSync(loginVerificationMarkerPath(storage), { force: true });
}
