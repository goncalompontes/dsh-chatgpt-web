#!/usr/bin/env python3
"""Explicit live load check: isolated ACP clients, one read-only delayed command each.

Run only when other sessions are idle. Keeps all logs and RSS observations under /tmp.
Does not restart workers or change admission policy.
"""
import asyncio
import argparse
import json
from pathlib import Path
import tempfile


async def main(args):
    scripts = Path(__file__).resolve().parent
    directory = Path(tempfile.mkdtemp(prefix="dsh-admission-load-"))
    print(json.dumps({"directory": str(directory)}), flush=True)
    rss = directory / "resources.jsonl"
    with rss.open("wb") as output:
        sampler = await asyncio.create_subprocess_exec("python3", str(scripts / "measure-browser-resources.py"),
            "--samples", str(args.samples), "--interval", str(args.interval), stdout=output,
            stderr=asyncio.subprocess.STDOUT)

    async def client(index):
        with (directory / f"{index}.log").open("wb") as output:
            process = await asyncio.create_subprocess_exec("python3", str(scripts / "smoke-acp-lifecycle.py"),
                "--scenario", "load", "--timeout", str(args.client_timeout),
                "--load-seconds", str(args.load_seconds), stdout=output,
                stderr=asyncio.subprocess.STDOUT)
        code = await process.wait()
        print(json.dumps({"client": index, "exitCode": code}), flush=True)
        return code

    try:
        results = await asyncio.gather(*(client(index) for index in range(args.clients)))
    finally:
        if sampler.returncode is None:
            sampler.terminate()
        await sampler.wait()
    rows = [json.loads(line) for line in rss.read_text().splitlines() if line.startswith("{")]
    assert rows and max(row["admission"]["pending"] for row in rows) > 0, "No queued admission observed"
    assert all(row["active"] <= row["admission"].get("maxCapacity", 5) for row in rows), "Physical browser cap exceeded"
    assert max(row["active"] for row in rows) >= args.min_peak_active, "Requested concurrency was not observed"
    print(json.dumps({"ok": not any(results), "clients": args.clients, "exitCodes": results, "samples": len(rows),
        "peakActive": max(row["active"] for row in rows),
        "peakPending": max(row["admission"]["pending"] for row in rows),
        "peakRssBytes": max(row["treeRssBytes"] for row in rows),
        "maxQueueWaitMs": max(row["admission"]["maxQueueWaitMs"] for row in rows),
        "directory": str(directory)}), flush=True)
    assert not any(results), {"exitCodes": results, "directory": str(directory)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clients", type=int, default=6)
    parser.add_argument("--samples", type=int, default=180)
    parser.add_argument("--interval", type=float, default=2)
    parser.add_argument("--client-timeout", type=float, default=300)
    parser.add_argument("--load-seconds", type=int, default=30)
    parser.add_argument("--min-peak-active", type=int, default=1)
    parsed = parser.parse_args()
    if parsed.clients < 2 or parsed.clients > 32:
        parser.error("--clients must be between 2 and 32")
    if parsed.samples < 1 or parsed.interval <= 0 or parsed.client_timeout <= 0:
        parser.error("--samples must be positive; --interval and --client-timeout must be greater than zero")
    if not 1 <= parsed.load_seconds <= 300 or not 1 <= parsed.min_peak_active <= parsed.clients:
        parser.error("--load-seconds must be 1..300; --min-peak-active must be 1..clients")
    asyncio.run(main(parsed))
