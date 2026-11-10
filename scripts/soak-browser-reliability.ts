#!/usr/bin/env bun
/**
 * Per-turn browser reliability soak.
 *
 * Sends streamed Responses requests to a running bridge, records one outcome per turn, and writes
 * JSON + Markdown evidence. It never retries a failed turn and never logs prompt text.
 *
 * Example:
 *   bun scripts/soak-browser-reliability.mjs --url http://127.0.0.1:17851/v1 --turns 8
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface TurnResult {
  index: number;
  sessionId: string;
  status: "passed" | "failed" | "timeout" | "http_error";
  httpStatus?: number;
  code?: string;
  message?: string;
  durationMs: number;
  outputChars: number;
  markerSeen: boolean;
  completed: boolean;
  retried: number;
}

interface Args {
  url: string;
  turns: number;
  concurrency: number;
  model: string;
  timeoutMs: number;
  output: string;
  runId: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    url: "http://127.0.0.1:17851/v1",
    turns: 8,
    concurrency: 2,
    model: "chatgpt-web/gpt-6-light",
    timeoutMs: 240_000,
    output: resolve(`docs/browser-reliability-soak-${new Date().toISOString().slice(0, 10)}.json`),
    runId: new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--")) continue;
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    index += 1;
    if (flag === "--url") args.url = value;
    else if (flag === "--turns") args.turns = Number(value);
    else if (flag === "--concurrency") args.concurrency = Number(value);
    else if (flag === "--model") args.model = value;
    else if (flag === "--timeout-ms") args.timeoutMs = Number(value);
    else if (flag === "--output") args.output = resolve(value);
    else if (flag === "--run-id") args.runId = value;
    else throw new Error(`Unknown flag ${flag}`);
  }
  if (!Number.isInteger(args.turns) || args.turns < 1 || args.turns > 200) {
    throw new Error("--turns must be an integer from 1 to 200");
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 32) {
    throw new Error("--concurrency must be an integer from 1 to 32");
  }
  if (args.concurrency > args.turns) args.concurrency = args.turns;
  if (!args.url.startsWith("http://127.0.0.1") && !args.url.startsWith("http://localhost")) {
    throw new Error("--url must be a loopback HTTP endpoint");
  }
  return args;
}

function markerFor(index: number): string {
  return `SOAK_${index}`;
}

/** ChatGPT's Markdown renderer escapes underscores; the transport marker is still present. */
function normalizeMarkdown(text: string): string {
  return text.replace(/\\([_*.[\]()#>`~-])/g, "$1");
}

function parseSsePayload(payload: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(payload);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

async function runTurn(args: Args, index: number): Promise<TurnResult> {
  const startedAt = performance.now();
  const marker = markerFor(index);
  const sessionId = `soak-${args.runId}-${index}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("turn timeout")), args.timeoutMs);
  let httpStatus: number | undefined;
  let code: string | undefined;
  let message: string | undefined;
  let output = "";
  let completed = false;
  try {
    const response = await fetch(`${args.url.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "x-dsh-session-id": sessionId,
        "x-dsh-turn-id": `dsh-turn-${index + 1}`,
        "x-dsh-request-purpose": "user",
      },
      body: JSON.stringify({
        model: args.model,
        stream: true,
        input: [{
          role: "user",
          content: `Reply with exactly ${marker} and nothing else.`,
        }],
        prompt_cache_key: sessionId,
      }),
      signal: controller.signal,
    });
    httpStatus = response.status;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const parsed = parseSsePayload(body);
      code = typeof parsed?.code === "string" ? parsed.code : undefined;
      message = typeof parsed?.message === "string" ? parsed.message : body.slice(0, 300);
      return {
        index, sessionId, status: "http_error", httpStatus,
        ...(code ? { code } : {}),
        ...(message ? { message } : {}),
        durationMs: Math.round(performance.now() - startedAt),
        outputChars: 0, markerSeen: false, completed: false, retried: 0,
      };
    }
    if (!response.body) throw new Error("response has no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];
    const dispatch = (): void => {
      const data = dataLines.join("\n");
      dataLines = [];
      if (!data || data === "[DONE]") return;
      const event = parseSsePayload(data);
      if (!event) return;
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        output += event.delta;
      } else if (event.type === "response.completed") {
        completed = true;
      } else if (event.type === "response.failed" || event.type === "error") {
        const error = event.error && typeof event.error === "object"
          ? event.error as Record<string, unknown>
          : event;
        code ??= typeof error.code === "string" ? error.code : undefined;
        message ??= typeof error.message === "string" ? error.message : undefined;
      }
    };
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        else if (line.length === 0) dispatch();
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0 && buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart());
    dispatch();
  } catch (error) {
    const timedOut = controller.signal.aborted && String(controller.signal.reason).includes("timeout");
    return {
      index, sessionId, status: timedOut ? "timeout" : "failed",
      ...(httpStatus ? { httpStatus } : {}),
      ...(code ? { code } : {}),
      ...(message ? { message } : {}),
      ...(timedOut ? { message: "turn exceeded the client timeout" } : {
        message: error instanceof Error ? error.message : String(error),
      }),
      durationMs: Math.round(performance.now() - startedAt),
      outputChars: output.length,
      markerSeen: normalizeMarkdown(output).includes(marker),
      completed: false,
      retried: 0,
    };
  } finally {
    clearTimeout(timeout);
  }
  return {
    index,
    sessionId,
    status: completed && normalizeMarkdown(output).includes(marker) ? "passed" : "failed",
    ...(httpStatus ? { httpStatus } : {}),
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    durationMs: Math.round(performance.now() - startedAt),
    outputChars: output.length,
    markerSeen: normalizeMarkdown(output).includes(marker),
    completed,
    retried: 0,
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function renderMarkdown(args: Args, results: TurnResult[]): string {
  const passed = results.filter(result => result.status === "passed").length;
  const failed = results.length - passed;
  const durations = results.map(result => result.durationMs);
  const codes = new Map<string, number>();
  for (const result of results) {
    if (!result.code) continue;
    codes.set(result.code, (codes.get(result.code) ?? 0) + 1);
  }
  const lines = [
    `# Browser reliability soak — ${new Date().toISOString()}`,
    "",
    `Endpoint: \`${args.url}\` · model: \`${args.model}\` · turns: ${args.turns} · concurrency: ${args.concurrency}`,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Passed | ${passed} |`,
    `| Failed | ${failed} |`,
    `| Pass rate | ${((passed / results.length) * 100).toFixed(1)}% |`,
    `| p50 duration | ${percentile(durations, 0.5)} ms |`,
    `| p95 duration | ${percentile(durations, 0.95)} ms |`,
    `| Max duration | ${Math.max(...durations)} ms |`,
    `| Retries | ${results.reduce((total, result) => total + result.retried, 0)} |`,
    "",
    "## Failure codes",
    "",
    codes.size === 0 ? "None." : [...codes].map(([code, count]) => `- \`${code}\`: ${count}`).join("\n"),
    "",
    "## Per-turn outcomes",
    "",
    "| Turn | Status | HTTP | Code | Duration | Chars | Marker | Completed |",
    "| ---: | --- | ---: | --- | ---: | ---: | --- | --- |",
    ...results.map(result => `| ${result.index} | ${result.status} | ${result.httpStatus ?? ""} | ${result.code ?? ""} | ${result.durationMs} ms | ${result.outputChars} | ${result.markerSeen ? "yes" : "no"} | ${result.completed ? "yes" : "no"} |`),
    "",
    "The soak sends no tool calls. It measures browser transport completion, not tool execution.",
  ];
  return `${lines.join("\n")}\n`;
}

const args = parseArgs(Bun.argv.slice(2));
const results: TurnResult[] = new Array(args.turns);
let next = 0;
async function worker(): Promise<void> {
  for (;;) {
    const index = next++;
    if (index >= args.turns) return;
    results[index] = await runTurn(args, index);
    process.stdout.write(`${results[index]!.status === "passed" ? "." : "x"}`);
  }
}
await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
process.stdout.write("\n");

const passed = results.filter(result => result.status === "passed").length;
const summary = {
  startedAt: new Date().toISOString(),
  url: args.url,
  model: args.model,
  turns: args.turns,
  concurrency: args.concurrency,
  passed,
  failed: results.length - passed,
  passRate: passed / results.length,
  results,
};
mkdirSync(dirname(args.output), { recursive: true });
writeFileSync(args.output, `${JSON.stringify(summary, null, 2)}\n`);
const markdownPath = args.output.replace(/\.json$/, ".md");
writeFileSync(markdownPath, renderMarkdown(args, results));
console.log(JSON.stringify({
  output: args.output,
  markdown: markdownPath,
  passed,
  failed: results.length - passed,
  passRate: summary.passRate,
}));
if (passed !== results.length) process.exitCode = 1;
