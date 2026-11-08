/**
 * Probe the installed T3 ACP consumer's pure presentation helpers with captured
 * ACP JSONL. Does not start T3 or modify the installation. Shipped Bun bundles
 * retain these function declarations; an unsupported layout fails explicitly.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import assert from "node:assert/strict";

const [binary, capturedUpdates] = process.argv.slice(2);
if (!binary || !capturedUpdates) throw new Error("Usage: node smoke-installed-t3-presentation.mjs <installed-t3-binary> <captured-acp-updates.jsonl>");
const bytes = readFileSync(binary);
const source = bytes.toString("latin1"); // Preserve exact byte offsets in the embedded JS.
const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
const declarations = new Map();
const arrayConstants = new Set(["PATH_KEYS", "SEARCH_QUERY_KEYS", "SEARCH_GLOB_KEYS", "SEARCH_TARGET_KEYS"]);
const literalConstants = new Set(["TOOL_CALL_CONTENT_MAX_CHARS", "TOOL_CALL_CONTENT_TRUNCATION_MARKER", "MAX_ACP_CONTENT_TEXT_LENGTH"]);

function load(name) {
  assert.match(name, /^[\w$]+$/);
  assert(!declarations.has(name), `Unresolved repeated dependency: ${name}`);
  let start = source.indexOf(`function ${name}(`);
  let end = source.indexOf("\n}\n", start) + 3;
  let declaration;
  if (start >= 0 && end > start) {
    assert(end - start < 64 * 1024, `Unexpected helper extent: ${name}`);
    declaration = Buffer.from(source.slice(start, end), "latin1").toString("utf8");
  } else {
    if (name === "boundedContentText") {
      start = source.indexOf(`${name} = `);
      end = source.indexOf(";\n", start) + 1;
      assert(start >= 0 && end > start && end - start < 1024);
      declaration = `const ${source.slice(start, end)};`;
    } else if (literalConstants.has(name)) {
      start = source.indexOf(`${name} = `);
      end = source.indexOf(";\n", start) + 1;
      assert(start >= 0 && end > start && end - start < 1024);
      const literal = source.slice(start + name.length + 3, end - 1);
      assert(/^(?:\d+(?:e\d+)?|"(?:[^"\\]|\\.)*")$/.test(literal), `Nonliteral constant: ${name}`);
      declaration = `const ${name} = ${literal};`;
    } else {
      assert(arrayConstants.has(name), `Unsupported non-function dependency: ${name}`);
      start = source.indexOf(`${name} = [`);
      end = source.indexOf("];", start) + 1;
      assert(start >= 0 && end > start);
      const value = JSON.parse(source.slice(start + name.length + 3, end));
      declaration = `const ${name} = ${JSON.stringify(value)};`;
    }
  }
  runInContext(declaration, context, { timeout: 1000 });
  declarations.set(name, { start, end });
}

function probe(expression) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { return runInContext(expression, context, { timeout: 1000 }); }
    catch (error) {
      const missing = /^([\w$]+) is not defined$/.exec(error.message);
      if (!missing) throw error;
      load(missing[1]);
    }
  }
  throw new Error("Presentation helper dependency limit exceeded");
}

const calls = new Map();
for (const line of readFileSync(capturedUpdates, "utf8").trim().split("\n")) {
  const update = JSON.parse(line);
  if (!["tool_call", "tool_call_update"].includes(update.sessionUpdate)) continue;
  const previous = calls.get(update.toolCallId);
  context.update = update;
  context.previous = previous?.state;
  const state = probe("mergeToolCallState(previous, parseTypedToolCallState(update))");
  calls.set(update.toolCallId, { state, originalTitle: previous?.originalTitle ?? update.title });
}
assert(calls.size > 0, "No captured calls");
const output = [];
for (const [callId, { state, originalTitle }] of calls) {
  assert(["completed", "failed"].includes(state.status), `Call did not terminate: ${callId}`);
  assert.equal(state.data.title, originalTitle, "Tool identity changed at the consumer");
  assert(!/^(?:tool|tool call)$/i.test(state.title), "Consumer produced a generic card title");
  if (state.kind === "read" && typeof state.data.rawInput?.file_path === "string") {
    assert.notEqual(state.title, "Read file", "Terminal update lost its file-specific presentation");
  }
  if (["job_output", "job_list", "terminal_read", "terminal_list", "working_directory"].includes(originalTitle)) {
    assert.equal(state.title, originalTitle, "A non-file tool was relabelled as a file operation");
  }
  output.push({ callId, originalTitle, title: state.title, kind: state.kind, status: state.status });
}
console.log(JSON.stringify({ ok: true, binary, sha256: createHash("sha256").update(bytes).digest("hex"),
  capturedUpdates, calls: output, helpers: Object.fromEntries(declarations) }, null, 2));
