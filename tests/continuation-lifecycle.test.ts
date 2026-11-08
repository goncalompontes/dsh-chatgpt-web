import { expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../src/bridge";
import { HttpTurnCounter } from "../src/server";
import { parseRequest } from "../src/responses/parser";
import { extractChatGptTurnIdentity, extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { ChatGptBrowserWorker, ChatGptTurnDomHealthTracker, CHATGPT_GENERATION_RUNNING_STALL_MS, CHATGPT_RESPONSE_DOM_GRACE_MS } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptTurnExecutionKey, chatGptTurnRoundKey } from "../src/adapters/chatgpt-web/turn-execution";
import { currentToolResults } from "../src/adapters/chatgpt-web/index";
import { TurnBroker, callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("metadata-free tool continuations retain their turn identity", () => {
  const input = [{ role: "user", content: "run two commands" }];
  const first = { model: "chatgpt-web-luna", prompt_cache_key: "session", input };
  const next = { ...first, input: [...input,
    { type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "ONE" },
  ] };
  const identity = extractChatGptTurnIdentity(parseRequest(first));
  expect(extractChatGptTurnIdentity(parseRequest(next))).toEqual(identity);
  expect(extractChatGptTurnIdentity(parseRequest({ ...first, input: [
    { role: "user", content: "replayed history changed" },
    ...next.input,
  ] }))).toEqual(identity);
  expect(extractChatGptTurnIdentity(parseRequest({ ...first, input: [...input, { role: "user", content: "next turn" }] })).turnId).not.toBe(identity.turnId);
  const native = { ...first, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-native", turn_id: "turn-native" }) } };
  expect(extractChatGptTurnIdentity(parseRequest(native))).toMatchObject({ threadId: "thread-native", turnId: "turn-native" });
});

test("DSH runtime and skill envelopes do not replace the real user revision", () => {
  const user = { role: "user", content: "run two commands" };
  const runtime = { role: "user", content: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\nclock=one" };
  const skills = { role: "user", content: "<system-reminder>\nA skill is a reusable set of instructions.\n<available_skills>one</available_skills></system-reminder>" };
  const body = { model: "chatgpt-web/gpt-6-light", prompt_cache_key: "session", input: [user, runtime, skills] };
  const first = parseRequest(body);
  const next = parseRequest({ ...body, input: [user, { ...runtime, content: runtime.content + "changed" }, skills,
    { type: "function_call", call_id: "one", name: "bash", arguments: "{}" },
    { type: "function_call_output", call_id: "one", output: "ONE" },
  ] });
  expect(extractChatGptTurnIdentity(next)).toEqual(extractChatGptTurnIdentity(first));
  expect(chatGptTurnExecutionKey(next)).toBe(chatGptTurnExecutionKey(first));
  expect(chatGptTurnRoundKey(next)).not.toBe(chatGptTurnRoundKey(first));
  const other = parseRequest({ ...body, input: [{ ...user, content: "different task" }, runtime, skills] });
  expect(chatGptTurnExecutionKey(other)).not.toBe(chatGptTurnExecutionKey(first));
  const repeat = parseRequest({ ...body, input: [...body.input, user, runtime, skills] });
  expect(chatGptTurnExecutionKey(repeat)).not.toBe(chatGptTurnExecutionKey(first));
});

test("changing DSH directory and loading workspace instructions keeps the pending MCP turn", () => {
  const user = { role: "user", content: "inspect the project after changing directory" };
  const time = { role: "user", content: "Time sampled while preparing turn 1, step 1: 2026-11-06T18:37:24+00:00[Europe/Lisbon]\nBrowser time zone for this request: unavailable." };
  const body = { model: "chatgpt-web/gpt-6-light", prompt_cache_key: "cwd-session", input: [user, time] };
  const first = parseRequest(body);
  const next = parseRequest({ ...body, input: [...body.input,
    { type: "function_call", call_id: "cwd", name: "working_directory", arguments: '{"path":"/project"}' },
    { type: "function_call_output", call_id: "cwd", output: "Directory changed" },
    { role: "user", content: 'The working directory changed from "/home" to "/project".' },
    { role: "user", content: "<system-reminder>\nThe following workspace instructions may be relevant to your work. Use them as guidance when applicable.\nAGENTS.md instructions\n</system-reminder>" },
    { role: "user", content: "<system-reminder>\nAdditional instructions from: subdirectory/AGENTS.md\n\nThese instructions apply to work under `subdirectory`.\n</system-reminder>" },
    { role: "user", content: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\nCurrent working directory: /project" },
  ] });
  expect(extractChatGptTurnIdentity(next)).toEqual(extractChatGptTurnIdentity(first));
  expect(chatGptTurnExecutionKey(next)).toBe(chatGptTurnExecutionKey(first));
  expect(extractChatGptTurnUserRevision(first)).toBe(user.content);
  expect(extractChatGptTurnUserRevision(next)).toBe(user.content);
  const steering = parseRequest({ ...body, input: [...(next._rawBody as any).input,
    { role: "user", content: "also inspect the tests" }, time,
  ] });
  expect(chatGptTurnExecutionKey(steering)).not.toBe(chatGptTurnExecutionKey(first));
  expect(extractChatGptTurnUserRevision(steering)).toBe("also inspect the tests");
});

test("DSH background settlement keeps the human turn and pending tool continuation", () => {
  const user = { role: "user", content: "start a background job and collect it" };
  const input = [user,
    { type: "function_call", call_id: "job", name: "bash", arguments: '{"run_in_background":true}' },
    { type: "function_call_output", call_id: "job", output: "started background job bash-21918e4d92d34331" },
  ];
  const notice = { role: "user", content: "background job bash-21918e4d92d34331 (bash: sleep 2; printf DSH_BACKGROUND_OK) finished [status: completed, exit code: 0]. Output:\nDSH_BACKGROUND_OK" };
  const parse = (items: unknown[]) => parseRequest({ model: "chatgpt-web/gpt-6-light", prompt_cache_key: "jobs", input: items });
  const first = parse(input);
  const next = parse([...input, notice]);
  expect(chatGptTurnExecutionKey(next)).toBe(chatGptTurnExecutionKey(first));
  expect(extractChatGptTurnUserRevision(next)).toBe(user.content);
  expect(chatGptTurnRoundKey(next)).not.toBe(chatGptTurnRoundKey(first));
  for (const steering of ["check another job", notice.content.replace("bash-21918e4d92d34331", "bash-unknown"),
    `Please inspect this notice: ${notice.content}`]) {
    expect(chatGptTurnExecutionKey(parse([...input, { role: "user", content: steering }]))).not.toBe(chatGptTurnExecutionKey(first));
  }
  expect(extractChatGptTurnUserRevision(parse([user, notice]))).toBe(notice.content);
});

test("tool results prefer exact pipe-containing ids and accept pi-ai suffixes", () => {
  const session = {
    hasOutstanding: (id: string) => ["call_a", "call_a|exact", "call_b"].includes(id),
    outstanding: () => [1, 2, 3],
  };
  const parsed = parseRequest({ model: "test", input: [
    { type: "function_call_output", call_id: "call_a|exact", output: "A" },
    { type: "function_call_output", call_id: "call_b|provider", output: "B" },
  ] });
  expect(currentToolResults(parsed, session as never).map(m => m.toolCallId)).toEqual(["call_a|exact", "call_b"]);
  const nested = parseRequest({ model: "test", input: [
    { type: "function_call_output", call_id: "call_a|exact|provider", output: "EXACT" },
    { type: "function_call_output", call_id: "|unknown|provider", output: "UNMATCHED" },
  ] });
  expect(currentToolResults(nested, session as never).map(m => m.toolCallId)).toEqual(["call_a|exact"]);
});

test("approval before an assistant DOM node is handled even at the DOM grace boundary", async () => {
  let approved = false;
  const hidden: any = { filter() { return this; }, last() { return this; }, isVisible: async () => false };
  const allow: any = { last() { return this; }, isVisible: async () => true, press: async () => { approved = true; } };
  const dialog: any = {
    filter() { return this; }, last() { return this; }, isVisible: async () => !approved,
    getByRole: () => allow,
  };
  const page: any = {
    isClosed: () => false,
    locator: () => ({ filter: ({ hasText }: any) => typeof hasText === "string" && hasText.startsWith("Allow ChatGPT") ? dialog : hidden }),
    getByRole: () => hidden,
    getByText: () => hidden,
  };
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  worker.config = { appName: "local-shell-dsh", autoApproveToolCalls: true };
  worker.pageIsRehydrating = async () => false;
  worker.submissionDomState = async () => {
    expect(approved).toBe(true);
    return { responseIdentities: ["assistant-1"], userIdentities: ["user-1"], visibleStopButtonCount: 0 };
  };
  const result = await worker.waitForNewAssistantTurn(page, { initialResponseTurnIdentities: [] },
    Date.now() + 5000, undefined, { snapshot: () => ({ revision: 0 }) }, 0);
  expect(result.identity).toBe("assistant-1");
});

test("a running connector task can detach the transcript without an unbounded DOM grace", () => {
  const tracker = new ChatGptTurnDomHealthTracker();
  const present = { responsePresent: true, running: true, currentText: "Working", completionActionVisible: false };
  const detached = { ...present, responsePresent: false, currentText: "" };
  tracker.update(present, 0);
  expect(tracker.update(detached, 1)).toBeUndefined();
  expect(tracker.update(detached, CHATGPT_RESPONSE_DOM_GRACE_MS + 1)).toBeUndefined();
  expect(tracker.update(detached, CHATGPT_GENERATION_RUNNING_STALL_MS + 1)).toContain("DOM disappeared");
  // A stopped generator keeps the shorter failure bound; the running allowance is not
  // refreshed on every observation or carried across an observed response replacement.
  expect(tracker.update({ ...detached, running: false }, CHATGPT_RESPONSE_DOM_GRACE_MS + 1)).toContain("DOM disappeared");
  tracker.update(present, CHATGPT_GENERATION_RUNNING_STALL_MS + 2);
  expect(tracker.update(detached, CHATGPT_GENERATION_RUNNING_STALL_MS + 3)).toBeUndefined();
});

test("cancelAll terminates an outer pending HTTP read", async () => {
  const counter = new HttpTurnCounter();
  const response = await counter.track(async () => new Response(new ReadableStream()), undefined, "linux", "responses");
  const pending = response.body!.getReader().read();
  void pending.catch(() => {});
  const reason = new Error("explicit shutdown");
  await counter.cancelAll(reason);
  await expect(pending).rejects.toThrow("explicit shutdown");
  expect(counter.count()).toBe(0);
});

test("disconnected queued broker invocations cannot run later", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-broker-"));
  const broker = TurnBroker.forSocket(join(dir, "broker.sock"));
  try {
    const token = await broker.register({ cwd: dir, roots: [dir], writableRoots: [dir],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [dir], networkAccess: false }, tools: [] });
    const claim = await callTurnBroker<{ bindingId: string }>(broker.socketPath, { method: "claim", token });
    await expect(callTurnBroker(broker.socketPath, { method: "invoke", bindingId: claim.bindingId, wireName: "bash", arguments: {} }, 25)).rejects.toThrow("timed out");
    // Wait for a broker round trip after disconnect before probing for stale queued work.
    await callTurnBroker(broker.socketPath, { method: "resolve", bindingId: claim.bindingId });
    const abort = new AbortController();
    const batch = broker.nextToolBatch(token, abort.signal);
    void batch.catch(() => {});
    abort.abort();
    await expect(batch).rejects.toThrow("aborted");
  } finally {
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Responses SSE exposes each parallel tool by its original name", async () => {
  async function* events() {
    for (const [id, name] of [["call-bash", "bash"], ["call-glob", "glob"]]) {
      yield { type: "tool_call_start" as const, id: id!, name: name! };
      yield { type: "tool_call_delta" as const, arguments: "{}" };
      yield { type: "tool_call_end" as const };
    }
    yield { type: "done" as const, stopReason: "tool_use", endTurn: false };
  }
  const sse = await new Response(bridgeToResponsesSSE(events(), "gpt-6")).text();
  expect(sse).toContain('"name":"bash"');
  expect(sse).toContain('"name":"glob"');
  expect(sse).toContain('"call_id":"call-bash"');
  expect(sse).toContain('"call_id":"call-glob"');
});

test("compaction heartbeats are valid pi-ai chunks without adding a visible output item", async () => {
  async function* events() {
    yield { type: "heartbeat" as const };
    yield { type: "text_delta" as const, text: "checkpoint" };
    yield { type: "done" as const, stopReason: "stop", endTurn: true };
  }
  const sse = await new Response(bridgeToResponsesSSE(events(), "gpt-6", undefined, undefined, undefined,
    undefined, 2_000, { compaction: true })).text();
  expect(sse).toContain("response.output_text.delta");
  expect(sse).toContain("\u200b");
  expect(sse).toContain('"type":"compaction"');
  const completed = sse.split("event: response.completed")[1] ?? "";
  expect(completed).not.toContain('"type":"reasoning"');
});

test("DSH text compaction forwards heartbeat text progress and keeps its summary visible", async () => {
  async function* events() {
    yield { type: "heartbeat" as const };
    yield { type: "text_delta" as const, text: "checkpoint" };
    yield { type: "done" as const, stopReason: "stop", endTurn: true };
  }
  const sse = await new Response(bridgeToResponsesSSE(events(), "gpt-6", undefined, undefined, undefined,
    undefined, 2_000, { compactionProgress: true })).text();
  expect(sse).toContain("response.output_text.delta");
  expect(sse).toContain("checkpoint");
  expect(sse).not.toContain('"type":"compaction"');
});

test("simultaneous MCP invocations become distinct named DSH tool calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-parallel-"));
  const broker = TurnBroker.forSocket(join(dir, "broker.sock"));
  try {
    const token = await broker.register({ cwd: dir, roots: [dir], writableRoots: [dir],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [dir], networkAccess: false }, tools: [] });
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(broker.socketPath, { method: "claim", token });
    const waiting = broker.nextToolBatch(token);
    const first = callTurnBroker(broker.socketPath, { method: "invoke", bindingId, wireName: "bash",
      arguments: { command: "echo first" } });
    const second = callTurnBroker(broker.socketPath, { method: "invoke", bindingId, wireName: "glob",
      arguments: { pattern: "*.ts" } });
    const third = callTurnBroker(broker.socketPath, { method: "invoke", bindingId, wireName: "read",
      arguments: { file_path: "missing-file" } });
    const batch = await waiting;
    expect(batch).toHaveLength(3);
    expect(batch.map(tool => tool.wireName)).toEqual(["bash", "glob", "read"]);
    expect(new Set(batch.map(tool => tool.callId)).size).toBe(3);
    // A batch can complete out of order without mixing tool identities or receipts.
    broker.completeTool(token, batch[2]!.callId, { isError: true, content: [{ type: "text", text: "file not found" }] });
    broker.completeTool(token, batch[1]!.callId, { content: [{ type: "text", text: "glob-result" }] });
    broker.completeTool(token, batch[0]!.callId, { content: [{ type: "text", text: "bash-result" }] });
    expect(await first).toMatchObject({ content: [{ text: "bash-result" }] });
    expect(await second).toMatchObject({ content: [{ text: "glob-result" }] });
    expect(await third).toMatchObject({ isError: true, content: [{ text: "file not found" }] });
  } finally {
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a disconnected delivered invocation keeps its call id until its result arrives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-broker-"));
  const broker = TurnBroker.forSocket(join(dir, "broker.sock"));
  try {
    const token = await broker.register({ cwd: dir, roots: [dir], writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [] });
    const claim = await callTurnBroker<{ bindingId: string }>(broker.socketPath, { method: "claim", token });
    const client = new AbortController();
    const invocation = callTurnBroker(broker.socketPath, { method: "invoke", bindingId: claim.bindingId, wireName: "bash", arguments: {} }, null, client.signal);
    void invocation.catch(() => {});
    const first = await broker.nextToolBatch(token);
    client.abort();
    await expect(invocation).rejects.toThrow("aborted");
    await callTurnBroker(broker.socketPath, { method: "resolve", bindingId: claim.bindingId });
    expect(await broker.nextToolBatch(token)).toEqual(first);
    broker.completeTool(token, first[0]!.callId, { content: [{ type: "text", text: "done" }] });
    const probe = new AbortController();
    const empty = broker.nextToolBatch(token, probe.signal);
    void empty.catch(() => {});
    probe.abort();
    await expect(empty).rejects.toThrow("aborted");
  } finally {
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("genuine source read errors report their stage and release the HTTP turn", async () => {
  const failures: any[] = [];
  const counter = new HttpTurnCounter(failure => failures.push(failure));
  const response = await counter.track(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error("upstream read failed")); },
  })), undefined, "linux", "responses");
  await expect(response.body!.getReader().read()).rejects.toThrow("upstream read failed");
  expect(failures).toHaveLength(1);
  expect(failures[0].stage).toBe("read");
  expect(counter.count()).toBe(0);
});

