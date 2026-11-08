# Compact integration handoff

Updated 2026-11-06. Preserve all existing uncommitted source and generated bundles.

- Plugin: `/home/pontes/projects/dsh-chatgpt-web`; DSH 0.2.2-rc.1, dsh-tui 0.19.0.
- Active transport: ChatGPT Temporary Chat → local-shell-dsh connector → local-shell gateway → plugin stdio MCP → Unix turn broker → Responses adapter → DSH tools.
- Keep external MCP mode. No OpenAI tunnel is required. Use `~/local-shell-mcp/start-funnel.sh`, never `start.sh`, for the stable Funnel URL.
- Storage: `~/.dsh/storages/chatgpt-web`; broker: `runtime/turn-broker.sock`; persistent sidecar log: `logs/sidecar.log`. Exactly one sidecar should own the broker socket.
- Existing fixes cover SSE close/cancel races, stable metadata-free turn identity, tool-result ID matching, abandoned broker calls, connector approvals, DOM rebinding/cache lifetime, and gateway deadlines.
- Prior live validation covered two sequential calls, a ten-call calculator task, a 65-second command, resumed sessions, identical repeated instructions, and a post-reboot two-call smoke. See [validation evidence](external-mcp-validation.md).
- Post-reboot diagnosis: saved ChatGPT login remained valid; temporary session-check failures had been mislabeled as invalid credentials, and the gateway had not restarted. Session checks now retry and distinguish expired login from temporary failures. A persistent user gateway unit was enabled; DSH still owns normal sidecar startup.
- Latest verification: 50 tests, typecheck, and build passed. The Instant six-operation cwd/AGENTS.md regression completed with one stable identity and all gateway calls under 2.5 seconds. Late user hydration and bounded running-task DOM grace have regression coverage. A live formatting probe reproduced table-number/code-whitespace loss, now fixed; the final two-call full-pipeline smoke preserved numeric table rows and multiline fenced output.
- Reversible debugging should use headless DSH with `chatgpt-web/gpt-6-light` (Instant). Preserve the user's main TUI. Repo and installed bundles were hard linked at the last check.
- Build: `bun run build`; typecheck: `./node_modules/.bin/tsc --noEmit`; regression tests: `bun test`.

The product review is complete: see [integration opportunities](integration-opportunities.md). The user's latest TUI failure was diagnosed, patched, and verified headlessly: [turn-error evidence and verification status](tui-turn-error-2026-11-06.md). DSH-injected workspace context now preserves the inferred human turn identity, and assistant rebinding verifies late user hydration against the submitted prompt while retaining competing-message guards. The sidecar was restarted after a laptop reboot. Authenticated local/public MCP initialization and tool listing pass, as does the six-operation directory/instructions regression. Modern tables, numeric answers, and code source whitespace now survive response conversion.
