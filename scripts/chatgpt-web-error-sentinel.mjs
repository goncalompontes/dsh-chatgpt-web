#!/usr/bin/env node
/**
 * ChatGPT-Web error sentinel.
 *
 * Event-driven companion to the dsh-chatgpt-web adapter: it tails the dsh-web-stack sidecar log
 * and, for every distinct new adapter failure, opens exactly one T3 thread in the dsh-chatgpt-web
 * project with a root-cause brief. It does no polling of T3 and starts no thread while the adapter
 * is healthy, so idle time costs nothing.
 *
 * Detection source is the adapter's own terminal log line, which exists regardless of which client
 * (T3, ACP, HTTP) used the provider:
 *   [chatgpt-web] browser turn <trace> failed: <cause>
 *   [chatgpt-web] browser turn <trace> stage=<stage> failed durationMs=<n>: <cause>
 *
 * State (log offset, dispatched signatures, rate window) lives in
 *   ~/.dsh/storages/chatgpt-web/sentinel/state.json
 *
 * Configuration (env, all optional):
 *   SENTINEL_LOG            sidecar log path
 *   SENTINEL_STATE_DIR      state directory
 *   SENTINEL_PROJECT        project path or id passed to `t3 thread start`
 *   SENTINEL_WORKTREE_REF   branch/tag/commit for the fix thread worktree (default fork/main)
 *   SENTINEL_T3             t3 executable (default: t3 on PATH)
 *   SENTINEL_DEDUPE_HOURS   how long one signature stays dispatched (default 168)
 *   SENTINEL_MAX_PER_HOUR   dispatch rate limit (default 3)
 *   SENTINEL_RETRY_MINUTES  retry delay after a failed dispatch attempt (default 30)
 *
 * Flags:
 *   --dry-run     classify existing/new lines and print what would be dispatched; never calls t3.
 *   --self-test   run the built-in classification cases and exit.
 *
 * Install (user service, survives logout with lingering enabled):
 *   install -m 0755 scripts/chatgpt-web-error-sentinel.mjs \
 *     ~/.local/share/dsh-web-stack/chatgpt-web-error-sentinel.mjs
 *   cp scripts/systemd/chatgpt-web-error-sentinel.service ~/.config/systemd/user/
 *   systemctl --user daemon-reload && systemctl --user enable --now chatgpt-web-error-sentinel
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const HOME = homedir();
const CONFIG = {
  log: process.env.SENTINEL_LOG ?? join(HOME, ".local/state/dsh-web-stack/sidecar.log"),
  stateDir: process.env.SENTINEL_STATE_DIR ?? join(HOME, ".dsh/storages/chatgpt-web/sentinel"),
  project: process.env.SENTINEL_PROJECT ?? join(HOME, "projects/dsh-chatgpt-web"),
  worktreeRef: process.env.SENTINEL_WORKTREE_REF ?? "fork/main",
  t3: process.env.SENTINEL_T3 ?? "t3",
  dedupeHours: Number(process.env.SENTINEL_DEDUPE_HOURS ?? 168),
  maxPerHour: Number(process.env.SENTINEL_MAX_PER_HOUR ?? 3),
  retryMinutes: Number(process.env.SENTINEL_RETRY_MINUTES ?? 30),
  pollMs: 1_000,
  contextLines: 25,
};
const STATE_PATH = join(CONFIG.stateDir, "state.json");
const DIAGNOSTICS_DIR = join(HOME, ".dsh/storages/chatgpt-web/diagnostics/browser-turns");

/** Failure lines that are expected, human-actionable, or caused by the caller leaving. */
const IGNORED_CAUSES = [
  /chatgpt login is expired or signed out/i,
  /login state is missing/i,
  /session has expired/i,
  /\babort(error)?\b/i,
  /chatgpt web turn aborted/i,
  /tab was closed|browser tab closed/i,
  /browser host descriptor/i,
  /enoent/i,
  /econnrefused.*3773/i,
];

/** Terminal adapter lines. The browser-turn line is emitted for every failed turn. */
const FAILURE_PATTERNS = [
  {
    pattern: /^\[chatgpt-web\] browser turn (\S+) stage=(.+?) failed durationMs=(\d+): (.*)$/,
    stage: (m) => m[2],
    cause: (m) => m[4],
    trace: (m) => m[1],
  },
  {
    pattern: /^\[chatgpt-web\] browser turn (\S+) failed: (.*)$/,
    stage: () => undefined,
    cause: (m) => m[2],
    trace: (m) => m[1],
  },
];

