# Offline latency regression reporting — issue #4

This tool compares sanitized per-turn ACP timing rows without starting a browser or accessing credentials. It is report-only: a regression is informational, while invalid input returns exit code 2.

## Reproduce deterministic fixtures

```sh
node scripts/latency-regression.mjs --baseline tests/fixtures/latency-baseline.json --candidate tests/fixtures/latency-candidate.json --output /tmp/latency-report.json --markdown /tmp/latency-report.md
bun test tests/latency-regression.test.ts
```

JSON and Markdown reports are deterministic. The synthetic fresh median 10s to 14s is flagged; retained 5s to 5.1s is not. These fabricated fixture values are **not real browser timings**.

## Compare private live evidence

Run the existing live driver manually, separately for baseline and candidate, on comparable machines and load. Keep raw evidence private.

```sh
python3 scripts/measure-latency-matrix.py --runs 3 --output /tmp/private-empty-dir
node scripts/latency-regression.mjs --baseline /tmp/baseline/results.json --candidate /tmp/candidate/results.json --kind live-acp --output /tmp/comparison.json --markdown /tmp/comparison.md
```

Run with stable browser capacity, model, prompt shapes, retained page state and external traffic. Alternate run order and take repeated samples. The comparator groups by stage, case, model, fresh/retained and concurrency width, not run/batch. All output dimensions are allowlisted and raw session IDs, paths, logs, trace IDs and credentials are omitted. Output files use mode 0600. Never commit raw diagnostic files, browser sessions or tokens.

## Measurement semantics

| Metric | Definition and limitation |
| --- | --- |
| hostSetupSeconds | ACP client host preparation, **not** process startup or MCP initialization |
| toSendAcceptedSeconds | Client start to browser DOM send-accepted checkpoint, **not** server receipt |
| toFirstAnswerSeconds | Client start to first ACP agent_message_chunk, **not** model first token |
| totalSeconds | Client end-to-end turn elapsed |
| queueWaitSeconds | Only explicit per-turn values, absent in current matrix; aggregate batch queue totals cannot be attributed per turn |
| toolExecutionSeconds | ACP tool start to completed update, not upstream model routing |

Missing values are unavailable, never zero. The comparison uses median and counts; p95 is withheld for n < 20. Defaults flag increases exceeding **both** 20% and 0.5 seconds when both arms have at least 3 samples. Override via --relative, --absolute-seconds, --min-samples. Three samples are insufficient to establish a stable regression; noise, cold starts, queue pressure and model variance require much larger repeated runs. Results are advisory, not a significance test or CI timing gate.

Real historical browser measurements, separate from synthetic tests: [2026-11-08 latency matrix](model-latency-matrix-2026-11-08.md) and [startup study](model-startup-latency-2026-11-08.md). Their small-sample observations are not newly reproduced by this tool. CI tests parsing and report generation offline only; it cannot measure live model latency, network waits or internal token issuance.

## Risks

Model scheduling and upstream queueing are not observable. Retained browser memory, background workload and concurrent clients affect results. Report-only thresholds can yield false alarms or misses. Never interpret first answer chunk as the actual first token.
