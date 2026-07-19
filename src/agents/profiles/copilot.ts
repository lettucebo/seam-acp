import { spawn } from "node:child_process";
import fs, { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { AgentIdentity, AgentProfile } from "../agent-profile.js";
import type { SessionSummary, SessionSummaryLine } from "../session-manager.js";

/** Absolute path to the compiled ask_user MCP server (dist/ask-user-mcp-server.js),
 *  injected per-session when a ChoiceBroker wires the runtime. */
const ASK_USER_SERVER = fileURLToPath(
  new URL("../../ask-user-mcp-server.js", import.meta.url)
);

/**
 * GitHub Copilot CLI as an ACP server (`copilot --acp`).
 *
 * Start the ACP server with `--allow-all` so the bot can run end-to-end
 * without needing a permission UI. (The agent will still call
 * `session/request_permission`; we auto-approve those — see AgentRuntime.)
 *
 * Copilot ignores the `mcpServers` field on ACP `session/new` and only
 * loads MCP servers from `~/.copilot/mcp-config.json` plus anything
 * passed via `--additional-mcp-config`. So we translate our global
 * McpServer[] into Copilot's expected JSON shape and inject it at spawn.
 *
 * Multi-account: pass a custom `configDir` (and a unique `id` /
 * `displayName`) to register a second Copilot profile pointed at a
 * different `--config-dir`. Each config dir holds its own auth state,
 * MCP config, and session history, so the two profiles act as fully
 * isolated CLIs sharing one binary.
 */
export function makeCopilotProfile(opts: {
  /** Profile id. Defaults to "copilot". Must be unique across registered profiles. */
  id?: string;
  /** Display name shown in pickers / status. Defaults to "GitHub Copilot". */
  displayName?: string;
  cliPath?: string;
  defaultModel: string;
  mcpServers?: McpServer[];
  /**
   * Override Copilot's config directory (auth, MCP config, session state).
   * When set, spawn args include `--config-dir <dir>` and `whoami()` reads
   * `<dir>/config.json`. When omitted, the CLI uses its default (~/.copilot).
   */
  configDir?: string;
  staticModels?: ReadonlyArray<{ modelId: string; name: string }>;
  threadAbbr?: string;
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "copilot";
  const configDir = opts.configDir?.trim() || undefined;

  let identityCache: AgentIdentity | null | undefined;

  return {
    id: opts.id ?? "copilot",
    displayName: opts.displayName ?? "GitHub Copilot",
    defaultModel: opts.defaultModel,
    staticModels: opts.staticModels,
    threadAbbr: opts.threadAbbr,
    configDir,
    // Copilot exposes reasoning effort as an ACP config option (verified via
    // `copilot --acp`: configOptions[id=reasoning_effort], low|medium|high).
    // Applied post-session-create via setSessionConfigOption (AgentRuntime).
    effort: { mechanism: "configOption", configId: "reasoning_effort", levels: ["low", "medium", "high"] },
    spawn(_modelOverride, _effortOverride, ctx) {
      // Build the injected MCP config per spawn so we can add a per-session
      // ask_user server (scoped by a session bearer token) on top of any
      // globally-configured MCP servers.
      const servers: McpServer[] = [...(opts.mcpServers ?? [])];
      // Only inject when the compiled server exists (production/dist). Under
      // `npm run dev` (tsx) the .js isn't present; degrade to prose rather than
      // pointing Copilot at a missing MCP server.
      if (ctx?.askUser && fs.existsSync(ASK_USER_SERVER)) {
        servers.push({
          name: "seam_ask_user",
          command: process.execPath,
          args: [ASK_USER_SERVER],
          env: [
            { name: "SEAM_CHOICE_URL", value: ctx.askUser.url },
            { name: "SEAM_CHOICE_TOKEN", value: ctx.askUser.token },
          ],
        });
      }
      const additionalMcpJson = buildCopilotMcpConfigJson(servers);
      const args = ["--acp"];
      if (additionalMcpJson) {
        args.push("--additional-mcp-config", additionalMcpJson);
      }
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (configDir) {
        // --config-dir is not a supported CLI flag. Instead, read the OAuth
        // token from the profile's config.json and inject it via
        // COPILOT_GITHUB_TOKEN, which the CLI checks before the system
        // credential store — giving us true per-profile auth isolation.
        const token = readCopilotTokenSync(configDir);
        if (token) env.COPILOT_GITHUB_TOKEN = token;
      }
      return spawn(cli, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        detached: true,
      });
    },
    async whoami() {
      if (identityCache !== undefined) return identityCache;
      identityCache = await readCopilotIdentity(configDir);
      return identityCache;
    },
    sessionManager: {
      async listSessions(cwd: string): Promise<SessionSummary[]> {
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".copilot");
        const dbPath = path.join(dir, "session-store.db");
        try {
          await fsp.access(dbPath);
          const db = new Database(dbPath);
          try {
            // Query seam.db as a source of truth for session IDs associated with this repo path.
            const seamDbSessions = new Set<string>();
            try {
              const dataDir = process.env.DATA_DIR ?? "./data";
              const seamDbPath = path.resolve(dataDir, "seam.db");
              const seamDb = new Database(seamDbPath);
              try {
                // Find all sessions in seam.db that have this repo path
                const rows = seamDb.prepare("SELECT acp_session_id FROM sessions WHERE repo_path = ?").all(cwd) as any[];
                for (const row of rows) {
                  if (row.acp_session_id) {
                    seamDbSessions.add(row.acp_session_id);
                  }
                }
              } finally {
                seamDb.close();
              }
            } catch (err) {
              // ignore seamDb query failures
            }

            // Fetch all sessions from the copilot DB.
            const allSessions = db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as any[];
            const sessions: any[] = [];
            for (const s of allSessions) {
              const matchesCwd = s.cwd === cwd;
              const matchesSeamDb = s.id && seamDbSessions.has(s.id);

              if (matchesCwd || (matchesSeamDb && !s.cwd)) {
                sessions.push(s);
              }
            }

            const summaries: SessionSummary[] = [];

            for (const sess of sessions) {
              const sessionId = sess.id;
              const createdAt = sess.created_at ? Date.parse(sess.created_at) : Date.now();
              const lastActivityAt = sess.updated_at ? Date.parse(sess.updated_at) : Date.now();

              const turns = db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index ASC").all(sessionId) as any[];
              
              const allMessages: Array<{ sender: "human" | "agent"; text: string }> = [];
              for (const turn of turns) {
                if (turn.user_message) {
                  allMessages.push({ sender: "human", text: turn.user_message });
                }
                if (turn.assistant_response) {
                  allMessages.push({ sender: "agent", text: turn.assistant_response });
                }
              }

              const transcriptLines: string[] = [];
              for (const turn of turns) {
                if (turn.user_message?.trim()) {
                  transcriptLines.push(`### User\n${turn.user_message.trim()}`);
                }
                if (turn.assistant_response?.trim()) {
                  transcriptLines.push(`### Assistant\n${turn.assistant_response.trim()}`);
                }
              }
              const estimatedTokens = Math.ceil(transcriptLines.join("\n\n").length / 4);

              let previewLines: SessionSummaryLine[] = [];
              if (allMessages.length <= 16) {
                previewLines = allMessages;
              } else {
                const firstSix = allMessages.slice(0, 6);
                const lastTen = allMessages.slice(-10);
                previewLines = [...firstSix, ...lastTen];
              }

              summaries.push({
                sessionId,
                createdAt,
                lastActivityAt,
                previewLines,
                estimatedTokens,
              });
            }
            return summaries;
          } finally {
            db.close();
          }
        } catch {
          return [];
        }
      },

      async cloneSession(cwd: string, oldSessionId: string, newSessionId: string): Promise<void> {
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".copilot");
        const dbPath = path.join(dir, "session-store.db");
        const sessionStateDir = path.join(dir, "session-state");

        const db = new Database(dbPath);
        try {
          const sessionRow = db.prepare("SELECT * FROM sessions WHERE id = ?").get(oldSessionId) as any;
          if (sessionRow) {
            const nowIso = new Date().toISOString();
            db.prepare(`
              INSERT INTO sessions (id, cwd, repository, host_type, branch, summary, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              newSessionId,
              cwd,
              sessionRow.repository,
              sessionRow.host_type,
              sessionRow.branch,
              sessionRow.summary,
              nowIso,
              nowIso
            );
          }

          const turns = db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index ASC").all(oldSessionId) as any[];
          const insertTurn = db.prepare(`
            INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
            VALUES (?, ?, ?, ?, ?)
          `);
          for (const turn of turns) {
            insertTurn.run(
              newSessionId,
              turn.turn_index,
              turn.user_message,
              turn.assistant_response,
              turn.timestamp
            );
          }

          const oldSubDir = path.join(sessionStateDir, oldSessionId);
          const newSubDir = path.join(sessionStateDir, newSessionId);
          try {
            const stat = await fsp.stat(oldSubDir);
            if (stat.isDirectory()) {
              await fsp.mkdir(newSubDir, { recursive: true });
              await fsp.cp(oldSubDir, newSubDir, { recursive: true });
            }
          } catch {
            // ignore
          }
        } finally {
          db.close();
        }
      },

      async deleteSession(cwd: string, sessionId: string): Promise<void> {
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".copilot");
        const dbPath = path.join(dir, "session-store.db");
        const sessionStateDir = path.join(dir, "session-state");

        const db = new Database(dbPath);
        try {
          db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
          db.prepare("DELETE FROM turns WHERE session_id = ?").run(sessionId);
          try {
            db.prepare("DELETE FROM search_index_content WHERE c1 = ?").run(sessionId);
          } catch {
            // ignore
          }
        } finally {
          db.close();
        }

        const subDir = path.join(sessionStateDir, sessionId);
        try {
          await fsp.rm(subDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      },

      async getTranscript(cwd: string, sessionId: string): Promise<string> {
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".copilot");
        const dbPath = path.join(dir, "session-store.db");
        const db = new Database(dbPath);
        try {
          const turns = db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index ASC").all(sessionId) as any[];
          const transcriptLines: string[] = [];
          for (const turn of turns) {
            if (turn.user_message?.trim()) {
              transcriptLines.push(`### User\n${turn.user_message.trim()}`);
            }
            if (turn.assistant_response?.trim()) {
              transcriptLines.push(`### Assistant\n${turn.assistant_response.trim()}`);
            }
          }
          return transcriptLines.join("\n\n");
        } finally {
          db.close();
        }
      }
    },
  };
}