function log(message) {
  process.stdout.write(`[sentinel ${new Date().toISOString()}] ${message}\n`);
}

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (typeof parsed.offset !== "number" || !Array.isArray(parsed.signatures)) throw new Error("bad state");
    return {
      offset: parsed.offset,
      signatures: parsed.signatures.filter(entry => entry && typeof entry.sig === "string"),
      dispatchTimes: Array.isArray(parsed.dispatchTimes) ? parsed.dispatchTimes : [],
    };
  } catch {
    return undefined;
  }
}

function writeState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const temp = `${STATE_PATH}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 1)}\n`);
  renameSync(temp, STATE_PATH);
}

function logSize() {
  try {
    return statSync(CONFIG.log).size;
  } catch {
    return 0;
  }
}

function readFromOffset(offset) {
  let fd;
  try {
    fd = openSync(CONFIG.log, "r");
  } catch {
    return { text: "", offset };
  }
  try {
    const size = statSync(CONFIG.log).size;
    const start = offset <= size ? offset : 0;
    if (start === offset && size <= offset) return { text: "", offset };
    const length = size - start;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    return { text: buffer.toString("utf8"), offset: size };
  } finally {
    closeSync(fd);
  }
}

/**
 * Stable identity for an error: drop traces, ids, timings, numbers and quoted payload text.
 *
 * The stage and turn log lines for one failure carry the same cause, so the stage must not be part
 * of the identity or a single failure opens two fix threads.
 */
export function signatureFor(cause) {
  const normalized = `${cause}`
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\d+(?:[.,]\d+)*\s*(?:ms|s|m|h|tokens?|chars?|bytes?|mb|mib|gb|gib)\b/gi, "<n>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/"[^"]*"/g, '"<q>"')
    .replace(/'[^']*'/g, "'<q>'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return normalized.slice(0, 160);
}

// Older state entries stored "stage:<stage> <cause>"; compare without that prefix.
const comparable = (sig) => sig.replace(/^stage:\S+\s+/, "").slice(0, 120);

export function classifyLine(line) {
  for (const format of FAILURE_PATTERNS) {
    const match = format.pattern.exec(line);
    if (!match) continue;
    const cause = format.cause(match).trim();
    if (!cause) return undefined;
    if (IGNORED_CAUSES.some(ignored => ignored.test(cause))) return undefined;
    const stage = format.stage(match);
    return { trace: format.trace(match), stage, cause, sig: signatureFor(cause) };
  }
  return undefined;
}

function recentSignature(state, sig, now) {
  const key = comparable(sig);
  return state.signatures.find(entry => entry.sig && comparable(entry.sig) === key
    && now - Date.parse(entry.dispatchedAt ?? 0) < CONFIG.dedupeHours * 3_600_000);
}

function retryAllowed(entry, now) {
  return entry.attempts < 1
    || (entry.attempts === 1 && now - Date.parse(entry.lastAttemptAt ?? 0) >= CONFIG.retryMinutes * 60_000);
}

function dispatchAllowed(state, now) {
  state.dispatchTimes = state.dispatchTimes.filter(at => now - Date.parse(at) < 3_600_000);
  return state.dispatchTimes.length < CONFIG.maxPerHour;
}

function titleFor(detection) {
  const base = detection.sig.length > 90 ? `${detection.sig.slice(0, 87)}...` : detection.sig;
  return `fix(chatgpt-web): ${base}`;
}

