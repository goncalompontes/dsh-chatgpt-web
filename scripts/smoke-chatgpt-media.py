#!/usr/bin/env python3
"""Explicit live ChatGPT file/image export check; writes only downloaded artifacts."""
import argparse
import json
from pathlib import Path
import re
import urllib.request
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--kind", choices=("csv", "image", "chart"), default="csv")
args = parser.parse_args()
session = "media-smoke-" + str(uuid.uuid4())
prompt = ("Use ChatGPT's native image-generation capability to create a simple square image: "
          "a blue circle centered on a white background, with no text. Return the generated image. "
          "This tests image transport; do not write code, use a shell, or substitute a text description."
          if args.kind == "image" else
          "Use ChatGPT's Python data-analysis sandbox to draw a 256 by 256 PNG with a solid blue circle "
          "centered on a white background. Display the actual PNG inline and provide its download link. "
          "This tests authenticated image transport; do not substitute source code or a text description."
          if args.kind == "chart" else
          "Create a downloadable CSV file named dsh-media-smoke.csv in ChatGPT's data-analysis sandbox. "
          "Its exact contents must be key,value followed by a newline, then smoke,DSH_MEDIA_OK followed by a newline. "
          "Return its download link. This checks the ChatGPT attachment transport; no DSH or local-shell tools are needed.")
payload = {"model": "chatgpt-web/gpt-6-light", "stream": False, "input": [{"role": "user", "content":
    prompt}]}
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
if args.kind == "csv":
    artifact = next(path for path in files if path.suffix == ".csv")
    assert artifact.read_text().replace("\r\n", "\n") == "key,value\nsmoke,DSH_MEDIA_OK\n", artifact
else:
    artifact = next(path for path in files if path.suffix in (".png", ".jpg", ".webp", ".gif", ".avif"))
    data = artifact.read_bytes()
    assert len(data) > 1024 and (data.startswith(b"\x89PNG\r\n\x1a\n") or data.startswith(b"\xff\xd8\xff")
        or data.startswith(b"RIFF") or data.startswith(b"GIF8") or data[4:8] == b"ftyp"), artifact
print(json.dumps({"ok": True, "kind": args.kind, "session": session, "artifact": str(artifact), "bytes": artifact.stat().st_size}))
