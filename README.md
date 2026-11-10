# dsh-chatgpt-web

[English](./README.md) | [中文](./README.zh-CN.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/@wlv-zedd/dsh-chatgpt-web.svg?style=flat)](https://www.npmjs.com/package/@wlv-zedd/dsh-chatgpt-web)
[![tarball smoke](https://img.shields.io/github/actions/workflow/status/WLV-ZEDD/dsh-chatgpt-web/tarball-smoke.yml?style=flat&label=tarball%20smoke)](https://github.com/WLV-ZEDD/dsh-chatgpt-web/actions/workflows/tarball-smoke.yml)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-Cordis%20Plugin-0078d4?style=flat)](https://github.com/deepseek-ai/deepseek-harness)
[![Mode](https://img.shields.io/badge/Mode-Pure%20Chat%20%26%20Markdown-success?style=flat)](./README.md#overview)

> **Zero-cost conversational AI model provider for DeepSeek Harness powered by free ChatGPT Web (GPT-6 Luna).**

<p align="center">
  <img src="./assets/hero-demo.png" alt="dsh-chatgpt-web in DeepSeek Harness" width="100%">
</p>

<p align="center">
  <img src="./assets/demo.gif" alt="dsh-chatgpt-web Interactive Demo" width="100%">
</p>

---

## Table of Contents

- [Overview](#overview)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Diagnostics & Health Check](#diagnostics--health-check)
- [Troubleshooting](#troubleshooting)
- [Notes & Limitations](#notes--limitations)
- [Related Documentation](#related-documentation)

---

## Overview

**dsh-chatgpt-web** turns your local browser session of ChatGPT into a seamless, **$0.00 API-free conversational model provider** directly inside DeepSeek Harness (DSH).

It connects via headless or visible Chrome/Chromium browser automation to `chatgpt.com`, streaming real-time Markdown responses, code solutions, explanations, and reasoning back to your DSH chats without consuming API credits.

### Why Pure Chat?

Small conversational web models (like GPT-6 Luna) excel at explanations, dialogue, Q&A, brainstorming, code snippet generation, and side-assistant tasks. By running in **Pure Chat Mode**, the bridge eliminates prompt overhead, tool hallucinations, and syntax errors of autonomous multi-tool execution loops, providing a fast, rock-solid, zero-cost LLM provider.

### Key Features

- **100% Free ($0.00 Cost):** Uses your existing free ChatGPT Web session. No OpenAI API keys or credit cards needed.
- **Cordis Plugin-First Lifecycle:** Managed by DSH via `ctx.effect`. DeepSeek Harness starts the background sidecar automatically on launch and shuts it down on exit.
- **Dynamic Model Auto-Detection:** Automatically detects your ChatGPT tier:
  - **Free Accounts:** Defaults to `chatgpt-web/luna` (`gpt-5-6-luna`) and `chatgpt-web/think`.
  - **Plus / Team Accounts:** Automatically detects and exposes **GPT-6** (`chatgpt-web/gpt-6-light`, `medium`, `high`) and **GPT-5.6 Sol** (`chatgpt-web/light`, `medium`, `high`), plus Pro tiers when available.
- **Full Streaming Markdown & Code Blocks:** Delivers tokens in real time directly to the DSH Web UI or CLI.
- **Portable, Validated Artifacts:** The published tarball is validated by CI (clean install, runtime smoke test, dependency resolution, no build-environment path contamination) before it can reach the registries.

---

## Requirements

- **Runtime:** Node.js `>=22.19.0` **or** Bun `>=1.3.0` (both are supported; the CLI runs on either).
- **DeepSeek Harness:** `>=0.2.0-rc.2`.
- **Browser:** Chrome or Chromium on your machine (used for the one-time sign-in and for serving).

### Automatic turn concurrency

On Linux (including WSL2), the provider samples host memory/CPU pressure and its
own browser process tree every 10 seconds while work is active or queued. After
a 20-second warm-up at a stable number of active turns, it learns incremental
RAM and CPU costs per turn, adds 25% headroom, and retains recent workload peaks.
Idle retained pages remain part of the memory baseline, rather than being counted
as free capacity. When turns finish, their retained pages are excluded from learning
the cost of the remaining turns.

Capacity starts at one, rises by one after three healthy samples and at least
30 seconds between increases, and drops immediately when pressure increases.
Running turns finish normally; additional turns wait in a FIFO queue (up to 256).
The policy reserves 4 GiB of memory and 25% of CPU capacity for other work. Until
measurements are available, each turn is budgeted at 3 GiB and one CPU core.

The default ceiling is **32 simultaneous browser turns**, replacing the previous
five-turn limit. This is a ceiling, not a target: actual concurrency depends on
observed resources. Set `DSH_CHATGPT_WEB_MAX_TURNS` to an integer from 1 to 128 in
the sidecar's launch environment to override it, then restart the sidecar when
idle. The same ceiling applies to admission and physical browser workers.
Unavailable host metrics reduce admission to one. `/healthz` exposes current
capacity, queue depth, maximum capacity, and the last resource measurements under
`browser_admission`.

Each turn runs in its own tab of one shared Chrome, so tabs can run in parallel
when the host can afford them. On a memory-tight host the conservative estimate
can be one tab even though the machine is busy. Set
`DSH_CHATGPT_WEB_MIN_TURNS` (1..`DSH_CHATGPT_WEB_MAX_TURNS`) to keep at least that
many tabs regardless of the estimate; this is an explicit memory-safety trade-off.
A turn that waits longer than 10 minutes for a tab fails with a retryable
`chatgpt_admission_timeout` instead of hanging; tune that with
`DSH_CHATGPT_WEB_MAX_QUEUE_WAIT_MS`. Abandoned or cancelled turns release their tab
after a short grace period, and tool-result continuations join their suspended
turn even if the client rewrote its turn identity.

### Hot reload

The sidecar watches `config.json` (and handles `SIGHUP`) and applies every safe
change to the running process. New turns use the new settings immediately;
browser workers built from the previous config are retired as soon as no turn is
active, so retained tabs are not lost mid-turn. An invalid or half-written file is
ignored and the previous config keeps serving; the error appears in
`/healthz` under `hot_reload`. Listener and broker-topology fields (`host`, `port`, `mode`, `purpose`,
`brokerSocketPath`) cannot be rebound in place: they are reported as deferred and
take effect on the next process start.

Manual reloads:

```bash
dsh-chatgpt-web reload            # re-read config from disk now
dsh-chatgpt-web reload --code     # drain, then restart to load newly built lib/
curl -X POST -H "authorization: Bearer $TOKEN" localhost:17841/v1/control/reload
```

Built-code watching is enabled by default under the DSH web-stack supervisor and
can be disabled with `DSH_CHATGPT_WEB_WATCH_CODE=0`. A `bun run build` triggers a
drain-then-restart that waits for an idle gap, so in-flight turns finish first.
`dsh-chatgpt-web reload --code --timeout 0` restarts immediately when you accept
interrupting active turns.

---

## Quick Start

### 1. Installation

Install the plugin directly from this GitHub repository:

```bash
# Via npm registry (recommended):
dsh plugin --profile <profile> add @wlv-zedd/dsh-chatgpt-web

# Or directly from GitHub:
dsh plugin --profile <profile> add github:WLV-ZEDD/dsh-chatgpt-web
```

This registers the plugin in the profile's `package.json` bundles, so its Cordis entries are composed automatically — no manual `insert` is needed.

Install it in every profile that uses this provider. For T3's DSH ACP integration, use `--profile acp`; installing only in `dsh-tui` does not load the plugin in ACP. The plugin passes DSH session identity and request purpose to the sidecar, allowing persistent chat reuse and text checkpoint recovery. Restart the relevant DSH client after changing its profile; existing sessions can still recover through compatibility handling for the native DSH compaction request.

### 2. One-Time Browser Sign-In

Authenticate your ChatGPT account once. The plugin binary lives in the profile's `node_modules/.bin`:

```bash
~/.dsh/profiles/<profile>/node_modules/.bin/dsh-chatgpt-web setup --dsh
```

A dedicated Chrome/Chromium window will open. Log into your OpenAI / ChatGPT account. Once the composer is visible and the ChatGPT session is authenticated, setup captures the session and writes the config and browser state to the plugin's storage directory (default `~/.dsh/storages/chatgpt-web/`). A guest composer alone is not treated as a successful login.

`--dsh` leaves Codex configuration and OS services untouched; DSH owns the sidecar lifecycle. Existing Codex or DEV storage cannot be repurposed by this command: use a separate `DSH_CHATGPT_WEB_HOME` if needed. Before rerunning setup, stop or disable the sidecar so its port is free. Without `--dsh`, the legacy Codex setup path remains unchanged.

If your browser is not at the default path, pass it explicitly:

```bash
~/.dsh/profiles/<profile>/node_modules/.bin/dsh-chatgpt-web setup --dsh --chrome /path/to/chrome
```

#### Using a snap-confined browser (e.g. snap Chromium)

Snap-confined browsers can only write to **non-hidden** paths in `$HOME`. The plugin's default storage directory (`~/.dsh/storages/chatgpt-web/`) is hidden, so a snap browser cannot create its profile lock there and setup fails with:

```text
Failed to create .../login-profile-XXXX/SingletonLock: Permission denied (13)
```

The fix is to point the plugin's storage home at a **non-hidden** directory using the `DSH_CHATGPT_WEB_HOME` environment variable.

**How the variable works:** `VAR=value command` is standard shell syntax — it sets the environment variable *only for that one command* and does not persist it. The plugin reads `DSH_CHATGPT_WEB_HOME` on startup; when set, every file it owns (config, browser profile, storage state) lives under that directory instead of `~/.dsh/storages/chatgpt-web/`.

**Step by step:**

1. **Run the one-time setup with the variable applied to the command:**

   ```bash
   DSH_CHATGPT_WEB_HOME="$HOME/dsh-chatgpt-web" \
     ~/.dsh/profiles/<profile>/node_modules/.bin/dsh-chatgpt-web setup --dsh --chrome /snap/bin/chromium
   ```

   The browser window opens; log in to ChatGPT. The session is saved under `~/dsh-chatgpt-web/`.

2. **Persist the variable for the shell that starts DSH.** The background sidecar is started by DeepSeek Harness and inherits DSH's environment — it does *not* inherit a one-off `VAR=value` prefix from your terminal. So export the variable in your shell (e.g. `~/.bashrc`), then start DSH from that shell:

   ```bash
   # add to ~/.bashrc (or ~/.zshrc):
   export DSH_CHATGPT_WEB_HOME="$HOME/dsh-chatgpt-web"

   # reload, then start DSH in that shell:
   source ~/.bashrc
   dsh --profile <profile> web
   ```

   The sidecar now finds the same `config.json` and browser state that setup created.

3. **Verify with the doctor** (run it in the same environment):

   ```bash
   ~/.dsh/profiles/<profile>/node_modules/.bin/dsh-chatgpt-web doctor
   ```

> **Important:** every command that touches the plugin state — `setup`, `login`, `doctor`, and the DSH process that runs the sidecar — must see the **same** `DSH_CHATGPT_WEB_HOME`. If some of them use the hidden default path and others use the non-hidden one, the sidecar will report `Configuration is missing`.

### 3. Enable in DeepSeek Harness

Provider configuration lives in the profile's Cordis patch layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`), not in a global settings file. Add the `chatgpt-web` provider under the existing `providers` map of the `llm-pi-ai` entry:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      # ...your existing providers...
      chatgpt-web:
        displayName: "ChatGPT Web (Free)"
        api: openai-responses
        baseURL: http://127.0.0.1:17841/v1
        headers:
          Authorization: "Bearer chatgpt-web-free"
        streamIdleTimeoutMs: 300000
        models:
          - id: chatgpt-web/luna
            name: "ChatGPT Web — Luna (Free)"
            contextWindow: 1050000
            maxTokens: 32768
            input:
              - text
              - image
```

Optionally, make it the agent's default model in the `agent-default-model` entry:

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: chatgpt-web
    model: chatgpt-web/luna
```

Now start DeepSeek Harness with the profile:

```bash
dsh --profile <profile> web
```

DSH will automatically start the background sidecar process, connect to your authenticated ChatGPT session, and accept prompts!

---

## Diagnostics & Health Check

Verify your setup at any time with the built-in diagnostic doctor:

```bash
~/.dsh/profiles/<profile>/node_modules/.bin/dsh-chatgpt-web doctor
```

Example healthy output:

```text
✓ Configuration is valid (~/.dsh/storages/chatgpt-web/config.json)
✓ Chrome executable found
✓ ChatGPT login state has authenticated browser evidence
✓ Responses proxy is healthy on 127.0.0.1:17841
Doctor result: ready
```

### Auditing MCP and tool calls

The companion Rust tool under [`audit/`](./audit/README.md) replaces the old
`~/local-shell-mcp/watch.sh` viewer. It inspects the live bridge, broker
traces and browser diagnostics, and records full tool arguments/results through
the bridge's native audit sink (the recording proxy is optional):

```bash
cd audit && cargo build --release

./target/release/dsh-audit            # interactive TUI
./target/release/dsh-audit inspect    # one-shot report
./target/release/dsh-audit doctor     # preflight checks
./target/release/dsh-audit proxy      # optional raw HTTP/SSE capture
```

See [`audit/README.md`](./audit/README.md) for capture setup, correlation,
privacy/redaction, keyboard shortcuts and export formats.

---

## Troubleshooting

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues: browser executable paths, snap confinement, missing configuration, and runtime (Node/Bun) notes.

---

## Notes & Limitations

1. **Unofficial Bridge:** Operates via local Playwright browser automation on `chatgpt.com`. Not affiliated with or endorsed by OpenAI.
2. **Single-Session Concurrency:** Runs within a single browser tab. Sequential queries and normal DSH agent chats work seamlessly; avoid launching parallel multi-subagent swarms against the same tab simultaneously.
3. **Pure Chat Only:** This provider generates pure conversational responses, explanations, reasoning, and code blocks. It does not execute local filesystem, terminal, or autonomous tool loops.
4. **Context and compaction:** ChatGPT Web keeps and compacts its own conversation, so the provider advertises the conversation capacity rather than the much smaller single-message browser ceiling. Completed chats are retained per session and follow-ups only send their new instruction. If a fresh replay still cannot fit one browser message, the bridge keeps the newest complete turns and continues in the retained chat instead of returning `context_length_exceeded`. Only an individual turn that is itself larger than one browser message (for example one enormous tool result) is rejected.
5. **Standard Free Tier Rate Limits:** Subject to standard OpenAI free-tier hourly usage limits.

---

## Related Documentation

- [CONTRIBUTING.md](./CONTRIBUTING.md) — development setup and contribution guidelines.
- [SECURITY.md](./SECURITY.md) — how the plugin handles your session credentials.
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — diagnosing setup and runtime problems.
- [LICENSE](./LICENSE) — MIT.