function briefFor(detection, contextLines) {
  const diagnostics = detection.trace
    ? `${DIAGNOSTICS_DIR}/${detection.trace}*`
    : `${DIAGNOSTICS_DIR}/`;
  return [
    "A chatgpt-web provider error was detected automatically from the live adapter log. Fix the cause, not the symptom.",
    "",
    "Before anything else: archive this thread so it stays out of the user's thread list. Call the t3_thread_organize tool with action \"archive\" and no threadId (it defaults to this thread). Archiving does not interrupt the run; continue the work afterwards.",
    "",
    `Observed error: ${detection.cause}`,
    `Adapter stage: ${detection.stage ?? "unknown"}`,
    `Trace id: ${detection.trace ?? "unknown"}`,
    `Diagnostics (if present): ${diagnostics}`,
    "",
    "Log context (verbatim, token-redacted):",
    "```",
    ...contextLines,
    "```",
    "",
    "Mandatory method:",
    "1. Reconstruct the exact failing path from the adapter state machine, the log, and the diagnostics. Name the invariant that was violated and the code that violated it with file:line evidence, before editing anything.",
    "2. Change WHY it fails. Widening a timeout, adding a retry, adding a fallback, catching and downgrading or reclassifying an error, or letting a turn pass with a weaker check is a side-step and is rejected. If a limit or timeout is genuinely wrong, prove the correct value from measured or observable evidence (ingestion and acceptance rates, upstream behaviour, DOM/network captures) and encode that corrected model, pinned by a boundary test.",
    "3. Prefer correcting the adapter's model of ChatGPT over handling its symptoms: transport limits and staging thresholds, acceptance evidence and state transitions, conversation retention and identity, DOM detection.",
    "4. Add a regression test that fails on the pre-fix code and passes after.",
    `5. Base the branch on ${CONFIG.worktreeRef} (git log --oneline ${CONFIG.worktreeRef} -1); local main may be stale. Work only in this worktree. Run bun run typecheck and bun test. Do not restart the sidecar or deploy; do not open a PR unless asked.`,
    "6. If the evidence is insufficient to prove a cause, say what is missing and propose the smallest instrumentation that would prove it. Do not guess and do not paper over.",
    "",
    "Report: root cause (with evidence), the fix, the regression test, and anything still unexplained.",
  ];
}

