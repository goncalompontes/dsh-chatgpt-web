#!/usr/bin/env python3
"""Live ACP latency matrix: prompt shapes, repeated runs and bounded concurrency.

Read-only and additive. Creates isolated native ACP sessions against the running
service, never restarts it, and never changes admission policy. Results are kept
under /tmp by default; use --output to choose a directory.
"""
import argparse
import asyncio
import json
from pathlib import Path
import re
import statistics
import tempfile
import time
import urllib.request

BASE = "http://127.0.0.1:17841"
ROOT = Path(__file__).resolve().parent.parent
SMOKE = ROOT / "scripts/smoke-acp-lifecycle.py"
ALL_MODELS = ["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high",
              "chatgpt-web/gpt-6-light", "chatgpt-web/gpt-6-medium", "chatgpt-web/gpt-6-high"]
DEFAULT_SCENARIO_MODELS = ["chatgpt-web/gpt-6-light", "chatgpt-web/medium", "chatgpt-web/gpt-6-high"]


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as response:
        return json.load(response)


def label(model):
    return model.split("/")[-1]


def derive(row):
    sent = row["sentAt"]
    events = row["events"]

    def first(kind, status=None):
        return next((e["at"] - sent for e in events
                     if e["type"] == kind and (status is None or e["status"] == status)), None)

    tool = first("tool_call")
    completed = first("tool_call_update", "completed")
    checkpoints = []
    for data in row.get("diagnosticCheckpoints") or []:
        from datetime import datetime
        at = datetime.fromisoformat(data["capturedAt"].replace("Z", "+00:00")).timestamp()
        checkpoints.append({"name": data["name"], "seconds": at - sent})
    accepted = next((c["seconds"] for c in checkpoints if c["name"] == "send-accepted"), None)
    stages = [{"stage": name, "seconds": int(ms) / 1000} for name, ms in
              re.findall(r"stage=(\w+) completed durationMs=(\d+)", row["sidecarLog"])]
    return {"model": row["model"], "session": row["session"], "turn": row["turn"],
            "case": row.get("case", "read"), "contextChars": row.get("contextChars", 0),
            "hostSetupSeconds": row["hostSetupSeconds"], "toSendAcceptedSeconds": accepted,
            "toFirstToolSeconds": tool,
            "acceptedToFirstToolSeconds": tool - accepted if tool is not None and accepted is not None else None,
            "toolExecutionSeconds": completed - tool if completed is not None and tool is not None else None,
            "toFirstAnswerSeconds": first("agent_message_chunk"),
            "acceptedToFirstAnswerSeconds": (first("agent_message_chunk") - accepted
                                             if first("agent_message_chunk") is not None and accepted is not None else None),
            "toFirstThoughtSeconds": first("agent_thought_chunk"),
            "totalSeconds": row["elapsedSeconds"], "stages": stages,
            "retainedPage": "reused=true" in row["sidecarLog"],
            "checkpoints": sorted(checkpoints, key=lambda item: item["seconds"])}


def summarize(values):
    values = [value for value in values if value is not None]
    if not values:
        return None
    ordered = sorted(values)
    return {"n": len(ordered), "median": round(statistics.median(ordered), 3),
            "mean": round(statistics.mean(ordered), 3),
            "min": round(ordered[0], 3), "max": round(ordered[-1], 3)}


def build_jobs(directory, args):
    jobs = []
    runs = args.runs
    read_models = ([m["id"] for m in get("/v1/models")["data"]] if args.read_models == "all"
                   else [m for m in args.read_models.split(",") if m])
    scenario_models = [m for m in args.scenario_models.split(",") if m]

    def add(stage, model, case, turn, run, width=1, batch=0):
        job_id = f"{stage}-{case}-{label(model)}-r{run}" + (f"-w{width}b{batch}" if width > 1 else "")
        jobs.append({"id": job_id, "stage": stage, "model": model, "case": case,
                     "turn": turn, "run": run, "width": width, "batch": batch,
                     "output": str(directory / f"{job_id}.jsonl"), "log": str(directory / f"{job_id}.log")})

    if "serial" in args.stages:
        for run in range(1, runs + 1):
            order = read_models if run % 2 else list(reversed(read_models))
            for model in order:
                add("serial", model, "read", "both", run)
        for run in range(1, runs + 1):
            for model in scenario_models:
                for case in ("answer", "long"):
                    add("serial", model, case, "fresh", run)

    if "concurrency" in args.stages:
        model = args.concurrent_model
        for width in args.widths:
            for batch in range(1, args.concurrent_batches + 1):
                for index in range(width):
                    add("concurrency", model, "read", "fresh", index + 1, width=width, batch=batch)
    return jobs


