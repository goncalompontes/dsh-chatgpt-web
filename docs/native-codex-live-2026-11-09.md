# Native Codex route and browser fallback — live check 2026-11-09

Scope: local verification of the flagged native Responses route and the browser fallback. A temporary
sidecar used the source checkout on `127.0.0.1:17851` with a copy of the authenticated ChatGPT Web
config (`purpose: "dsh"`, `mode: "browser-only"`). The production sidecar on `17841` was not restarted
or modified. No access token, refresh token, prompt content, or session capability is recorded here.

## Native route

Flags:

```sh
DSH_CHATGPT_WEB_HOME=<temp> \
DSH_CHATGPT_NATIVE_CODEX=1 \
DSH_CHATGPT_NATIVE_CODEX_FALLBACK=0 \
  bun src/cli.ts serve
```

Request: `model: "gpt-6.1-sol"`, `stream: true`, one short user message. The route read the Codex
ChatGPT credential, injected `Authorization` / `ChatGPT-Account-ID` / `originator: codex_cli_rs`, and
forwarded to `https://chatgpt.com/backend-api/codex/responses`.

Observed stream:

- `response.created` and `response.in_progress` for `model: "gpt-6.1-sol"`;
- `response.output_text.delta` chunks `N`, `ATIVE`, `_OK`;
- `response.output_text.done` with `NATIVE_OK`;
- `response.completed`.

Sidecar log:

```text
[chatgpt-web] native_codex model=gpt-6.1-sol status=200
```

No browser page or browser turn was created.

### Protocol correction found during the live check

The first request was rejected by the Codex backend with:

```json
{"detail":"Store must be set to false"}
```

The native forwarding path now forces `store: false` and strips platform-API-only fields
(`max_output_tokens`, `temperature`, `top_p`, `background`, `conversation`, `metadata`, `moderation`,
`prompt`) before forwarding. The retest above passed.

## Browser fallback

Flags: `DSH_CHATGPT_NATIVE_CODEX=1`, native auth path deliberately missing, fallback enabled.

Request: the same native model slug `gpt-6.1-sol`.

Sidecar log:

```text
[chatgpt-web] native_codex_fallback model=gpt-6.1-sol fallback=chatgpt-web/high reason=native_codex_auth_missing
[chatgpt-web] browser turn f2ef0339af3e stage=browser_page completed durationMs=233
[chatgpt-web] browser turn f2ef0339af3e completed (markdownChars=12, domFullScans=5, domCacheHits=5)
```

Observed stream: the browser route selected `chatgpt-web/high`, streamed the Pure Chat Mode
commentary, then `FALLBACK\_OK`, and completed with `model: "chatgpt-web/high"`. The credential
failure did not surface as a user-visible turn error.

## Per-turn soak

Command:

```sh
bun scripts/soak-browser-reliability.ts \
  --url http://127.0.0.1:17851/v1 \
  --turns 10 --concurrency 3 \
  --model chatgpt-web/gpt-6-light \
  --timeout-ms 240000 \
  --output docs/browser-reliability-soak-2026-11-09.json
```

Result:

| Metric | Value |
| --- | ---: |
| Passed | 10 / 10 |
| Pass rate | 100% |
| p50 | 15,372 ms |
| p95 | 24,901 ms |
| Max | 24,901 ms |
| Retries | 0 |
| Failure codes | none |

Network observation was active for every turn: `network_stream complete` appeared 10 times and
all 10 had non-zero text. The DOM projection and the stream text differed only by Markdown escaping
(`SOAK\_0` vs `SOAK_0`), so the DOM answer remained the streamed projection and the network text was
available as the corroborating/recovery source. The soak sends no tool calls; it measures browser
transport completion, not tool execution.

Evidence files:

- `docs/browser-reliability-soak-2026-11-09.json`
- `docs/browser-reliability-soak-2026-11-09.md`

## Limits

- The Codex endpoint is a Codex CLI interoperability path, not a documented third-party API. The
  route is off by default and intended for the user's own ChatGPT subscription.
- One machine, one ChatGPT account, one short prompt shape. This does not establish behavior under
  account rate limits, long tool loops, or concurrent accounts.
- The soak covers the browser transport only. Native tool round trips have unit coverage but were
  not run as a live multi-tool DSH session in this check.
- The temporary sidecar and its Chrome instances were isolated from the production service; no
  production bundle or service was restarted.
