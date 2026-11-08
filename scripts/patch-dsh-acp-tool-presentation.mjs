/**
 * Compatibility patch for the installed @deepseek-ai/dsh-acp bundle.
 *
 * T3 Code currently falls back to "Tool" when a terminal ACP tool_call_update
 * omits title. DSH sends it at start, but previously dropped it at completion.
 * The patch keeps per-session presentation metadata and repeats name/title/kind.
 *
 * No installation is modified unless --apply is supplied explicitly.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PATCH_MARKER = "dsh-acp-tool-presentation-compat-v1";

function replaceOnce(source, oldText, newText) {
  const first = source.indexOf(oldText);
  if (first === -1 || source.indexOf(oldText, first + oldText.length) !== -1) {
    throw new Error(`Expected one occurrence of patch anchor: ${oldText.slice(0, 80)}`);
  }
  return source.slice(0, first) + newText + source.slice(first + oldText.length);
}

export function patchDshAcpBundle(original) {
  if (original.includes(PATCH_MARKER)) return { source: original, changed: false };
  let source = original;
  source = replaceOnce(source, "function toolCallUpdate(event) {", `/* ${PATCH_MARKER} */
function acpToolKind(name) {
  if (/^(?:bash|pwsh|exec|exec_command|run_shell|terminal_send|run_code)$/.test(name)) return "execute";
  if (/^(?:read|read_image|glob|working_directory|terminal_read|terminal_list|job_output|job_list)$/.test(name)) return "read";
  if (/^(?:grep|web_search|mcp_tool_search)$/.test(name)) return "search";
  if (/^(?:web_fetch)$/.test(name)) return "fetch";
  if (/^(?:write|edit|apply_patch|str_replace_editor)$/.test(name)) return "edit";
  if (/^(?:delete|remove|unlink)$/.test(name)) return "delete";
  return "other";
}
function toolCallUpdate(event) {`);
  source = replaceOnce(source, '\t\tkind: "other",\n\t\tstatus: "in_progress",\n\t\trawInput: parseToolArguments(event.data.arguments)', '\t\tkind: acpToolKind(event.data.name),\n\t\tstatus: "in_progress",\n\t\trawInput: parseToolArguments(event.data.arguments)');
  source = replaceOnce(source, "async function toolResultUpdate(ctx, event) {", "async function toolResultUpdate(ctx, event, presentation) {");
  source = replaceOnce(source,
    '\t\ttoolCallId: message.toolCallId,\n\t\tstatus: message.isError === true ? "failed" : "completed",\n\t\tcontent',
    '\t\ttoolCallId: message.toolCallId,\n\t\t...(presentation ? { title: presentation.name, kind: acpToolKind(presentation.name) } : {}),\n\t\tstatus: message.isError === true ? "failed" : "completed",\n\t\tcontent');
  source = replaceOnce(source, '\toutputTail = Promise.resolve();\n\tinflight;', '\toutputTail = Promise.resolve();\n\ttoolPresentation = new Map();\n\tinflight;');
  source = replaceOnce(source,
    '\t\t\t} else if (event.type === "tool/call") {\n\t\t\t\tconst previous = this.outputTail;',
    '\t\t\t} else if (event.type === "tool/call") {\n\t\t\t\tthis.toolPresentation.set(event.data.callId, { name: event.data.name });\n\t\t\t\tconst previous = this.outputTail;');
  source = replaceOnce(source,
    '\t\t\t\tthis.outputTail = previous.then(async () => this.notify({\n\t\t\t\t\tsessionId: this.agent.session.id,\n\t\t\t\t\tupdate: await toolResultUpdate(this.ctx, event)\n\t\t\t\t})).catch((error) => {',
    '\t\t\t\tthis.outputTail = previous.then(async () => {\n\t\t\t\t\tconst callId = event.data.message.toolCallId;\n\t\t\t\t\ttry {\n\t\t\t\t\t\tawait this.notify({\n\t\t\t\t\t\t\tsessionId: this.agent.session.id,\n\t\t\t\t\t\t\tupdate: await toolResultUpdate(this.ctx, event, this.toolPresentation.get(callId))\n\t\t\t\t\t\t});\n\t\t\t\t\t} finally {\n\t\t\t\t\t\tthis.toolPresentation.delete(callId);\n\t\t\t\t\t}\n\t\t\t\t}).catch((error) => {');
  return { source, changed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const target = args.find(arg => !arg.startsWith("--"));
  if (!target) {
    console.error("Usage: node scripts/patch-dsh-acp-tool-presentation.mjs [--apply] /absolute/path/to/@deepseek-ai/dsh-acp/lib/index.js");
    process.exitCode = 2;
  } else {
    const absolute = resolve(target);
    if (!absolute.endsWith("/@deepseek-ai/dsh-acp/lib/index.js")) throw new Error("Refusing to patch a non-DSH ACP bundle");
    const existing = readFileSync(absolute, "utf8");
    const { source, changed } = patchDshAcpBundle(existing);
    if (!changed) console.log("DSH ACP presentation patch already present");
    else if (!apply) console.log(`Compatible bundle found; --apply would patch ${absolute}`);
    else {
      const backup = absolute + ".before-t3-presentation-patch";
      if (existsSync(backup)) throw new Error(`Backup already exists: ${backup}`);
      writeFileSync(backup, existing, { flag: "wx" });
      const temporary = absolute + ".presentation-patch-temp";
      writeFileSync(temporary, source, { flag: "wx" });
      renameSync(temporary, absolute);
      console.log(`Patched ${absolute}; restart the DSH ACP process to load the changes. Backup: ${backup}`);
    }
  }
}
