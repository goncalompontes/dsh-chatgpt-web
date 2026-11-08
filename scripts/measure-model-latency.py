#!/usr/bin/env python3
"""Serial, read-only ACP startup measurements for the live advertised model catalog.

Creates isolated native sessions, not T3 threads. Never restarts services. Evidence
is private under /tmp; --summarize rebuilds results without issuing model requests.
"""
import argparse
import asyncio
from datetime import datetime
import json
from pathlib import Path
import re
import tempfile
import time
import urllib.request

BASE = "http://127.0.0.1:17841"


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=5) as response:
        return json.load(response)


def summarize(directory):
    results = []
    archive_path = directory / "checkpoint-archive.json"
    archive = json.loads(archive_path.read_text()) if archive_path.exists() else {}
    evidence = directory / "timings.jsonl"
    for line in evidence.read_text().splitlines() if evidence.exists() else []:
        row = json.loads(line)
        sent = row["sentAt"]
        events = row["events"]
        first = lambda kind, status=None: next((e["at"] - sent for e in events
            if e["type"] == kind and (status is None or e["status"] == status)), None)
        trace = row["traceIds"][0] if len(row["traceIds"]) == 1 else None
        checkpoints = []
        for data in row.get("diagnosticCheckpoints", []) or archive.get(trace, {}).get("checkpoints", []):
            at = datetime.fromisoformat(data["capturedAt"].replace("Z", "+00:00")).timestamp()
            checkpoints.append({"name": data["name"], "seconds": at - sent})
        if trace and not checkpoints:
            paths = re.findall(r"browser diagnostic trace=" + trace + r" .*? path=([^\n]+)", row["sidecarLog"])
            for folder in set(paths):
                for path in Path(folder).glob("*.json"):
                    data = json.loads(path.read_text())
                    at = datetime.fromisoformat(data["capturedAt"].replace("Z", "+00:00")).timestamp()
                    checkpoints.append({"name": data["checkpoint"], "seconds": at - sent})
        accepted = next((c["seconds"] for c in checkpoints if c["name"] == "send-accepted"), None)
        if accepted is None:
            accepted = archive.get(trace, {}).get("liveSummaryAcceptedSeconds")
        tool = first("tool_call")
        completed = first("tool_call_update", "completed")
        stages = [{"stage": name, "seconds": int(ms) / 1000} for name, ms in
                  re.findall(r"stage=(\w+) completed durationMs=(\d+)", row["sidecarLog"])]
        result = {"model": row["model"], "session": row["session"], "turn": row["turn"],
                  "trace": trace, "hostSetupSeconds": row["hostSetupSeconds"],
                  "toSendAcceptedSeconds": accepted, "toFirstToolSeconds": tool,
                  "acceptedToFirstToolSeconds": tool - accepted if tool is not None and accepted is not None else None,
                  "toolExecutionSeconds": completed - tool if completed is not None and tool is not None else None,
                  "toFirstThoughtSeconds": first("agent_thought_chunk"),
                  "toFirstAnswerSeconds": first("agent_message_chunk"),
                  "totalSeconds": row["elapsedSeconds"], "stages": stages,
                  "retainedPage": "reused=true" in row["sidecarLog"],
                  "checkpoints": sorted(checkpoints, key=lambda c: c["seconds"])}
        results.append(result)
    (directory / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    return results


async def main(args):
    if args.mcp_startup_only:
        args.mcp_startup_only.mkdir(parents=True, exist_ok=True)
        rows = [await mcp_startup() for _ in range(3)]
        (args.mcp_startup_only / "mcp-startup.json").write_text(json.dumps(rows, indent=2))
        print(json.dumps(rows))
        return
    directory = Path(tempfile.mkdtemp(prefix="dsh-model-latency-"))
    directory.chmod(0o700)
    print(json.dumps({"directory": str(directory)}), flush=True)
    models = [m["id"] for m in get("/v1/models")["data"]]
    (directory / "catalog.json").write_text(json.dumps(models, indent=2))
    (directory / "mcp-startup.json").write_text(json.dumps([await mcp_startup() for _ in range(3)], indent=2))
    script = Path(__file__).resolve().with_name("smoke-acp-lifecycle.py")
    failures = []
    for round_index in range(args.rounds):
        for index, model in enumerate(models if round_index % 2 == 0 else reversed(models)):
            health = get("/healthz")
            assert health["accepting_turns"] and health["active_http_turns"] == health["active_browser_turns"] == 0, "Other turns active; measurement stopped without disturbing them"
            assert health["browser_admission"]["pending"] == 0, "Other turns queued"
            label = f"{round_index}-{index}-{model.split('/')[-1]}"
            (directory / f"{label}-health.json").write_text(json.dumps(health, indent=2))
            with (directory / f"{label}.log").open("wb") as log:
                process = await asyncio.create_subprocess_exec("python3", str(script), "--scenario", "latency",
                    "--model", model, "--timeout", str(args.timeout), "--capture-updates",
                    "--latency-output", str(directory / "timings.jsonl"), stdout=log, stderr=asyncio.subprocess.STDOUT)
            try:
                code = await asyncio.wait_for(process.wait(), args.timeout * 2 + 45)
            except BaseException:
                process.terminate()
                await process.wait()
                raise
            results = summarize(directory)
            print(json.dumps({"model": model, "round": round_index + 1, "exitCode": code,
                              "recent": [{k: r[k] for k in ("turn", "toSendAcceptedSeconds", "toFirstToolSeconds", "totalSeconds")}
                                         for r in results[-2:]]}), flush=True)
            if code:
                failures.append({"model": model, "round": round_index + 1, "log": label + ".log"})
    (directory / "failures.json").write_text(json.dumps(failures, indent=2))
    print(json.dumps({"done": True, "directory": str(directory), "failures": failures}), flush=True)


async def mcp_startup():
    start = time.perf_counter()
    root = Path(__file__).resolve().parent.parent
    process = await asyncio.create_subprocess_exec("node", str(root / "lib/cli.js"), "mcp",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    async def send(message):
        process.stdin.write((json.dumps(message) + "\n").encode())
        await process.stdin.drain()
    async def receive(identifier):
        async with asyncio.timeout(15):
            while True:
                raw = await process.stdout.readline()
                if not raw:
                    raise RuntimeError("MCP exited before responding")
                message = json.loads(raw)
                if message.get("id") == identifier:
                    assert "error" not in message, message
                    return message
    try:
        await send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-03-26", "capabilities": {},
            "clientInfo": {"name": "latency-probe", "version": "1"}}})
        await receive(1)
        initialized = time.perf_counter()
        await send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        await send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        result = await receive(2)
        return {"initializeSeconds": initialized - start,
                "initializeAndListSeconds": time.perf_counter() - start,
                "tools": len(result["result"]["tools"])}
    finally:
        process.terminate()
        await process.wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, choices=range(1, 4), default=2)
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--summarize", type=Path)
    parser.add_argument("--mcp-startup-only", type=Path, help="Measure local MCP initialization without issuing model requests")
    args = parser.parse_args()
    if args.summarize:
        print(json.dumps(summarize(args.summarize), indent=2))
    else:
        asyncio.run(main(args))
