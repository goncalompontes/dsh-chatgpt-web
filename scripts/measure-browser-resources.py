#!/usr/bin/env python3
"""Read-only Linux sidecar descendant RSS sampling during explicit live checks.

RSS double-counts shared pages; this intentionally gives a conservative process-tree
observation, not a measurement of incremental per-turn memory or a safe capacity limit.
"""
import argparse
import json
import os
from pathlib import Path
import time
import urllib.request


def sample(url):
    with urllib.request.urlopen(url, timeout=3) as response:
        health = json.load(response)
    processes = {}
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            processes[int(path.name)] = (int(fields[1]), int(fields[21]) * os.sysconf('SC_PAGE_SIZE'))
        except (OSError, ValueError, IndexError):
            continue
    descendants = {health['pid']}
    while True:
        expanded = descendants | {pid for pid, (parent, _) in processes.items() if parent in descendants}
        if expanded == descendants:
            break
        descendants = expanded
    return {'time': time.time(), 'pid': health['pid'],
            'active': health['active_browser_turns'], 'admission': health.get('browser_admission'),
            'processes': len(descendants),
            'treeRssBytes': sum(processes.get(pid, (0, 0))[1] for pid in descendants)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:17841/healthz')
    parser.add_argument('--samples', type=int, default=30)
    parser.add_argument('--interval', type=float, default=2)
    args = parser.parse_args()
    if args.samples < 1 or args.interval <= 0:
        parser.error('samples and interval must be positive')
    for index in range(args.samples):
        print(json.dumps(sample(args.url)), flush=True)
        if index + 1 < args.samples:
            time.sleep(args.interval)
