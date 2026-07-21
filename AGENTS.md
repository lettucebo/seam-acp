# Agent Instructions for seam-acp

This file contains instructions for AI agents (Copilot, Claude, Gemini, etc.) working inside this repository via Discord.

## What this project is

`seam-acp` is the Discord bot you are currently running inside. It bridges Discord messages to AI agent CLIs via the Agent Client Protocol (ACP). You are likely talking to yourself.

## Output formatting

Your output is streamed to Discord, which does **not** support markdown tables. Avoid using tables in your responses — they render as garbled text. Use bullet lists, bold labels, or plain text instead.

## ⚠️ CRITICAL: Applying code changes or restarting the app

The bot runs 24/7 under a **Windows Task Scheduler logon task** (`seam-acp-bot`)
whose launcher `run-bot.ps1` keeps `node dist/index.js` running and relaunches it
on any exit (crash or clean). There is **no PM2**.

**Never kill the bot process, `Stop-ScheduledTask`, or run `npm start` to restart.**
Killing the node process directly drops the in-flight turn (your reply is never
delivered), and starting a second `npm start` collides on the health port.

**Always use:**

```bash
npm run redeploy
```

This is the only safe way to apply code changes or restart the bot. It:
1. Compiles the TypeScript (`npm run build`)
2. Writes a restart sentinel (`data/.restart-pending`) and echoes a confirmation
3. The running bot detects the sentinel, drains active turns, then **exits
   gracefully** — and the `run-bot.ps1` supervisor loop relaunches it with the new
   code a few seconds later.

If you are asked to apply code changes / restart / rebuild → run `npm run redeploy`.

**Never** run `Stop-Process` on the bot, `Stop-ScheduledTask seam-acp-bot`, `npm start`,
or any other direct restart. Also **never** kill processes by the name `copilot`
(`Stop-Process -Name copilot` / `taskkill /IM copilot.exe`) — that would terminate
the very Copilot CLI running this agent. The bot's copilot children exit on their
own when its stdin closes.

## Useful commands (read-only / safe)

```powershell
Get-ScheduledTask -TaskName seam-acp-bot            # task state
Get-Content .\data\bot.log -Tail 100                # recent logs
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*dist*index.js*'  # is it running
curl http://localhost:3000/health                   # health probe
```

To stop for good (rare): run `.\stop-bot.ps1` (disables the task + stops the node).

## Project structure

- `src/` — TypeScript source
- `dist/` — compiled output (do not edit directly)
- `src/config.ts` — all env var definitions and validation (Zod)
- `src/platforms/discord/` — Discord adapter, orchestrator, and slash commands
- `src/agents/` — agent profile definitions (Copilot, Gemini, Claude)
- `src/core/` — session store, streaming, routing
- `data/` — SQLite database (runtime, not committed)
- `.env` — local environment config (not committed)

## Environment variables

Key variables are defined and validated in `src/config.ts`. Notable ones:

- `DISCORD_ALLOWED_USER_IDS` — comma-separated Discord user IDs allowed to use the bot
- `DISCORD_ALLOWED_CHANNEL_IDS` — optional; restrict the bot to threads in specific parent channels
- `REPOS_ROOT` — root directory the agent can access
- `DEFAULT_AGENT` — which agent profile to use by default (`copilot`, `gemini`, `claude`)

After changing `.env`, run `npm run redeploy` to rebuild and restart.

## ⚠️ CRITICAL: Claude model & effort selection is a minefield

The `claude-agent-acp` wrapper resolves model strings **inconsistently and
silently wrong** (e.g. the alias `opus[1m]` resolves to *Sonnet*; the full ID
`claude-sonnet-4-6[1m]` silently gives a 200K window). Months of work once ran
on the wrong model because of this. **Do not trust model aliases, labels, or a
model's self-report.** Before changing anything about Claude models or effort:

**READ `docs/model-management-runbook.md` first.** It is the authoritative,
empirical process. Key non-negotiables from it:

- **Verify against JSONL ground truth** (`entry.message.model`), never by asking
  the model what it is — self-reports are unreliable.
- **No local patch as of claude-agent-acp 0.54.1** (ACP SDK 1.1.0): model
  selection moved to `setSessionConfigOption`, which exact-matches full canonical
  `claude-*` IDs against the agent's advertised list *before* the fuzzy resolver,
  so full IDs resolve to themselves. `scripts/patch-claude-agent-acp.mjs` is
  retired (its anchor `unstable_setSessionModel` no longer exists). **Caveat on
  this account**: the SDK advertises only `default/sonnet/haiku`, so an
  un-advertised full ID can be *rejected* (`Invalid value for config option
  model`) — `default` → latest Opus is the proven path; explicit
  Opus/Fable/Sonnet-5 entries are pending live validation.
- **The `CLAUDE_MODELS` picker in `.env`** contains only JSONL-verified entries.
  Don't add a model without running the §4 probe in the runbook.
- **No `[1m]` suffix** — each model's native context window is declared in the
  `CLAUDE_CONTEXT_WINDOWS` table (`src/agents/profiles/claude.ts`), which drives
  the compaction threshold; the agent also reports the true window at runtime via
  ACP `UsageUpdate.size`. (Getting the window wrong makes a 1M model compact at 200K.)
- **Effort** is injected via `_meta.claudeCode.options.effort` (runbook §11),
  NOT `set_config_option` (which errors). Valid levels are bounded by the
  bundled SDK's `EffortLevel` type (`ultra` is not available).
- The status card shows the **resolved** model + effort every turn — that is the
  standing regression alarm. If it ever shows the wrong model, stop and consult
  the runbook.

When updating `claude-agent-acp` or `@anthropic-ai/claude-code`, follow the
runbook end to end (§1 pull → §2 changelogs → §3 update → §3a patch → §4 verify).

## Troubleshooting: 500 / server errors from the Claude API

When a Claude Code session returns persistent `500 Internal server error`
responses (visible in `data/bot.log` as `"turn failed"` with
`"errorKind":"server_error"`), **check https://status.claude.com first** before
investigating code-level causes. The error message itself directs you there.

Signs it's an upstream outage rather than a bot bug:
- Multiple threads/sessions fail around the same time.
- Other threads on the same model work fine (outages can be partial / per-model).
- The status page shows an active incident (look for `status-major` or
  `status-critical` on the page body, or unresolved incidents tagged
  `impact-critical`).
- Retries keep failing with the same 500, not a different error.

**Do not** waste time debugging seam-acp code or session state when the root
cause is an Anthropic-side outage. Wait for the incident to resolve, then retry.