/**
 * Synchronously read the OAuth token for the last logged-in user from a
 * Copilot config.json. Used at spawn time to inject COPILOT_GITHUB_TOKEN.
 * Returns undefined on any failure.
 */
function readCopilotTokenSync(configDir: string): string | undefined {
  const file = path.join(configDir, "config.json");
  try {
    // Strip JS-style comments before parsing (Copilot uses JSONC)
    const raw = fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "");
    const parsed = JSON.parse(raw) as {
      lastLoggedInUser?: { host?: string; login?: string };
      copilotTokens?: Record<string, string>;
    };
    const u = parsed.lastLoggedInUser;
    if (!u?.host || !u?.login) return undefined;
    const key = `${u.host}:${u.login}`;
    return parsed.copilotTokens?.[key];
  } catch {
    return undefined;
  }
}

/**
 * Read GitHub login from Copilot's `config.json`. Returns null on any
 * failure (file missing, malformed JSON, no logged-in user).
 */
async function readCopilotIdentity(
  configDir: string | undefined
): Promise<AgentIdentity | null> {
  const dir = configDir ?? path.join(process.env.HOME ?? "", ".copilot");
  const file = path.join(dir, "config.json");
  try {
    const raw = await fsp.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as {
      lastLoggedInUser?: { login?: string; host?: string };
      loggedInUsers?: Array<{ login?: string; host?: string }>;
    };
    const u =
      parsed.lastLoggedInUser ??
      (parsed.loggedInUsers && parsed.loggedInUsers[0]) ??
      undefined;
    if (!u || !u.login) return null;
    return u.host ? { login: u.login, host: u.host } : { login: u.login };
  } catch {
    return null;
  }
}