function runT3(args, stdin) {
  return new Promise((resolve) => {
    const child = spawn(CONFIG.t3, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, T3CODE_HOME: process.env.T3CODE_HOME ?? join(HOME, ".t3") },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", code => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function dispatch(detection, contextLines) {
  const title = titleFor(detection);
  const brief = briefFor(detection, contextLines).join("\n");
  const base = ["thread", "start", "--json", "--title", title, CONFIG.project, "-"];
  const attempts = [
    [...base, "--worktree", CONFIG.worktreeRef],
    // A ref the CLI cannot resolve must not cost the error its fix thread; the root checkout is
    // dirty in normal use, so this is the fallback of last resort and is reported.
    base,
  ];
  for (const [index, args] of attempts.entries()) {
    const result = await runT3(args, brief);
    if (result.code === 0) {
      try {
        const parsed = JSON.parse(result.stdout);
        const threadId = parsed.threadId ?? parsed.id ?? null;
        if (threadId) return { threadId, worktree: index === 0 };
      } catch {
        const match = /"?thread(?:Id)?"?\s*[:=]\s*"?([\w:.-]+)"?/i.exec(result.stdout);
        if (match) return { threadId: match[1], worktree: index === 0 };
      }
      return { threadId: null, worktree: index === 0, detail: "t3 exited 0 without a thread id" };
    }
    log(`dispatch attempt failed (${args.includes("--worktree") ? "worktree" : "project root"}): ${result.stderr.trim().slice(0, 300)}`);
  }
  return { threadId: null, worktree: false, detail: "t3 thread start failed for every strategy" };
}

async function handleDetections(state, detections, contextFor, { dryRun }) {
  for (const detection of detections) {
    const now = Date.now();
    const existing = recentSignature(state, detection.sig, now);
    if (existing) {
      if (!retryAllowed(existing, now)) continue;
      log(`retrying previously failed dispatch sig=${detection.sig}`);
    } else if (!dispatchAllowed(state, now)) {
      log(`rate limit reached; deferring sig=${detection.sig}`);
      continue;
    }
    if (dryRun) {
      log(`[dry-run] would dispatch trace=${detection.trace ?? "?"} stage=${detection.stage ?? "?"}: ${detection.sig}`);
      state.signatures.push({
        sig: detection.sig, dispatchedAt: new Date(now).toISOString(), threadId: null,
        trace: detection.trace ?? null, attempts: 0, dryRun: true,
      });
      continue;
    }
    const result = await dispatch(detection, contextFor(detection));
    if (result.threadId) {
      state.dispatchTimes.push(new Date(now).toISOString());
      log(`opened T3 thread ${result.threadId} worktree=${result.worktree} trace=${detection.trace ?? "?"} stage=${detection.stage ?? "?"}`);
      if (existing) {
        Object.assign(existing, {
          dispatchedAt: new Date(now).toISOString(), threadId: result.threadId, attempts: 0, detail: null,
        });
      } else {
        state.signatures.push({
          sig: detection.sig, dispatchedAt: new Date(now).toISOString(), threadId: result.threadId,
          trace: detection.trace ?? null, attempts: 0,
        });
      }
    } else {
      log(`dispatch failed: ${result.detail ?? "unknown error"}`);
      if (existing) {
        existing.attempts = (existing.attempts ?? 0) + 1;
        existing.lastAttemptAt = new Date(now).toISOString();
        existing.detail = result.detail ?? null;
      } else {
        state.signatures.push({
          sig: detection.sig, dispatchedAt: new Date(now).toISOString(), threadId: null,
          trace: detection.trace ?? null, attempts: 1, lastAttemptAt: new Date(now).toISOString(),
          detail: result.detail ?? null,
        });
      }
    }
    state.signatures = state.signatures.filter(entry => entry.dryRun
      || now - Date.parse(entry.dispatchedAt ?? 0) < CONFIG.dedupeHours * 3_600_000 * 2).slice(-200);
    writeState(state);
  }
}

function selfTest() {
  const cases = [
    ["[chatgpt-web] browser turn abc123 failed: Error: ChatGPT did not create a response DOM after the message was sent", true],
    ["[chatgpt-web] browser turn abc123 stage=send failed durationMs=20251: ChatGPT browser stage timed out: send", true],
    ["[chatgpt-web] browser turn abc123 failed: Error: ChatGPT web turn aborted", false],
    ["[chatgpt-web] browser turn abc123 failed: ChatGPT login is expired or signed out. Sign in to your account", false],
    ["[chatgpt-web] input_accounting trace=abc scope=browser_submission input_tokens=40765", false],
  ];
  let failures = 0;
  for (const [line, expected] of cases) {
    const detected = Boolean(classifyLine(line));
    if (detected !== expected) {
      failures += 1;
      console.error(`self-test failed: expected ${expected} for ${line}`);
    }
  }
  const a = classifyLine(cases[1][0]);
  const b = classifyLine(cases[1][0].replace("abc123", "def456").replace("20251", "19999"));
  if (!a || !b || a.sig !== b.sig) {
    failures += 1;
    console.error("self-test failed: trace ids and durations must not change a signature");
  }
  const stageLine = classifyLine("[chatgpt-web] browser turn abc123 stage=send failed durationMs=20251: ChatGPT rejected the submitted messages as too long.");
  const turnLine = classifyLine("[chatgpt-web] browser turn abc123 failed: ChatGPT rejected the submitted messages as too long.");
  if (!stageLine || !turnLine || stageLine.sig !== turnLine.sig) {
    failures += 1;
    console.error("self-test failed: the stage and turn lines of one failure must share a signature");
  }
  console.log(failures === 0 ? "self-test passed" : `self-test failed (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const dryRun = process.argv.includes("--dry-run");
  mkdirSync(CONFIG.stateDir, { recursive: true });
  let state = readState();
  if (!state) {
    state = { offset: logSize(), signatures: [], dispatchTimes: [] };
    writeState(state);
    log(`initialized at log end offset=${state.offset}; historical errors are not dispatched`);
  }
  log(`watching ${CONFIG.log} from offset=${state.offset} (project=${CONFIG.project}, ref=${CONFIG.worktreeRef}${dryRun ? ", dry-run" : ""})`);
  let context = [];
  let partial = "";
  let busy = false;
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, CONFIG.pollMs));
    const { text, offset } = readFromOffset(state.offset);
    if (!text && offset === state.offset) continue;
    state.offset = offset;
    partial += text;
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    if (partial.length > 1_000_000) partial = partial.slice(-4096);
    const detections = [];
    const contexts = new Map();
    for (const line of lines) {
      context.push(line);
      if (context.length > CONFIG.contextLines * 2) context = context.slice(-CONFIG.contextLines * 2);
      const detection = classifyLine(line);
      if (!detection) continue;
      detections.push(detection);
      contexts.set(detection, [...context.slice(-CONFIG.contextLines), line]);
    }
    if (detections.length > 0 && !busy) {
      busy = true;
      try {
        await handleDetections(state, detections, detection => contexts.get(detection) ?? [], { dryRun });
      } catch (error) {
        log(`dispatch loop failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        busy = false;
      }
    }
    writeState(state);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[sentinel] fatal: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  });
}
