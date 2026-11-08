#!/usr/bin/env python3
"""Explicit live mixed workload: a longer document and PNG export, with RSS sampling.

Creates two isolated sessions; never restarts workers or changes admission policy.
RSS includes shared pages and is not an incremental per-turn capacity estimate.
"""
import asyncio
import importlib.util
import json
from pathlib import Path
import re
import sys
import tempfile
import urllib.request
import uuid


SCRIPTS = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("browser_resources", SCRIPTS / "measure-browser-resources.py")
resources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resources)
HEALTH = "http://127.0.0.1:17841/healthz"


def validate_document(result, session):
    text = "".join(part.get("text", "") for item in result.get("output", [])
                   if item.get("type") == "message" for part in item.get("content", []))
    # Turndown escapes punctuation even in headings and plain final markers.
    normalized = re.sub(r"\\([\\`*_{}\[\]()#+.!>~-])", r"\1", text)
    assert result.get("status") == "completed", result.get("error")
    assert len(text) >= 8000, f"Document too short: {len(text)} characters"
    assert all(re.search(rf"^## {index}\. ", normalized, re.MULTILINE) for index in range(1, 9)), "Missing document sections"
    assert normalized.rstrip().endswith("DSH_MIXED_DOCUMENT_OK"), "Missing final marker"
    return {"kind": "document", "session": session, "characters": len(text), "words": len(text.split())}


def document(directory):
    session = "mixed-document-" + str(uuid.uuid4())
    prompt = (
        "Write a self-contained technical guide to FIFO resource admission in a browser service. "
        "Use exactly eight numbered sections, headed '## 1.' through '## 8.', covering leases, "
        "queue fairness, cancellation, adaptive capacity, memory observations, overload, "
        "observability, and graceful shutdown. Write 1800 to 2200 words total, with concrete "
        "examples. Do not invoke tools or create files. End with DSH_MIXED_DOCUMENT_OK."
    )
    request = urllib.request.Request(
        "http://127.0.0.1:17841/v1/responses",
        data=json.dumps({"model": "chatgpt-web/gpt-6-light", "stream": False,
                         "input": [{"role": "user", "content": prompt}]}).encode(),
        headers={"content-type": "application/json", "x-dsh-session-id": session,
                 "x-dsh-turn-id": "dsh-turn-1"})
    with urllib.request.urlopen(request, timeout=300) as response:
        result = json.load(response)
    (directory / "document.json").write_text(json.dumps(result, indent=2))
    (directory / "document-session.txt").write_text(session)
    return validate_document(result, session)


async def main():
    with urllib.request.urlopen(HEALTH, timeout=3) as response:
        health = json.load(response)
    assert health["accepting_turns"] and not health["active_http_turns"] and not health["active_browser_turns"]
    assert not health["browser_admission"]["pending"], "Other work is queued"
    directory = Path(tempfile.mkdtemp(prefix="dsh-mixed-load-"))
    print(json.dumps({"directory": str(directory)}), flush=True)
    done = asyncio.Event()
    rows = []

    async def sample():
        with (directory / "resources.jsonl").open("w") as output:
            while True:
                row = await asyncio.to_thread(resources.sample, HEALTH)
                rows.append(row)
                output.write(json.dumps(row) + "\n")
                output.flush()
                if done.is_set():
                    return
                try:
                    await asyncio.wait_for(done.wait(), timeout=2)
                except asyncio.TimeoutError:
                    pass

    async def chart():
        with (directory / "chart.log").open("wb") as output:
            process = await asyncio.create_subprocess_exec(
                "python3", str(SCRIPTS / "smoke-chatgpt-media.py"), "--kind", "chart",
                stdout=output, stderr=asyncio.subprocess.STDOUT)
        code = await process.wait()
        assert code == 0, f"Chart failed: {directory / 'chart.log'}"
        return json.loads((directory / "chart.log").read_text().splitlines()[-1])

    sampler = asyncio.create_task(sample())
    try:
        results = await asyncio.gather(asyncio.to_thread(document, directory), chart(), return_exceptions=True)
    finally:
        done.set()
        await sampler
    errors = [str(result) for result in results if isinstance(result, BaseException)]
    peak_active = max(row["active"] for row in rows)
    if peak_active != 2:
        errors.append(f"Expected two overlapping browser turns, observed peak {peak_active}")
    report = {"ok": not errors, "results": [result for result in results if not isinstance(result, BaseException)],
              "errors": errors, "samples": len(rows), "peakActive": peak_active,
              "peakPending": max(row["admission"]["pending"] for row in rows),
              "peakRssBytes": max(row["treeRssBytes"] for row in rows),
              "directory": str(directory)}
    (directory / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)
    assert not errors, errors


if __name__ == "__main__":
    asyncio.run(main())