export interface CopilotQuotaSnapshot {
  unlimited: boolean;
  entitlement: number;
  remaining: number;
  percentRemaining: number;
  overagePermitted: boolean;
  overageCount: number;
}

export interface CopilotUsageData {
  login: string | null;
  plan: string | null;
  org: string | null;
  quotaResetAt: string | null;
  chat: CopilotQuotaSnapshot | null;
  completions: CopilotQuotaSnapshot | null;
  premiumInteractions: CopilotQuotaSnapshot | null;
}

/**
 * Fetches Copilot plan and quota data from GitHub's internal user endpoint.
 * Uses the OAuth token stored in config.json. Returns what it can on failure.
 */
export async function fetchCopilotUsage(
  configDir?: string
): Promise<CopilotUsageData> {
  const dir = configDir?.trim() || path.join(process.env.HOME ?? "", ".copilot");
  const result: CopilotUsageData = {
    login: null,
    plan: null,
    org: null,
    quotaResetAt: null,
    chat: null,
    completions: null,
    premiumInteractions: null,
  };
  const identity = await readCopilotIdentity(configDir);
  if (identity?.login) result.login = identity.login;
  const token = readCopilotTokenSync(dir);
  if (!token) return result;
  try {
    const res = await fetch("https://api.github.com/copilot_internal/user", {
      headers: { Authorization: `token ${token}`, Accept: "application/json" },
    });
    if (res.ok) {
      const body = (await res.json()) as Record<string, unknown>;
      result.login = (body.login as string | undefined) ?? result.login;
      result.plan = (body.copilot_plan as string | undefined) ?? null;
      result.quotaResetAt = (body.quota_reset_date_utc as string | undefined) ?? null;
      const orgs = body.organization_list as Array<{ name?: string; login?: string }> | undefined;
      if (orgs && orgs.length > 0) result.org = orgs[0]?.name ?? orgs[0]?.login ?? null;
      const snaps = body.quota_snapshots as Record<string, unknown> | undefined;
      if (snaps) {
        result.chat = parseQuota(snaps.chat);
        result.completions = parseQuota(snaps.completions);
        result.premiumInteractions = parseQuota(snaps.premium_interactions);
      }
    }
  } catch {
    /* return what we have */
  }
  return result;
}

