#!/usr/bin/env python3
"""Explicit live ACP smoke checks. Creates isolated DSH sessions; executes read-only work."""
import argparse
import asyncio
import json
from pathlib import Path
import shutil
import tempfile


async def main(args):
    updates = []
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
                    if cancel_on_tool and update.get("sessionUpdate") == "tool_call":
                        cancel_on_tool = False
                        await send({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session}})
                elif "method" in message and "id" in message:
                    await send({"jsonrpc": "2.0", "id": message["id"], "error": {
                        "code": -32601, "message": "Unsupported smoke client request",
                    }})

    async def prompt(text, marker, required):
        start = len(updates)
        result = await request("session/prompt", {
            "sessionId": session, "prompt": [{"type": "text", "text": text}],
        })
        turn = updates[start:]
        completed = [u for u in turn if u.get("sessionUpdate") == "tool_call_update" and u.get("status") == "completed"]
        started = {u["toolCallId"]: u for u in turn if u.get("sessionUpdate") == "tool_call"}
        answer = "".join(u.get("content", {}).get("text", "") for u in turn if u.get("sessionUpdate") == "agent_message_chunk")
        assert result.get("stopReason") == "end_turn", result
        assert marker in answer.replace("\\_", "_"), answer
        assert required <= {u.get("title") for u in completed}, completed
        for update in completed:
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
        if args.scenario == "cancel":
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
        elif args.scenario == "parallel":
            start = len(updates)
            await prompt(
                "Read-only parallel tool smoke check. In one parallel batch, make two independent read tool calls: "
                "read README.md lines 1-3 and package.json lines 1-3. "
                "After both finish reply DSH_PARALLEL_OK only. Do not change files or use other tools.",
                "DSH_PARALLEL_OK", {"read"},
            )
            in_flight = set()
            peak = 0
            for update in updates[start:]:
                if update.get("sessionUpdate") == "tool_call":
                    in_flight.add(update["toolCallId"])
                    peak = max(peak, len(in_flight))
                elif update.get("sessionUpdate") == "tool_call_update" and update.get("status") in ("completed", "failed"):
                    in_flight.discard(update["toolCallId"])
            assert peak >= 2, "Model did not issue overlapping tool calls"
        elif args.scenario == "background":
            started = await prompt(
                "This is a read-only lifecycle smoke check. Use bash to run `sleep 2; printf DSH_BACKGROUND_OK` "
                "with run_in_background=true. While it runs, read the first 5 lines of README.md using read. "
                "Collect the job result using job_output. Reply DSH_BACKGROUND_OK only after confirming its output. "
                "Do not change files or run any other commands.", "DSH_BACKGROUND_OK", {"bash", "read", "job_output"},
            )
            assert any(u.get("title") == "bash" and u.get("rawInput", {}).get("run_in_background") is True
                       for u in started.values()), started
        else:
            # Give native summarization enough compressible history to satisfy its
            # strict smaller-than-source requirement before testing checkpoint recovery.
            command = ("sleep 30; printf DSH_ACP_OK" if args.scenario == "load" else
                       "printf 'DSH_COMPACTION_SEED_%04d\\n' {1..128}; printf DSH_ACP_OK"
                       if args.scenario in ("compact", "compact-active") else "printf DSH_ACP_OK")
            await prompt(
                "This is a read-only lifecycle smoke check. Use bash exactly once to run "
                + f"`{command}`. " +
                "Then reply DSH_ACP_OK only. Do not modify files or run any other commands.", "DSH_ACP_OK", {"bash"},
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsh", default=shutil.which("dsh") or str(Path.home() / ".local/bin/dsh"))
    parser.add_argument("--cwd", default=str(Path.cwd()))
    parser.add_argument("--model", default="chatgpt-web/gpt-6-light")
    parser.add_argument("--scenario", choices=("tool", "load", "background", "resume", "reconnect", "cancel", "parallel", "compact", "compact-active", "native-failure"), default="tool")
    parser.add_argument("--timeout", type=float, default=180)
    asyncio.run(main(parser.parse_args()))
