#!/usr/bin/env python3
"""Explicit live load check: six isolated ACP clients, one read-only delayed command each.

Run only when other sessions are idle. Keeps all logs and RSS observations under /tmp.
Does not restart workers or change admission policy.
"""
import asyncio
import json
from pathlib import Path
import tempfile


async def main():
    scripts = Path(__file__).resolve().parent
    directory = Path(tempfile.mkdtemp(prefix="dsh-admission-load-"))
    print(json.dumps({"directory": str(directory)}), flush=True)
    rss = directory / "resources.jsonl"
    with rss.open("wb") as output:
        sampler = await asyncio.create_subprocess_exec("python3", str(scripts / "measure-browser-resources.py"),
            "--samples", "180", "--interval", "2", stdout=output, stderr=asyncio.subprocess.STDOUT)

    async def client(index):
        with (directory / f"{index}.log").open("wb") as output:
            process = await asyncio.create_subprocess_exec("python3", str(scripts / "smoke-acp-lifecycle.py"),
                "--scenario", "load", "--timeout", "300", stdout=output, stderr=asyncio.subprocess.STDOUT)
        code = await process.wait()
        print(json.dumps({"client": index, "exitCode": code}), flush=True)
        return code

    try:
        results = await asyncio.gather(*(client(index) for index in range(6)))
        assert not any(results), {"exitCodes": results, "directory": str(directory)}
    finally:
        if sampler.returncode is None:
            sampler.terminate()
        await sampler.wait()
    rows = [json.loads(line) for line in rss.read_text().splitlines() if line.startswith("{")]
    assert rows and max(row["admission"]["pending"] for row in rows) > 0, "No queued admission observed"
    assert max(row["active"] for row in rows) <= 5, "Physical browser cap exceeded"
    print(json.dumps({"ok": True, "clients": 6, "samples": len(rows),
        "peakActive": max(row["active"] for row in rows),
        "peakPending": max(row["admission"]["pending"] for row in rows),
        "peakRssBytes": max(row["treeRssBytes"] for row in rows),
        "maxQueueWaitMs": max(row["admission"]["maxQueueWaitMs"] for row in rows),
        "directory": str(directory)}), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
