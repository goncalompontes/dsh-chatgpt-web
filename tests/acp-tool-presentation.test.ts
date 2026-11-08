import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { patchDshAcpBundle } from "../scripts/patch-dsh-acp-tool-presentation.mjs";

const ACP_FIXTURE = new URL("./fixtures/dsh-acp-presentation.cjs", import.meta.url);

function extractFunction(source: string, name: string): string {
  const functionStart = source.indexOf(`function ${name}(`);
  if (functionStart === -1) throw new Error(`Missing ${name}`);
  const start = source.slice(functionStart - 6, functionStart) === "async " ? functionStart - 6 : functionStart;
  let depth = 0;
  const bodyStart = source.indexOf("{", start);
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed ${name}`);
}

describe("DSH ACP tool presentation compatibility", () => {
  test("patch is a non-destructive, idempotent source transformation", () => {
    const original = readFileSync(ACP_FIXTURE, "utf8");
    const changed = patchDshAcpBundle(original);
    expect(changed.changed).toBe(true);
    expect(original).not.toContain("dsh-acp-tool-presentation-compat-v1");
    expect(changed.source).toContain("dsh-acp-tool-presentation-compat-v3");
    expect(changed.source).toContain("this.toolPresentation.delete(callId)");
    const repeated = patchDshAcpBundle(changed.source);
    expect(repeated.changed).toBe(false);
    expect(repeated.source).toBe(changed.source);
  });

  test("tool start maps named tools to truthful ACP kinds", () => {
    const patched = patchDshAcpBundle(readFileSync(ACP_FIXTURE, "utf8")).source;
    const evaluate = runInNewContext(
      `${extractFunction(patched, "acpToolKind")}\n${extractFunction(patched, "toolCallUpdate")}\ntoolCallUpdate`,
      { parseToolArguments: JSON.parse },
    );
    const make = (name: string) => evaluate({ data: { callId: "call-1", name, arguments: '{"file_path":"README.md"}' } });
    expect(make("bash")).toMatchObject({ title: "bash", kind: "execute", toolCallId: "call-1", status: "in_progress" });
    expect(make("read")).toMatchObject({ title: "read", kind: "read" });
    expect(make("grep")).toMatchObject({ title: "grep", kind: "search" });
    expect(make("glob")).toMatchObject({ title: "glob", kind: "search" });
    for (const name of ["job_output", "job_list", "terminal_read", "terminal_list", "working_directory"]) {
      expect(make(name)).toMatchObject({ title: name, kind: "other" });
    }
    expect(make("edit")).toMatchObject({ title: "edit", kind: "edit" });
    expect(make("custom_plugin_tool")).toMatchObject({ title: "custom_plugin_tool", kind: "other" });
  });

  test("v1 migration preserves presentation state and corrects non-file tools", () => {
    const current = patchDshAcpBundle(readFileSync(ACP_FIXTURE, "utf8")).source;
    const legacy = current.replace("dsh-acp-tool-presentation-compat-v3", "dsh-acp-tool-presentation-compat-v1")
      .replace(', rawInput: parseToolArguments(event.data.arguments) });', ' });')
      .replace(', rawInput: presentation.rawInput }', ' }')
      .replace('(?:read|read_image)$', '(?:read|read_image|glob|working_directory|terminal_read|terminal_list|job_output|job_list)$')
      .replace('(?:glob|grep|web_search|mcp_tool_search)$', '(?:grep|web_search|mcp_tool_search)$');
    const migrated = patchDshAcpBundle(legacy);
    expect(migrated.changed).toBe(true);
    expect(migrated.source).toBe(current);
    expect(patchDshAcpBundle(migrated.source).changed).toBe(false);
  });

  test("v2 migration preserves terminal arguments needed for path labels", () => {
    const current = patchDshAcpBundle(readFileSync(ACP_FIXTURE, "utf8")).source;
    const legacy = current.replace("dsh-acp-tool-presentation-compat-v3", "dsh-acp-tool-presentation-compat-v2")
      .replace(', rawInput: parseToolArguments(event.data.arguments) });', ' });')
      .replace(', rawInput: presentation.rawInput }', ' }');
    expect(patchDshAcpBundle(legacy).source).toBe(current);
  });

  test("terminal updates preserve call identity, name and kind", async () => {
    const patched = patchDshAcpBundle(readFileSync(ACP_FIXTURE, "utf8")).source;
    const evaluate = runInNewContext(
      `${extractFunction(patched, "acpToolKind")}\n${extractFunction(patched, "toolResultUpdate")}\ntoolResultUpdate`,
      { assistantBlockToAcp: async (_ctx: unknown, block: unknown) => block },
    );
    const message = { toolCallId: "call-1", isError: false, content: [{ type: "text", text: "OK" }] };
    const update = await evaluate({}, { data: { message } }, { name: "bash" });
    expect(update).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "call-1", title: "bash", kind: "execute", status: "completed" });
    const failed = await evaluate({}, { data: { message: { ...message, isError: true } } }, { name: "read", rawInput: { file_path: "README.md" } });
    expect(failed).toMatchObject({ toolCallId: "call-1", title: "read", kind: "read", status: "failed", rawInput: { file_path: "README.md" } });
  });
});
