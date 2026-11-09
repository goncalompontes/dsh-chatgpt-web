# Browser reliability soak — 2026-11-09T13:08:43.080Z

Endpoint: `http://127.0.0.1:17851/v1` · model: `chatgpt-web/gpt-6-light` · turns: 10 · concurrency: 3

| Metric | Value |
| --- | ---: |
| Passed | 10 |
| Failed | 0 |
| Pass rate | 100.0% |
| p50 duration | 15372 ms |
| p95 duration | 24901 ms |
| Max duration | 24901 ms |
| Retries | 0 |

## Failure codes

None.

## Per-turn outcomes

| Turn | Status | HTTP | Code | Duration | Chars | Marker | Completed |
| ---: | --- | ---: | --- | ---: | ---: | --- | --- |
| 0 | passed | 200 |  | 7938 ms | 306 | yes | yes |
| 1 | passed | 200 |  | 15372 ms | 306 | yes | yes |
| 2 | passed | 200 |  | 24901 ms | 306 | yes | yes |
| 3 | passed | 200 |  | 22929 ms | 306 | yes | yes |
| 4 | passed | 200 |  | 21920 ms | 306 | yes | yes |
| 5 | passed | 200 |  | 12294 ms | 306 | yes | yes |
| 6 | passed | 200 |  | 13737 ms | 306 | yes | yes |
| 7 | passed | 200 |  | 7865 ms | 306 | yes | yes |
| 8 | passed | 200 |  | 15763 ms | 306 | yes | yes |
| 9 | passed | 200 |  | 7864 ms | 306 | yes | yes |

The soak sends no tool calls. It measures browser transport completion, not tool execution.