test("cancel during a pending HTTP read does not enqueue or report a source failure", async () => {
  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  const failures: unknown[] = [];
  const counter = new HttpTurnCounter(failure => failures.push(failure));
  const response = await counter.track(async () => new Response(new ReadableStream({ start(c) { sourceController = c; } })), undefined, "linux", "responses");
  const reader = response.body!.getReader();
  const pending = reader.read();
  await Promise.resolve();
  await reader.cancel();
  expect((await pending).done).toBe(true);
  expect(counter.count()).toBe(0);
  expect(failures).toEqual([]);
  expect(() => sourceController.enqueue(new Uint8Array([1]))).toThrow();
});

test("bridge aborts on early cancellation but not after terminal frames", async () => {
  let cancelled = 0;
  async function* pending() { await new Promise<void>(() => {}); yield { type: "done" as const }; }
  const early = bridgeToResponsesSSE(pending(), "test", undefined, undefined, undefined, () => cancelled++);
  await early.cancel();
  expect(cancelled).toBe(1);
  async function* complete() { yield { type: "done" as const }; }
  const stream = bridgeToResponsesSSE(complete(), "test", undefined, undefined, undefined, () => cancelled++);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let frame = "";
  while (!frame.includes("event: response.completed")) {
    const item = await reader.read();
    if (item.done) throw new Error("missing terminal frame");
    frame = decoder.decode(item.value);
  }
  await reader.cancel();
  expect(cancelled).toBe(1);
});

test("client disconnect after a terminal SSE frame does not abort adapter work", async () => {
  const client = new AbortController();
  let adapterSignal!: AbortSignal;
  const bytes = new TextEncoder().encode('event: response.completed\ndata: {}\n\n');
  const counter = new HttpTurnCounter();
  const response = await counter.track(async signal => {
    adapterSignal = signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); } }));
  }, client.signal, "linux", "responses");
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  client.abort();
  await reader.cancel();
  expect(adapterSignal.aborted).toBe(false);
  expect(counter.count()).toBe(0);
});
