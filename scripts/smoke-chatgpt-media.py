#!/usr/bin/env python3
"""Explicit live ChatGPT sandbox CSV export check; writes only its downloaded artifact."""
import json
from pathlib import Path
import re
import urllib.request
import uuid

session = "media-smoke-" + str(uuid.uuid4())
payload = {"model": "chatgpt-web/gpt-6-light", "stream": False, "input": [{"role": "user", "content":
    "Create a downloadable CSV file named dsh-media-smoke.csv in ChatGPT's data-analysis sandbox. "
    "Its exact contents must be key,value followed by a newline, then smoke,DSH_MEDIA_OK followed by a newline. "
    "Return its download link. This checks the ChatGPT attachment transport; no DSH or local-shell tools are needed."}]}
request = urllib.request.Request("http://127.0.0.1:17841/v1/responses", data=json.dumps(payload).encode(),
    headers={"content-type": "application/json", "x-dsh-session-id": session, "x-dsh-turn-id": "dsh-turn-1"})
with urllib.request.urlopen(request, timeout=240) as response:
    result = json.load(response)
text = "".join(part.get("text", "") for item in result.get("output", []) if item.get("type") == "message"
               for part in item.get("content", []))
directory = (Path.home() / ".dsh/storages/chatgpt-web/artifacts").resolve()
files = [Path(path) for path in re.findall(r"\]\(<([^>]+)>\)", text)
         if Path(path).is_absolute() and directory in Path(path).resolve().parents]
assert files, json.dumps({"status": result.get("status"), "error": result.get("error"),
                          "outputTypes": [item.get("type") for item in result.get("output", [])], "text": text})
csv = next(path for path in files if path.suffix == ".csv")
assert csv.read_text().replace("\r\n", "\n") == "key,value\nsmoke,DSH_MEDIA_OK\n", csv
print(json.dumps({"ok": True, "session": session, "artifact": str(csv), "bytes": csv.stat().st_size}))
