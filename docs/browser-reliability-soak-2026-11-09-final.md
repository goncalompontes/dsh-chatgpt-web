# Browser reliability soak — 2026-11-09T13:13:41.731Z

Endpoint: `http://127.0.0.1:17852/v1` · model: `chatgpt-web/gpt-6-light` · turns: 6 · concurrency: 2

| Metric | Value |
| --- | ---: |
| Passed | 6 |
| Failed | 0 |
| Pass rate | 100.0% |
| p50 duration | 11251 ms |
| p95 duration | 14873 ms |
| Max duration | 14873 ms |
| Retries | 0 |

## Failure codes

None.

## Per-turn outcomes

| Turn | Status | HTTP | Code | Duration | Chars | Marker | Completed |
| ---: | --- | ---: | --- | ---: | ---: | --- | --- |
| 0 | passed | 200 |  | 7617 ms | 306 | yes | yes |
| 1 | passed | 200 |  | 14873 ms | 306 | yes | yes |
| 2 | passed | 200 |  | 13200 ms | 306 | yes | yes |
| 3 | passed | 200 |  | 11251 ms | 306 | yes | yes |
| 4 | passed | 200 |  | 6223 ms | 306 | yes | yes |
| 5 | passed | 200 |  | 6299 ms | 306 | yes | yes |

The soak sends no tool calls. It measures browser transport completion, not tool execution.