function parseQuota(raw: unknown): CopilotQuotaSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    unlimited: r.unlimited === true,
    entitlement: typeof r.entitlement === "number" ? r.entitlement : 0,
    remaining: typeof r.remaining === "number" ? r.remaining : 0,
    percentRemaining: typeof r.percent_remaining === "number" ? r.percent_remaining : 0,
    overagePermitted: r.overage_permitted === true,
    overageCount: typeof r.overage_count === "number" ? r.overage_count : 0,
  };
}

/**
 * Translate our generic ACP McpServer[] into Copilot's expected
 * `{mcpServers: {name: {...}}}` JSON. Returns undefined when the list
 * is empty so we don't pass an empty `--additional-mcp-config` flag.
 */
function buildCopilotMcpConfigJson(servers: McpServer[]): string | undefined {
  if (servers.length === 0) return undefined;

  const map: Record<string, unknown> = {};
  for (const s of servers) {
    // The ACP McpServer union is discriminated by `type` (http/sse) or
    // is the bare stdio variant (no type). We pass through the same
    // shape Copilot's mcp-config.json uses.
    if ("type" in s && (s.type === "http" || s.type === "sse")) {
      const { name, ...rest } = s as McpServer & { name: string };
      map[name] = rest;
    } else {
      // Stdio
      const stdio = s as McpServer & {
        name: string;
        command: string;
        args: string[];
        env?: Array<{ name: string; value: string }>;
      };
      const env: Record<string, string> = {};
      for (const v of stdio.env ?? []) env[v.name] = v.value;
      map[stdio.name] = {
        type: "stdio",
        command: stdio.command,
        args: stdio.args,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    }
  }
  return JSON.stringify({ mcpServers: map });
}
