#!/usr/bin/env python3
"""Render a latency-matrix summary.json as a self-contained HTML chart."""
import argparse
import html
import json
from pathlib import Path

CASES = [("read", "fresh", "Read tool · fresh conversation"),
         ("read", "retained", "Read tool · retained conversation"),
         ("answer", "fresh", "No-tool answer · short prompt"),
         ("long", "fresh", "No-tool answer · 30k-character context")]


def seconds(value):
    return f"{value:.1f}s" if value is not None else "—"


def row(group, scale):
    total = group["totalSeconds"]
    setup = group["toSendAcceptedSeconds"]
    if not total:
        return ""
    median = total["median"]
    prepared = setup["median"] if setup else 0
    wait = max(median - prepared, 0)
    return (f'<div class="row"><span class="kind">{html.escape(group["model"])}</span>'
            f'<div class="track" title="n={total["n"]} · setup {prepared:.1f}s · total range '
            f'{total["min"]:.1f}–{total["max"]:.1f}s">'
            f'<span class="setup" style="width:{prepared / scale * 100:.2f}%"></span>'
            f'<span class="wait" style="width:{wait / scale * 100:.2f}%"></span></div>'
            f'<strong>{median:.1f}s</strong></div>')


def table(groups):
    rows = "".join(
        f'<tr><td>{html.escape(g["model"])}</td><td>{g["totalSeconds"]["n"]}</td>'
        f'<td>{seconds((g["toSendAcceptedSeconds"] or {}).get("median"))}</td>'
        f'<td>{seconds(g["totalSeconds"]["median"] - (g["toSendAcceptedSeconds"] or {"median": 0})["median"])}</td>'
        f'<td>{seconds(g["totalSeconds"]["median"])}</td>'
        f'<td>{seconds(g["totalSeconds"]["min"])}–{seconds(g["totalSeconds"]["max"])}</td></tr>'
        for g in groups)
    return ("<table><tr><th>Model</th><th>n</th><th>Setup</th><th>Post-submit</th>"
            f"<th>Median total</th><th>Range</th></tr>{rows}</table>")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--html", required=True)
    parser.add_argument("--title", default="DeepSeek Harness ACP latency matrix")
    args = parser.parse_args()
    summary = json.loads(Path(args.summary).read_text())
    groups = [g for g in summary["groups"] if g["stage"] == "serial" and g["width"] == 1 and g["totalSeconds"]]

    sections = []
    for case, turn, title in CASES:
        selected = sorted((g for g in groups if g["case"] == case and g["turn"] == turn),
                          key=lambda g: g["totalSeconds"]["median"])
        if not selected:
            continue
        scale = max(g["totalSeconds"]["median"] for g in selected) or 1
        sections.append(f'<section><div class="model">{title}</div>'
                        + "".join(row(g, scale) for g in selected)
                        + f'<div class="axis"><span>0s</span><span>{scale / 2:.1f}s</span>'
                          f'<span>{scale:.1f}s</span></div>{table(selected)}</section>')

    concurrency = summary.get("concurrency") or []
    conc = ""
    if concurrency:
        rows = []
        for item in concurrency:
            if item["medianTurnSeconds"] is None:
                continue
            rows.append(f'<tr><td>{item["width"]}</td><td>{item["batch"]}</td><td>{item["turns"]}</td>'
                        f'<td>{seconds(item["wallSeconds"])}</td><td>{seconds(item["medianTurnSeconds"])}</td>'
                        f'<td>{item["turnsPerMinute"]}</td><td>{item["queueWaitDeltaMs"]}</td></tr>')
        conc = ("<section><div class=\"model\">Concurrent turns (read, fresh)</div>"
                "<table><tr><th>Width</th><th>Batch</th><th>Turns</th><th>Wall</th>"
                "<th>Median turn</th><th>Turns/min</th><th>Queue wait Δ ms</th></tr>"
                + "".join(rows) + "</table></section>")

    baseline = summary.get("baselineExternalTurns")
    aborted = summary.get("aborted")
    note = (f"<p>External turns present during the run: {baseline}. "
            f"Aborted: {html.escape(str(aborted)) if aborted else 'no'}. "
            f"{summary.get('turnCount')} measured turns across {summary.get('jobCount')} jobs. "
            "Small samples describe this run; model rankings and tail latency remain uncertain.</p>")

    document = f"""<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
:root{{font-family:var(--font-sans,system-ui);color:var(--foreground)}}body{{margin:16px;max-width:900px}}
p{{font-size:13px;line-height:1.5;color:var(--muted-foreground)}}
.legend{{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;margin:12px 0}}
.key{{display:inline-block;width:10px;height:10px;margin-right:6px}}
.setup{{background:var(--chart-1)}}.wait{{background:var(--chart-2)}}
section{{margin:18px 0}}.model{{font-size:13px;font-weight:600;margin-bottom:6px}}
.row{{display:grid;grid-template-columns:110px minmax(0,1fr) 52px;gap:8px;align-items:center;height:23px}}
.kind{{font-size:11px;color:var(--muted-foreground)}}
.track{{display:flex;height:14px;background:var(--secondary);border-radius:3px;overflow:hidden}}
.track span{{height:14px}}strong{{font-size:12px;font-variant-numeric:tabular-nums}}
.axis{{display:flex;justify-content:space-between;font-size:10px;color:var(--muted-foreground);margin:2px 60px 8px 118px}}
table{{width:100%;border-collapse:collapse;font-size:11px;margin-top:6px}}
td,th{{text-align:left;padding:4px;border-bottom:1px solid var(--border)}}
</style><body><h2>{html.escape(args.title)}</h2>
<p>Median seconds from ACP message submission to the completed turn, split into local preparation/submission
and the wait after the browser accepted the prompt. Bars are medians; hover for sample count and range.</p>
<div class="legend"><span><i class="key setup"></i>Preparation and submission</span>
<span><i class="key wait"></i>Post-submission wait and answer</span></div>
{''.join(sections)}{conc}{note}</body></html>"""
    Path(args.html).write_text(document)
    print(f"Wrote {args.html}")


if __name__ == "__main__":
    main()