async def run_job(job, args):
    command = ["python3", str(SMOKE), "--scenario", "latency", "--model", job["model"],
               "--cwd", str(ROOT), "--timeout", str(args.timeout),
               "--latency-output", job["output"], "--latency-case", job["case"],
               "--latency-turns", job["turn"]]
    if job["case"] == "long":
        command += ["--latency-context-chars", str(args.context_chars)]
    started = time.monotonic()
    with open(job["log"], "wb") as log:
        process = await asyncio.create_subprocess_exec(*command, stdout=log, stderr=asyncio.subprocess.STDOUT)
        limit = args.timeout * (2 if job["turn"] == "both" else 1) + 60
        try:
            code = await asyncio.wait_for(process.wait(), limit)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            code = "timeout"
    job["wallSeconds"] = round(time.monotonic() - started, 3)
    job["exitCode"] = code
    job["error"] = None
    if code != 0:
        text = Path(job["log"]).read_text(errors="replace")
        job["error"] = text[-3000:]
        if re.search(r"usage limit", text, re.I):
            job["quota"] = True
    return job


async def wait_for_settled(max_external, timeout=60):
    """Wait until no admissions are pending and no new turns above the baseline run."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        health = get("/healthz")
        admission = health["browser_admission"]
        active = max(health["active_http_turns"], health["active_browser_turns"], admission["active"])
        if health.get("accepting_turns") and admission["pending"] == 0 and active <= max_external:
            return health
        await asyncio.sleep(2)
    raise RuntimeError(
        f"Service did not settle within {timeout}s (baseline external turns={max_external})")


async def main(args):
    if args.output:
        directory = Path(args.output).expanduser()
        if directory.exists() and any(directory.iterdir()):
            raise SystemExit(f"Refusing to reuse non-empty output directory: {directory}")
    else:
        directory = Path(tempfile.mkdtemp(prefix="dsh-latency-matrix-"))
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o700)
    args.stages = args.stages.split(",")
    jobs = build_jobs(directory, args)
    (directory / "plan.json").write_text(json.dumps({"jobs": jobs, "args": vars(args)}, indent=2) + "\n")
    print(json.dumps({"directory": str(directory), "jobs": len(jobs)}), flush=True)

    failures = []
    aborted = None
    initial = get("/healthz")
    baseline_external = max(initial["active_http_turns"], initial["active_browser_turns"],
                            initial["browser_admission"]["active"])
    print(json.dumps({"baselineExternalTurns": baseline_external}), flush=True)
    if "serial" in args.stages:
        try:
            before = await wait_for_settled(baseline_external, 30)
            (directory / "health-serial-before.json").write_text(json.dumps(before, indent=2))
            for job in [j for j in jobs if j["stage"] == "serial"]:
                await wait_for_settled(baseline_external, 180)
                await run_job(job, args)
                print(json.dumps({"job": job["id"], "exit": job["exitCode"], "wall": job["wallSeconds"]}), flush=True)
                if job["exitCode"] != 0:
                    failures.append(job)
                    if job.get("quota"):
                        aborted = "usage limit"
                        break
        except RuntimeError as exc:
            aborted = str(exc)
        try:
            (directory / "health-serial-after.json").write_text(
                json.dumps(await wait_for_settled(baseline_external, 120), indent=2))
        except RuntimeError as exc:
            aborted = aborted or str(exc)

    if not aborted and "concurrency" in args.stages:
        batches = {}
        for job in [j for j in jobs if j["stage"] == "concurrency"]:
            batches.setdefault((job["width"], job["batch"]), []).append(job)
        try:
            for (width, batch), group in sorted(batches.items()):
                health = await wait_for_settled(baseline_external, 180)
                (directory / f"health-concurrency-w{width}b{batch}-before.json").write_text(json.dumps(health, indent=2))
                started = time.monotonic()
                await asyncio.gather(*(run_job(job, args) for job in group))
                wall = round(time.monotonic() - started, 3)
                after = await wait_for_settled(baseline_external, 180)
                (directory / f"health-concurrency-w{width}b{batch}-after.json").write_text(json.dumps(after, indent=2))
                queue_delta = after["browser_admission"]["totalQueueWaitMs"] - health["browser_admission"]["totalQueueWaitMs"]
                for job in group:
                    job["batchWallSeconds"] = wall
                    job["batchQueueWaitDeltaMs"] = round(queue_delta, 3)
                    print(json.dumps({"job": job["id"], "exit": job["exitCode"], "wall": job["wallSeconds"]}), flush=True)
                    if job["exitCode"] != 0:
                        failures.append(job)
                    if job.get("quota"):
                        aborted = "usage limit"
                if aborted:
                    break
        except RuntimeError as exc:
            aborted = str(exc)

    rows = []
    for job in jobs:
        path = Path(job["output"])
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            derived = derive(json.loads(line))
            derived.update({"job": job["id"], "stage": job["stage"], "width": job["width"],
                            "batch": job["batch"], "run": job["run"]})
            rows.append(derived)
    (directory / "results.json").write_text(json.dumps(rows, indent=2) + "\n")

    groups = []
    keys = sorted({(r["stage"], r["case"], label(r["model"]), r["turn"], r["width"], r["batch"]) for r in rows})
    for stage, case, name, turn, width, batch in keys:
        subset = [r for r in rows if r["stage"] == stage and r["case"] == case and label(r["model"]) == name
                  and r["turn"] == turn and r["width"] == width and r["batch"] == batch]
        group = {"stage": stage, "case": case, "model": name, "turn": turn, "width": width,
                 "batch": batch, "n": len(subset)}
        for field in ("hostSetupSeconds", "toSendAcceptedSeconds", "acceptedToFirstToolSeconds",
                      "toFirstToolSeconds", "toolExecutionSeconds", "acceptedToFirstAnswerSeconds",
                      "toFirstAnswerSeconds", "totalSeconds"):
            group[field] = summarize([r[field] for r in subset])
        groups.append(group)

    concurrency = []
    for (width, batch) in sorted({(r["width"], r["batch"]) for r in rows if r["stage"] == "concurrency"}):
        subset = [r for r in rows if r["stage"] == "concurrency" and r["width"] == width and r["batch"] == batch]
        wall = next((j["batchWallSeconds"] for j in jobs if j["stage"] == "concurrency"
                     and j["width"] == width and j["batch"] == batch and "batchWallSeconds" in j), None)
        queue = next((j["batchQueueWaitDeltaMs"] for j in jobs if j["stage"] == "concurrency"
                      and j["width"] == width and j["batch"] == batch and "batchQueueWaitDeltaMs" in j), None)
        totals = [r["totalSeconds"] for r in subset]
        concurrency.append({"width": width, "batch": batch, "turns": len(subset),
                            "wallSeconds": wall, "queueWaitDeltaMs": queue,
                            "medianTurnSeconds": round(statistics.median(totals), 3) if totals else None,
                            "turnsPerMinute": round(len(subset) / wall * 60, 2) if wall else None})
    summary = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "directory": str(directory), "aborted": aborted,
               "baselineExternalTurns": baseline_external,
               "jobCount": len(jobs), "turnCount": len(rows), "groups": groups,
               "concurrency": concurrency,
               "failures": [{"job": j["id"], "exit": j["exitCode"], "quota": j.get("quota", False),
                             "error": (j.get("error") or "")[-800:]} for j in failures]}
    (directory / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")

    for group in groups:
        total = group["totalSeconds"]
        if not total:
            continue
        print(f'{group["case"]:6} {group["model"]:12} {group["turn"]:8} w{group["width"]} '
              f'n={total["n"]} total median={total["median"]:6.1f}s range={total["min"]:5.1f}-{total["max"]:5.1f}s '
              f'setup={(group["toSendAcceptedSeconds"] or {}).get("median")}', flush=True)
    print(json.dumps({"done": True, "directory": str(directory), "turnCount": len(rows),
                      "failures": len(failures), "aborted": aborted}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", help="Empty directory for evidence; default is a new /tmp directory")
    parser.add_argument("--stages", default="serial,concurrency", help="serial,concurrency")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--read-models", default="all", help="all or comma-separated catalog ids")
    parser.add_argument("--scenario-models", default=",".join(DEFAULT_SCENARIO_MODELS))
    parser.add_argument("--concurrent-model", default="chatgpt-web/gpt-6-light")
    parser.add_argument("--concurrent-batches", type=int, default=2)
    parser.add_argument("--widths", default="3,6", help="Comma-separated concurrent widths")
    parser.add_argument("--context-chars", type=int, default=30000)
    args = parser.parse_args()
    args.widths = [int(width) for width in args.widths.split(",") if width]
    asyncio.run(main(args))
