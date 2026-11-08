#!/usr/bin/env python3
"""Explicit live ACP smoke checks. Creates isolated DSH sessions; executes read-only work."""
import argparse
import asyncio
import json
import re
from pathlib import Path
import shutil
import tempfile
import time


async def main(args):
    updates = []
    update_times = []
    launched_at = time.time()
    captured = tempfile.NamedTemporaryFile(prefix="dsh-acp-updates-", suffix=".jsonl", mode="w", delete=False) if args.capture_updates else None
    sequence = 0
    session = None
    cancel_on_tool = False
    observer = None
    observer_dir = tempfile.TemporaryDirectory(prefix="dsh-lifecycle-observer-") if args.scenario in ("compact", "compact-active", "native-failure") else None
    launch_args = [args.dsh, "--profile", "acp"]
    if observer_dir:
        directory = Path(observer_dir.name)
        observer = directory / "control.sock"
        fixture = Path(__file__).resolve().parent / "fixtures/dsh-lifecycle-observer.mjs"
        overlay = directory / "overlay.yml"
        # JSON values are also valid YAML scalar values.
        overlay.write_text("- insert:\n    - id: lifecycle-smoke-observer\n      name: " + json.dumps(str(fixture))
                           + "\n      config:\n        socket: " + json.dumps(str(observer))
                           + "\n        events: " + json.dumps(str(directory / "events.jsonl"))
                           + "\n        activeCompaction: " + str(args.scenario == "compact-active").lower()
                           + "\n        activeFailure: " + str(args.scenario == "native-failure").lower() + "\n")
        launch_args += ["--patch", str(overlay)]
    with tempfile.NamedTemporaryFile(prefix="dsh-acp-smoke-", suffix=".log", delete=False) as log:
        process = await asyncio.create_subprocess_exec(
            *launch_args, cwd=args.cwd,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=log,
        )

    async def send(message):
        process.stdin.write((json.dumps(message) + "\n").encode())
        await process.stdin.drain()

    async def request(method, params):
        nonlocal sequence, cancel_on_tool
        sequence += 1
        request_id = sequence
        await send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        async with asyncio.timeout(args.timeout):
            while True:
                raw = await process.stdout.readline()
                if not raw:
                    raise RuntimeError(f"ACP exited; inspect {log.name}")
                message = json.loads(raw)
                if message.get("id") == request_id:
                    if "error" in message:
                        raise RuntimeError(json.dumps(message["error"]))
                    return message.get("result", {})
                if message.get("method") == "session/update":
                    update = message["params"]["update"]
                    updates.append(update)
                    update_times.append(time.time())
                    if captured:
                        captured.write(json.dumps(update) + "\n")
                        captured.flush()
                    if cancel_on_tool and update.get("sessionUpdate") == "tool_call":
                        cancel_on_tool = False
                        await send({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session}})
                elif "method" in message and "id" in message:
                    await send({"jsonrpc": "2.0", "id": message["id"], "error": {
                        "code": -32601, "message": "Unsupported smoke client request",
                    }})

    async def prompt(text, marker, required):
        start = len(updates)
        began = time.monotonic()
        sent_at = time.time()
        sidecar_log = Path.home() / ".local/state/dsh-web-stack/sidecar.log"
        log_offset = sidecar_log.stat().st_size if args.scenario == "latency" else None
        result = await request("session/prompt", {
            "sessionId": session, "prompt": [{"type": "text", "text": text}],
        })
        turn = updates[start:]
        terminal = [u for u in turn if u.get("sessionUpdate") == "tool_call_update" and u.get("status") in ("completed", "failed")]
        completed = [u for u in terminal if u["status"] == "completed"]
        started = {u["toolCallId"]: u for u in turn if u.get("sessionUpdate") == "tool_call"}
        answer = "".join(u.get("content", {}).get("text", "") for u in turn if u.get("sessionUpdate") == "agent_message_chunk")
        assert result.get("stopReason") == "end_turn", result
        assert marker in answer.replace("\\_", "_"), answer
        assert required <= {u.get("title") for u in completed}, completed
        if args.scenario == "latency":
            assert len(started) == len(completed) == 1 and completed[0]["title"] == "read", completed
            # Preserve wall-clock event times for correlation with diagnostic capturedAt;
            # elapsed total uses the monotonic clock. No synthetic progress is counted.
            events = [{"at": at, "type": u.get("sessionUpdate"), "title": u.get("title"), "status": u.get("status")}
                      for u, at in zip(turn, update_times[start:])]
            sidecar = sidecar_log.read_bytes()[log_offset:].decode(errors="replace")
            row = {"model": args.model, "session": session, "turn": args.latency_turn,
                   "sentAt": sent_at, "hostSetupSeconds": sent_at - launched_at if args.latency_turn == "fresh" else None,
                   "elapsedSeconds": time.monotonic() - began, "events": events,
                   "traceIds": list(dict.fromkeys(re.findall(r"managed_conversation trace=([a-f0-9]+)", sidecar))),
                   "sidecarLog": sidecar}
            row["diagnosticCheckpoints"] = []
            if len(row["traceIds"]) == 1:
                trace = row["traceIds"][0]
                folders = re.findall(r"browser diagnostic trace=" + trace + r" .*? path=([^\n]+)", sidecar)
                for folder in set(folders):
                    for path in Path(folder).glob("*.json"):
                        data = json.loads(path.read_text())
                        row["diagnosticCheckpoints"].append({"name": data["checkpoint"], "capturedAt": data["capturedAt"]})
            with Path(args.latency_output).open("a") as output:
                output.write(json.dumps(row) + "\n")
            print(json.dumps({"latency": {k: v for k, v in row.items() if k not in ("events", "sidecarLog", "diagnosticCheckpoints")}}), flush=True)
        if args.scenario == "load":
            assert len(started) == 1 and len(completed) == 1, "Load check must execute exactly one foreground tool"
            assert marker in json.dumps(completed[0].get("content", [])), "Native tool output did not contain the marker"
            elapsed = time.monotonic() - began
            assert elapsed >= args.load_seconds - 1, "Load command completed before its requested duration"
            print(json.dumps({"loadDurationSeconds": elapsed}), flush=True)
        if args.scenario in ("background", "background-long"):
            assert sum(u.get("title") == "bash" for u in started.values()) == 1, "Background command was replayed"
            for call in started.values():
                if call.get("title") == "job_output" and "timeout_ms" in call.get("rawInput", {}):
                    assert 0 <= call["rawInput"]["timeout_ms"] <= 30000, "Job poll exceeded 30 seconds"
            collected = [u for u in completed if u.get("title") == "job_output"]
            assert any(marker in json.dumps(u.get("content", [])) for u in collected), "Background output marker was not collected"
            if args.scenario == "background-long":
                assert time.monotonic() - began >= args.load_seconds - 1, "Background job ended before its requested duration"
        if args.scenario == "parallel-batch":
            assert sum(u.get("title") == "read" for u in completed) >= 2, completed
            starts = [index for index, update in enumerate(turn)
                      if update.get("sessionUpdate") == "tool_call" and update.get("title") == "read"]
            terminals = [index for index, update in enumerate(turn)
                         if update.get("sessionUpdate") == "tool_call_update" and update.get("title") == "read"]
            assert len(starts) >= 2 and len(terminals) >= 2 and max(starts[:2]) < min(terminals[:2]), turn
        for update in terminal:
            original = started[update["toolCallId"]]
            assert update.get("title") == original["title"], update
            assert update.get("kind") == original["kind"], update
            if update["title"] == "bash":
                assert update["kind"] == "execute", update
        return started

    try:
        await request("initialize", {"protocolVersion": 1, "clientCapabilities": {},
                                    "clientInfo": {"name": "dsh-lifecycle-smoke", "version": "1"}})
        created = await request("session/new", {"cwd": args.cwd, "mcpServers": []})
        session = created["sessionId"]
        if observer and not observer.exists():
            raise RuntimeError(f"Smoke observer was not mounted; inspect {log.name}")
        model = next(option for option in created["configOptions"] if option.get("category") == "model")
        await request("session/set_config_option", {
            "sessionId": session, "configId": model["id"],
            "value": json.dumps(["chatgpt-web", args.model], separators=(",", ":")),
        })
        if args.scenario == "latency":
            for kind in ("fresh", "retained"):
                args.latency_turn = kind
                await prompt("Read-only timing check. Use read exactly once to read the first 5 lines of README.md. "
                             "Then reply DSH_LATENCY_OK only. Do not use other tools or change files.",
                             "DSH_LATENCY_OK", {"read"})
        elif args.scenario == "context-isolation":
            topic = "Lisbon public transport: Metro Lisboa, CP trains and Carris buses" if args.context_topic == "transit" else "Vista: remotely streaming individual Linux Wayland applications to an iPhone"
            label = "TRANSIT" if args.context_topic == "transit" else "VISTA"
            marker = f"DSH_{label}_{session[:8]}"
            await prompt(
                f"Read-only conversation isolation check. Our topic is {topic}. "
                f"Our private reference is {marker}. Give one short sentence describing our topic and include the reference exactly. "
                "Do not use tools or access files.", marker, set(),
            )
            followup_start = len(updates)
            await prompt(
                "Are there iPhone apps that already have all this information? "
                "Name the topic we were discussing, give one relevant app example, and repeat our private reference. "
                "Answer in at most three sentences. Do not use tools or access files.", marker, set(),
            )
            followup = "".join(u.get("content", {}).get("text", "") for u in updates[followup_start:]
                               if u.get("sessionUpdate") == "agent_message_chunk").lower()
            if args.context_topic == "transit":
                assert "lisbon" in followup and "vista" not in followup, followup
            else:
                assert "vista" in followup and "lisbon" not in followup, followup
            assert not any(u.get("sessionUpdate") == "tool_call" for u in updates), "Context check unexpectedly executed tools"
        elif args.scenario == "cancel":
            cancel_on_tool = True
            result = await request("session/prompt", {
                "sessionId": session, "prompt": [{"type": "text", "text":
                    "Read-only cancellation smoke check. Use bash to run `sleep 10; printf DSH_CANCEL_TARGET`. "
                    "Do not change files or run other commands."}],
            })
            assert not cancel_on_tool, "No tool call observed to trigger cancellation"
            assert result.get("stopReason") == "cancelled", result
            await prompt(
                "The cancellation test is over. Use bash exactly once to run `printf DSH_CANCEL_RECOVERED`. "
                "Then reply DSH_CANCEL_RECOVERED only. Do not modify files or run other commands.",
                "DSH_CANCEL_RECOVERED", {"bash"},
            )
        elif args.scenario == "parallel-batch":
            await prompt(
                "Read-only native DSH batch check. Use the dsh connector's dsh_parallel tool exactly once "
                "with two independent read calls in its calls array: README.md lines 1-3 and package.json lines 1-3. "
                "Do not call read directly and do not use any other tool. After the batch succeeds reply DSH_BATCH_OK only.",
                "DSH_BATCH_OK", {"read"},
            )
        elif args.scenario == "parallel":
            start = len(updates)
            started = await prompt(
                "Read-only parallel tool smoke check. In one parallel batch, make two independent read tool calls: "
                "read README.md lines 1-3 and package.json lines 1-3. "
                "After both finish reply DSH_PARALLEL_OK only. Do not change files or use other tools.",
                "DSH_PARALLEL_OK", {"read"},
            )
            assert len(started) == 2, started
            in_flight = set()
            peak = 0
            for update in updates[start:]:
                if update.get("sessionUpdate") == "tool_call":
                    in_flight.add(update["toolCallId"])
                    peak = max(peak, len(in_flight))
                elif update.get("sessionUpdate") == "tool_call_update" and update.get("status") in ("completed", "failed"):
                    in_flight.discard(update["toolCallId"])
            assert peak >= 2, "No overlapping native tool calls observed; inspect captured updates and broker batches"
            print(json.dumps({"parallelPeak": peak}), flush=True)
        elif args.scenario == "mixed-failure":
            start = len(updates)
            started = await prompt(
                f"Read-only failure check. Use read once on the nonexistent file __dsh_smoke_missing_{session}. "
                "Then use bash once to run `printf DSH_MIXED_OK`. The missing-file error is expected; "
                "do not retry or create the file. After confirming bash's output reply DSH_MIXED_OK only. "
                "Do not change files or use other tools.", "DSH_MIXED_OK", {"bash"},
            )
            assert sorted(call["title"] for call in started.values()) == ["bash", "read"], started
            failed = [u for u in updates[start:] if u.get("sessionUpdate") == "tool_call_update" and u.get("status") == "failed"]
            assert len(failed) == 1 and failed[0]["title"] == "read", failed
        elif args.scenario in ("background", "background-long"):
            delay = args.load_seconds if args.scenario == "background-long" else 2
            started = await prompt(
                f"This is a read-only lifecycle smoke check. Use bash to run `sleep {delay}; printf DSH_BACKGROUND_OK` "
                "with run_in_background=true. While it runs, read the first 5 lines of README.md using read. "
                "Collect the job result using job_output. Reply DSH_BACKGROUND_OK only after confirming its output. "
                "Use bounded job_output polls of at most 30 seconds if supported by the native schema. "
                "Do not change files or run any other commands.", "DSH_BACKGROUND_OK", {"bash", "read", "job_output"},
            )
            assert any(u.get("title") == "bash" and u.get("rawInput", {}).get("run_in_background") is True
                       for u in started.values()), started
        else:
            # Give native summarization enough compressible history to satisfy its
            # strict smaller-than-source requirement before testing checkpoint recovery.
            command = (f"sleep {args.load_seconds}; printf DSH_ACP_OK" if args.scenario == "load" else
                       "printf 'DSH_COMPACTION_SEED_%04d\\n' {1..128}; printf DSH_ACP_OK"
                       if args.scenario in ("compact", "compact-active") else "printf DSH_ACP_OK")
            await prompt(
                "This is a read-only lifecycle smoke check. Use bash exactly once to run "
                + f"`{command}`. " +
                "Then reply DSH_ACP_OK only. Do not modify files or run any other commands. "
                + ("Keep bash in the foreground, set its native timeout long enough for the complete command, "
                   "and wait for the actual output; do not background it." if args.scenario == "load" else ""),
                "DSH_ACP_OK", {"bash"},
            )
            if args.scenario == "native-failure":
                try:
                    await prompt(
                        "Read-only failure cleanup check. Use bash exactly once to run `printf DSH_BEFORE_NATIVE_FAILURE`. "
                        "Then reply DSH_BEFORE_NATIVE_FAILURE. Do not modify files or run other commands.",
                        "DSH_BEFORE_NATIVE_FAILURE", {"bash"},
                    )
                except RuntimeError as error:
                    assert "DSH_SMOKE_INJECTED_NATIVE_FAILURE" in str(error), str(error)
                else:
                    raise AssertionError("The native failure hook did not run")
                started = await prompt(
                    "The failure test is over. Use bash exactly once to run `printf DSH_NATIVE_RECOVERED`. "
                    "Then reply DSH_NATIVE_RECOVERED only. Do not modify files or run other commands.",
                    "DSH_NATIVE_RECOVERED", {"bash"},
                )
                assert len(started) == 1, started
            elif args.scenario == "compact-active":
                started = await prompt(
                    "This is an active-turn compaction check. First use bash to run `printf DSH_BEFORE_CHECKPOINT`. "
                    "Then use read to inspect README.md lines 1-3. After both tools finish reply DSH_ACTIVE_COMPACT_OK only. "
                    "Do not modify files or run other commands.", "DSH_ACTIVE_COMPACT_OK", {"bash", "read"},
                )
                assert sorted(call["title"] for call in started.values()) == ["bash", "read"], started
                evidence = Path(observer_dir.name) / "events.jsonl"
                events = [json.loads(line) for line in evidence.read_text().splitlines()]
                checkpoint = next(event for event in events if event["type"] == "compaction/summary")
                ended = next(event for event in events if event["type"] == "compaction/end")
                assert checkpoint["shadowedItems"] > 0 and ended.get("turn") == 2, events
                calls = [event for event in events if event["type"] == "tool/call" and event["seq"] > ended["seq"]]
                results = [event for event in events if event["type"] == "tool/result" and event["seq"] > ended["seq"]]
                assert calls and {event["callId"] for event in calls} == {event["callId"] for event in results}, events
                assert not any(event["isError"] for event in results), results
                print(json.dumps({"activeCompaction": checkpoint, "events": log.name + ".events.jsonl"}), flush=True)
            elif args.scenario == "compact":
                reader, writer = await asyncio.open_unix_connection(str(observer))
                try:
                    writer.write((json.dumps({"operation": "compact", "sessionId": session}) + "\n").encode())
                    await writer.drain()
                    async with asyncio.timeout(args.timeout):
                        compacted = json.loads(await reader.readline())
                    assert compacted.get("ok") and compacted.get("shadowedItems", 0) > 0, compacted
                    print(json.dumps({"compaction": compacted, "session": session}), flush=True)
                finally:
                    writer.close()
                    await writer.wait_closed()
                await prompt(
                    "This is the post-compaction read-only check. Use bash exactly once to run `printf DSH_COMPACTED_OK`. "
                    "Then reply DSH_COMPACTED_OK only. Do not modify files or run other commands.",
                    "DSH_COMPACTED_OK", {"bash"},
                )
                evidence = Path(observer_dir.name) / "events.jsonl"
                events = [json.loads(line) for line in evidence.read_text().splitlines()]
                checkpoint = next(event for event in events if event["type"] == "compaction/summary")
                ended = next(event for event in events if event["type"] == "compaction/end")
                assert checkpoint["shadowedItems"] > 0 and ended["seq"] > checkpoint["seq"], events
                calls = [event for event in events if event["type"] == "tool/call" and event["seq"] > ended["seq"]]
                results = [event for event in events if event["type"] == "tool/result" and event["seq"] > ended["seq"]]
                assert calls and {event["callId"] for event in calls} == {event["callId"] for event in results}, events
                assert not any(event["isError"] for event in results), results
                destination = Path(log.name + ".events.jsonl")
                shutil.copyfile(evidence, destination)
                print(json.dumps({"events": str(destination)}), flush=True)
            elif args.scenario in ("resume", "reconnect"):
                if args.scenario == "reconnect":
                    previous_pid = process.pid
                    # Lose the entire ACP transport without session/close, then attach
                    # through a fresh native host to the same persisted session.
                    process.stdin.close()
                    await asyncio.wait_for(process.wait(), 20)
                    with open(log.name, "ab") as stderr:
                        process = await asyncio.create_subprocess_exec(
                            *launch_args, cwd=args.cwd, stdin=asyncio.subprocess.PIPE,
                            stdout=asyncio.subprocess.PIPE, stderr=stderr,
                        )
                    await request("initialize", {"protocolVersion": 1, "clientCapabilities": {},
                                                 "clientInfo": {"name": "dsh-reconnect-smoke", "version": "1"}})
                    print(json.dumps({"transportLost": previous_pid, "reconnected": process.pid,
                                      "session": session}), flush=True)
                else:
                    await request("session/close", {"sessionId": session})
                await request("session/resume", {"sessionId": session, "cwd": args.cwd, "mcpServers": []})
                await prompt(
                    "This is the resumed read-only check. Use bash exactly once to run `printf DSH_RESUMED_OK`. "
                    "Then reply DSH_RESUMED_OK only. Do not modify files or run any other commands.", "DSH_RESUMED_OK", {"bash"},
                )
        print(json.dumps({"ok": True, "scenario": args.scenario, "session": session,
                          "tools": [{"name": u.get("title"), "kind": u.get("kind"), "status": u.get("status")}
                                    for u in updates if u.get("sessionUpdate") == "tool_call_update"],
                          "stderrLog": log.name}))
    finally:
        if session and process.returncode is None:
            try:
                await send({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session}})
                await asyncio.wait_for(request("session/close", {"sessionId": session}), 15)
            except (Exception, asyncio.CancelledError):
                pass
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 10)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        if observer_dir:
            evidence = Path(observer_dir.name) / "events.jsonl"
            if evidence.exists():
                shutil.copyfile(evidence, Path(log.name + ".events.jsonl"))
            observer_dir.cleanup()
        if captured:
            captured.close()
            print(json.dumps({"capturedUpdates": captured.name}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsh", default=shutil.which("dsh") or str(Path.home() / ".local/bin/dsh"))
    parser.add_argument("--cwd", default=str(Path.cwd()))
    parser.add_argument("--model", default="chatgpt-web/gpt-6-light")
    parser.add_argument("--scenario", choices=("tool", "load", "background", "background-long", "resume", "reconnect", "cancel", "parallel", "parallel-batch", "mixed-failure", "compact", "compact-active", "native-failure", "context-isolation", "latency"), default="tool")
    parser.add_argument("--latency-output", help="Private JSONL timing evidence for the latency scenario")
    parser.add_argument("--context-topic", choices=("transit", "vista"), default="transit")
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--load-seconds", type=int, default=30)
    parser.add_argument("--capture-updates", action="store_true", help="Retain private ACP update JSONL for consumer compatibility probes")
    args = parser.parse_args()
    if args.scenario == "latency" and not args.latency_output:
        parser.error("--latency-output is required for the latency scenario")
    if not 1 <= args.load_seconds <= 300:
        parser.error("--load-seconds must be between 1 and 300")
    asyncio.run(main(args))
