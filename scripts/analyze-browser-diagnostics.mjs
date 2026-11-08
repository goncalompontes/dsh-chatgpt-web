#!/usr/bin/env node
/**
 * Read-only, metadata-only browser diagnostic inventory.
 * Never prints prompt/title/body text, which can contain private user content.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function summarizeBrowserDiagnostics(root) {
  const directories = (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const rows = [];
  for (const directory of directories) {
    const folder = join(root, directory);
    const filenames = (await readdir(folder)).filter(name => /^\d+-[^/]+\.json$/.test(name)).sort((a,b) => Number(a.split("-")[0]) - Number(b.split("-")[0]));
    const checkpoints = [];
    let traceId = null;
    let startedAt = null;
    let finishedAt = null;
    let terminalError = null;
    let invalidSnapshots = 0;
    for (const filename of filenames) {
      let obj;
      try {
        obj = JSON.parse(await readFile(join(folder, filename), "utf8"));
      } catch {
        invalidSnapshots++;
        continue;
      }
      const checkpoint = typeof obj.checkpoint === "string" ? obj.checkpoint : filename.replace(/^\d+-|\.json$/g, "");
      traceId ??= typeof obj.traceId === "string" ? obj.traceId : directory;
      startedAt ??= obj.capturedAt ?? null;
      finishedAt = obj.capturedAt ?? finishedAt;
      checkpoints.push(checkpoint);
      if (checkpoint === "turn-failed") terminalError = String(obj.error ?? "unknown").slice(0, 180);
    }
    const terminal = checkpoints.includes("turn-failed") ? "failed" : checkpoints.includes("turn-completed") ? "completed" : "not-recorded";
    const classification = terminalError
      ? /allow once|approval|confirm|locator\.waitFor/i.test(terminalError) ? "approval-or-locator"
      : /abort/i.test(terminalError) ? "aborted"
      : /ERR_NAME_NOT_RESOLVED|network|dns/i.test(terminalError) ? "network"
      : /DOM|response disappeared/i.test(terminalError) ? "dom-lost" : "other"
      : null;
    rows.push({ traceId: traceId ?? directory, snapshotCount: filenames.length, invalidSnapshots, startedAt, finishedAt, terminal, classification, terminalError, checkpoints });
  }
  const count = key => rows.filter(row => row.terminal === key).length;
  return { folderCount: directories.length, snapshotCount: rows.reduce((a,r)=>a+r.snapshotCount,0), failed:count("failed"), completed:count("completed"), noTerminal:count("not-recorded"), traces:rows };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = process.argv[2];
  if (!root) {
    console.error("Usage: node scripts/analyze-browser-diagnostics.mjs <diagnostic-root>");
    process.exitCode = 2;
  } else {
    const summary = await summarizeBrowserDiagnostics(root);
    console.log(JSON.stringify(summary, null, 2));
  }
}
