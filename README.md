# seam-acp

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/seam-acp-logo-dark.svg">
  <img src="assets/seam-acp-logo-light.svg" alt="seam-acp" height="60">
</picture>

A bridge between chat platforms (Discord today, Slack tomorrow) and ACP-compatible coding agents (GitHub Copilot today, Claude Code / others tomorrow).

> **Status:** v0 — Discord + GitHub Copilot is the proven path. A Gemini ACP profile ships in the box; the multi-platform / multi-agent abstractions are designed in from day one.

## What it does

- Run a chat bot on a server / home lab / VM.
- From your phone (Discord), spin up a session per thread.
- Pick a repo with interactive buttons; chat with a coding agent in the thread.
- Switch model on the fly (interactive picker). Switch mode (Agent / Plan / Autopilot). Switch agent.

## Why ACP

The [Agent Client Protocol](https://agentclientprotocol.com) is the LSP-equivalent for coding agents. Picking ACP means:

- The agent integration is a typed protocol, not a vendor SDK.
- Switching to a different ACP-compatible agent is a config change, not a rewrite.
- We get streaming updates, mode switching, and live model switching as first-class features.

## Configure

Copy `.env.example` to `.env` and fill it in.

| Variable | Required | Notes |
|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | From the Discord developer portal |
| `DISCORD_ALLOWED_USER_IDS` | yes | Comma-separated Discord user IDs that can control the bot (e.g. `123,456`) |
| `DISCORD_ALLOWED_CHANNEL_IDS` | no | Comma-separated parent channel IDs the bot is allowed to operate in. When set, the bot only responds in threads whose parent channel is in this list. When unset, all channels are allowed. |
| `DISCORD_DEV_GUILD_ID` | no | Set to register slash commands instantly to one guild (good for dev) |
| `REPOS_ROOT` | yes | Root folder containing repos the agent can touch |
| `REPO_CLONE_HOST_POLICY` | no | `/seam repo clone` host policy: `github` (default — only github.com, safest), `public` (any external host over https/ssh; internal/loopback blocked), or `allowlist` |
| `REPO_CLONE_ALLOWED_HOSTS` | no | Comma-separated hostnames permitted when `REPO_CLONE_HOST_POLICY=allowlist` |
| `REPO_CLONE_TIMEOUT_MS` | no | Per clone/init timeout before the process tree is killed (default `300000`) |
| `ATTACH_ROOTS` | no | Comma-separated extra absolute directories the `/seam attach` command (and the agent-side fence-to-file shortcut) can read from. `REPOS_ROOT` is always allowed. |
| `DATA_DIR` | no | Defaults to `./data` (sqlite lives here) |
| `DEFAULT_AGENT` | no | `copilot` (default), `agy`, or `claude`. Plus any `copilot-<id>` / `agy-<id>` / `claude-<id>` registered via the `*_PROFILES` vars. |
| `DEFAULT_MODEL` | no | Default Copilot model. Applies to **all** Copilot profiles (including extras from `COPILOT_PROFILES`). e.g. `gpt-5.4`, `claude-sonnet-4.5`, `claude-opus-4.7`, `auto` |
| `COPILOT_CLI_PATH` | no | If `copilot` is not on `PATH` |
| `COPILOT_PROFILES` | no | Register additional Copilot profiles, each with its own auth / config dir. Format: `id1:/abs/dir1,id2:/abs/dir2`. Each becomes an agent profile named `copilot-<id>` in `/seam agent`. Lets one bot serve multiple GitHub accounts; see "Multiple Copilot accounts" below. |
| `AGY_CLI_PATH` | no | If `agy` is not on `PATH` (checks `~/.local/bin/agy` first) |
| `CLAUDE_CLI_PATH` | no | If `claude-agent-acp` is not on `PATH` |
| `CLAUDE_DEFAULT_MODEL` | no | Default Claude model — applied even when `DEFAULT_AGENT` is `copilot`. Default `claude-sonnet-4.5`. |
| `CLAUDE_PROFILES` | no | Same shape as `COPILOT_PROFILES`. Each entry registers a `claude-<id>` profile pinned to its own `CLAUDE_CONFIG_DIR`. See "Multiple Claude accounts" below. |
| `REMOTE_COPILOT_PROFILES` | no | Register Copilot profiles running on remote machines via WebSocket bridge. Two formats: `id:port:token` (server mode — seam-acp hosts WS server) or `id:wss://url:token` (client mode — seam-acp dials out). See [docs/remote-agent.md](docs/remote-agent.md). |
| `TURN_TIMEOUT_SECONDS` | no | Default 900 |
| `LOG_LEVEL` | no | `fatal` / `error` / `warn` / `info` / `debug` / `trace` |
| `HEALTH_PORT` | no | Default 3000 — exposes `GET /health` |
| `DEFAULT_PERMISSION_POLICY` | no | `ask` (recommended). Bot-wide default policy for new sessions. One of `always` (auto-approve), `ask` (prompt me on Discord), `deny` (auto-deny). Override per-session with `/seam approve`. |
| `DEFAULT_AUTO_APPROVE` | no | *Deprecated.* When `true`, forces the bot-wide default to `always`. Prefer `DEFAULT_PERMISSION_POLICY`. |

You also need the GitHub Copilot CLI installed locally (`brew install github/gh/copilot` or `npm i -g @github/copilot`) and authenticated (`copilot auth login`). The Docker image installs and runs the CLI for you, but you still need to mount auth state or sign in inside the container.

To use the **Anthropic Claude** profile, install the ACP adapter (and the underlying CLI for auth):

```sh
npm i -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp
claude /login
```

To use the **Google Antigravity (agy)** profile, install the Antigravity CLI binary from [github.com/google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli/releases) and run `agy /auth`. Each agent profile is independent — install only the ones you'll use.

## Run (local dev)

```sh
npm install
cp .env.example .env   # then edit
npm run dev
```

The bot starts, registers `/seam` slash commands (guild-scoped if `DISCORD_DEV_GUILD_ID` is set, global otherwise — global takes up to an hour to propagate), and exposes `GET /health` on `HEALTH_PORT`.

## Run (Docker)

```sh
docker compose up -d --build
```

Pass `--build-arg INSTALL_COPILOT_CLI=false` if you want to mount your own Copilot CLI binary.

## Run (PM2 — background process, no Docker)

PM2 keeps the bot running in the background, restarts it on crashes, and can auto-start it at login.

```sh
npm install -g pm2
npm run build
pm2 start ecosystem.config.cjs  # starts the bot as a background daemon
pm2 save                         # persist the process list
pm2 startup                      # prints a command — run it to enable auto-start at login
```

**After making code changes**, use the dedicated redeploy script instead of restarting PM2 directly. A direct `pm2 restart` would kill the bot mid-reply if an agent issued the command:

```sh
npm run redeploy   # builds, then restarts PM2 after a 3-second delay
```

Other useful commands:

```sh
pm2 status              # check if the bot is running
pm2 logs seam-acp       # tail live logs
pm2 stop seam-acp       # stop the bot
```

## Slash commands

All commands are restricted to users listed in `DISCORD_ALLOWED_USER_IDS` and (where it matters) thread-scoped.

| Command | What it does |
|---|---|
| `/seam new [name]` | Create a new public thread, bind a session to it, and post the repo picker — all in one step |
| `/seam init` | Bind the current thread as a session and post the repo picker |
| `/seam repo set <path>` | Set the working repo (type to search — autocomplete over `REPOS_ROOT`) |
| `/seam repo list` | List repos found under `REPOS_ROOT` (hidden directories are skipped) |
| `/seam repo clone <source> [name]` | Clone a remote repo (`owner/repo`, https, ssh, scp) into `REPOS_ROOT` and bind this thread to it. Host policy via `REPO_CLONE_HOST_POLICY` (default: github-only) |
| `/seam repo new <name>` | Create a new empty git repo under `REPOS_ROOT` and bind this thread to it |
| `/seam agent [id]` | With no id: posts an interactive picker of registered profiles. With id: switch directly. |
| `/seam model [id]` | With no id: starts the agent if needed and posts a picker of advertised models. With id: set directly (live if a runtime is active). |
| `/seam mode <id>` | Set the agent operational mode (e.g. plan / agent / autopilot) |
| `/seam effort <low\|medium\|high>` | Set reasoning effort (model-dependent) |
| `/seam tools <allow\|exclude> [csv]` | Tool allow / exclude list (empty list = clear) |
| `/seam approve <always\|ask\|deny>` | Permission policy for this thread. `always` auto-approves every request; `ask` posts a Discord prompt with buttons (auto-denies after 5 min); `deny` auto-denies. |
| `/seam abort` | Cancel the in-flight turn |
| `/seam reset` | End the current ACP session for this thread; next message starts a fresh one |
| `/seam config` | Show the session config JSON |
| `/seam config-set <json>` | Replace the session config wholesale |
| `/seam sessions` | List recent sessions across the bot |
| `/seam attach <path>` | Upload a host-side file (under `REPOS_ROOT` or `ATTACH_ROOTS`) into the channel without involving the agent |
| `/seam whoami` | Show which account this thread's agent profile is signed in as (Copilot only — reads `<config-dir>/config.json`) |
| `/seam avatar` | Re-push the bot avatar to Discord (force re-upload) |
| `/seam help` | Show this list |

Interactive pickers use buttons for ≤15 choices (laid out across up to 3 rows of 5) and a select menu for 16–25.

Free-form messages in a thread are sent straight to the agent. You can attach
files to a message and they'll be forwarded as ACP content blocks: images and
text-ish files (markdown, source code, JSON, CSV, logs, etc.) are inlined when
the agent supports it; everything else is sent as a CDN link the agent can
fetch. Limits per message: 8 attachments, 5 MB each, text inlined up to 256 KB.

If the agent emits an image, audio file, or embedded resource (in a tool
result or its own message stream), the bot uploads it to the thread as a
Discord attachment. Discord's free-tier 25 MB upload limit applies.

The bot also auto-uploads two adjacent cases:

- **Streaming fence-to-file.** Every fenced code block the agent emits is
  captured as it streams, stripped from chat, and uploaded as a Discord
  attachment named `snippet-N.<ext>` (extension inferred from the language
  tag; unknown tags fall back to `.txt`). This keeps long code out of the
  chat, makes the empty-pill / unclosed-fence runaway bug architecturally
  impossible, and gives consistent UX for any size snippet.
- **Fence-as-file shortcut.** If a fence's entire content is a single line
  that resolves to a real file under `REPOS_ROOT` or `ATTACH_ROOTS`, the
  bot uploads the *referenced file* instead of the snippet text. Symlinks
  are followed and the realpath is re-validated. Useful for "give me back
  that doc as an attachment" prompts.

### Multiple Copilot accounts

You can register more than one Copilot profile, each authenticated as a
different GitHub account, by setting `COPILOT_PROFILES`:

```sh
COPILOT_PROFILES=work:/Users/me/.copilot-work,personal:/Users/me/.copilot-personal
```

For each entry the bot spawns `copilot --acp --config-dir <dir>`. Copilot
keeps **all** of its state per `--config-dir` — auth tokens, MCP config,
session history — so the two profiles are fully isolated CLIs sharing
one binary. They show up in `/seam agent` as `copilot-work` and
`copilot-personal` alongside the default `copilot` profile.

One-time setup per account on the host (or inside the container):

```sh
COPILOT_HOME=/Users/me/.copilot-work copilot login
COPILOT_HOME=/Users/me/.copilot-personal copilot login
```

Verify in a thread with `/seam whoami` — the bot reads
`<config-dir>/config.json` and reports the GitHub login.

### Multiple agy accounts

> **Note:** agy (Antigravity CLI) is Google's official replacement for the deprecated Gemini CLI. The Gemini CLI service was sunset on June 18, 2026.

The `agy` profile currently uses a single global agy session (`~/.gemini/antigravity-cli/`). Multi-account support for agy is not yet implemented — see `src/agents/profiles/agy.ts` for the current integration.

### Multiple Claude accounts

Same pattern as Copilot, using `CLAUDE_PROFILES`:

```sh
CLAUDE_PROFILES=work:/Users/me/.claude-work,personal:/Users/me/.claude-personal
```

For each entry the bot spawns `claude-agent-acp` with
`CLAUDE_CONFIG_DIR=<dir>` in the child env. Each dir holds its own
auth and settings. Profiles show up in `/seam agent` as `claude-work`
and `claude-personal` alongside the default `claude` profile.

One-time setup per account on the host:

```sh
CLAUDE_CONFIG_DIR=/Users/me/.claude-work claude /login
CLAUDE_CONFIG_DIR=/Users/me/.claude-personal claude /login
```

`/seam whoami` is best-effort for Claude — it tries to read the email /
account from `<config-dir>/.credentials.json` (and a couple of fallbacks).
If that fails (file format changes upstream, etc.) the command still
reports which profile id you're on.

#### ⚠️ Claude model selection & the `claude-agent-acp` resolver

Claude model handling has a sharp edge: the `claude-agent-acp` wrapper resolves
model strings **inconsistently** — some aliases and full IDs silently resolve to
the wrong model or the wrong context window. For example, the alias `opus[1m]`
resolves to *Sonnet*, and the full ID `claude-sonnet-4-6[1m]` silently gives a
200K window instead of 1M.

Because of this:

- The `CLAUDE_MODELS` picker in `.env` contains only **empirically verified**
  entries (each one checked against JSONL ground truth, not the model's
  self-report). Don't add a model without verifying it.
- As of `claude-agent-acp` 0.54.1 (ACP SDK 1.1.0) no local patch is needed:
  model selection goes through `setSessionConfigOption`, which exact-matches full
  canonical `claude-*` IDs against the advertised list before the fuzzy resolver.
  Native context windows are declared in `src/agents/profiles/claude.ts`
  (`CLAUDE_CONTEXT_WINDOWS`) — no `[1m]` suffix.
- The status card shows the **resolved** API model id and the current reasoning
  effort on every turn, so a wrong-model regression is visible immediately.

**Anyone updating `claude-agent-acp` / `@anthropic-ai/claude-code`, changing the
model picker, or touching effort handling must follow
[`docs/model-management-runbook.md`](docs/model-management-runbook.md)** — the
authoritative, step-by-step empirical process (pull versions → read changelogs →
update → re-apply patch → verify against JSONL → confirm new/resumed sessions).

### Remote agent profiles (Mac / off-server machine)

You can run an agent CLI on a **separate machine** — one that cannot accept inbound connections — and expose it as a regular agent profile via a WebSocket bridge. Two modes are supported:

- **Server mode**: seam-acp hosts the WS server (and `cloudflared`); remote machine dials in outbound.
- **Client mode**: remote machine hosts the WS server (and `cloudflared`); seam-acp dials out.

```sh
# Server mode (.env on seam-acp):
REMOTE_COPILOT_PROFILES=mac:9999:your-secret-token
# Run on remote machine: node scripts/remote-agent-bridge.mjs wss://tunnel-url your-token

# Client mode (.env on seam-acp):
REMOTE_COPILOT_PROFILES=mac:wss://random.trycloudflare.com:your-secret-token
# Run on remote machine: node scripts/remote-agent-bridge.mjs --server 9999 your-token
#   then: cloudflared tunnel --url ws://localhost:9999
```

The profile appears in `/seam agent` as `copilot-remote-mac`. Neither machine needs an open inbound port — both modes use Cloudflare Tunnel for the outbound-only connection. See **[docs/remote-agent.md](docs/remote-agent.md)** for full setup instructions.

### MCP servers

The bot can attach Model Context Protocol servers globally to every
session. Configure them via env vars:

| Env var | Server | What it adds |
|---|---|---|
| `MCP_PLAYWRIGHT_ENABLED=true` | [`@playwright/mcp`](https://www.npmjs.com/package/@playwright/mcp) | Real Chromium browser. Lets the agent navigate sites and take screenshots; screenshots flow back as Discord attachments via the agent-file pipeline. Chromium (~150 MB) is downloaded by Playwright on first run. |

Add new servers in `src/mcp.ts`. Anything that emits `image` / `audio` /
embedded resource content blocks will be picked up automatically and
uploaded to the thread.

## Architecture

```
ChatAdapter          (Discord today, Slack tomorrow)
   ↓
Orchestrator   ──→   Renderer  (platform-specific text formatting)
   ↓
SessionRouter  ──→   SessionStore  (sqlite via better-sqlite3)
   ↓
AgentRuntime         (one per session; auto-resumes on restart)
   ↓
AgentProfile         (Copilot today, Claude Code tomorrow — adds via `src/agents/profiles/`)
```

- **`src/platforms/chat-adapter.ts`** — generic chat platform interface.
- **`src/platforms/discord/`** — discord.js v14 implementation + slash commands + repo picker.
- **`src/agents/agent-runtime.ts`** — wraps `@agentclientprotocol/sdk` + a child process running an ACP server. Handles `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, model / mode / config option setters, and emits typed events.
- **`src/agents/profiles/copilot.ts`** — spawns `copilot --acp`. Supports `configDir` for multi-account use and exposes `whoami()`. Sibling profiles: `agy.ts` (Google Antigravity CLI, in-process ACP bridge), `claude.ts` (Anthropic Claude Code, via the `claude-agent-acp` adapter), `opencode.ts` (LM Studio local models via opencode), and `remote.ts` (WebSocket-backed profile for agents on separate machines — see [docs/remote-agent.md](docs/remote-agent.md)). Add a new profile by writing one of these.
- **`src/core/`** — pure utilities: text chunker, path safety, sqlite store, session router, status panel.

## Testing

```sh
npm test         # unit tests + 1 integration test against `copilot --acp`
npm run typecheck
npm run build
```

The ACP integration test is automatically skipped if `copilot` is not on `PATH`.

## License

MIT — see [LICENSE](LICENSE).
