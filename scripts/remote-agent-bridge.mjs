#!/usr/bin/env node
/**
 * remote-agent-bridge.mjs
 *
 * Run this on the machine where the agent CLI (e.g. Copilot) is installed.
 * Bridges the ACP stdio protocol between a local agent CLI and seam-acp over
 * a WebSocket connection. Supports two modes:
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CLIENT MODE (default): bridge dials out to seam-acp's WS server.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Usage:
 *     node remote-agent-bridge.mjs <ws-url> <token> [--cwd <path>] [copilot-cmd]
 *
 *   Arguments:
 *     ws-url      seam-acp WebSocket URL, e.g. wss://tunnel.trycloudflare.com
 *                 (or ws://localhost:9999 for local testing)
 *     token       Shared secret matching REMOTE_COPILOT_PROFILES token in .env
 *     --cwd path  Local working directory to use (default: process.cwd())
 *     copilot-cmd Optional path to the copilot binary (default: "copilot")
 *                 Override with COPILOT_CMD env var.
 *
 *   seam-acp .env:
 *     REMOTE_COPILOT_PROFILES=mac:9999:mysecrettoken
 *
 *   Example:
 *     node remote-agent-bridge.mjs wss://your-tunnel.trycloudflare.com mysecret --cwd /Users/you/Projects
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SERVER MODE: bridge hosts a WS server; seam-acp dials in.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Usage:
 *     node remote-agent-bridge.mjs --server <port> <token> [--cwd <path>] [copilot-cmd]
 *
 *   seam-acp .env:
 *     REMOTE_COPILOT_PROFILES=mac:wss://random.trycloudflare.com:mysecrettoken
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Dependencies:
 *   npm install ws   (or run from within the cloned seam-acp repo directory)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { spawn, execSync, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";

const copilotDir = path.join(homedir(), ".copilot");
const dbPath = path.join(copilotDir, "session-store.db");
const sessionStateDir = path.join(copilotDir, "session-state");

// ---------------------------------------------------------------------------
// Claude Code session helpers (used when --session-type claude)
// Claude stores sessions as ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
// ---------------------------------------------------------------------------
const claudeDir = path.join(homedir(), ".claude");

function claudeProjectDir(cwd) {
  const slug = cwd.replace(/\//g, "-");
  return path.join(claudeDir, "projects", slug);
}

/** Find the actual project directory Claude Code uses for a given cwd.
 *  Claude's slug is `cwd.replace(/\//g, "-")` but some builds normalise
 *  dots or trailing slashes differently. Scan all project dirs and return
 *  the one whose slug best matches. Falls back to the computed slug. */
async function resolveClaudeProjectDir(cwd) {
  const computed = claudeProjectDir(cwd);
  try {
    await fsp.access(computed);
    return computed; // fast path: computed slug exists
  } catch { /* continue to scan */ }

  const projectsRoot = path.join(claudeDir, "projects");
  let entries;
  try {
    entries = await fsp.readdir(projectsRoot);
  } catch {
    return computed; // no projects dir at all
  }

  // Normalise both sides: lowercase, dots→dashes, collapse repeated dashes.
  const norm = (s) => s.toLowerCase().replace(/\./g, "-").replace(/-+/g, "-");
  const cwdSlug = norm(cwd.replace(/\//g, "-"));
  console.error(`[bridge] scanning project dirs for cwd=${cwd} (norm slug: ${cwdSlug})`);
  console.error(`[bridge] available project dirs: ${entries.join(", ")}`);

  const match = entries.find((e) => norm(e) === cwdSlug);
  if (match) {
    console.error(`[bridge] matched project dir: ${match}`);
    return path.join(projectsRoot, match);
  }
  // No match — return computed so the caller logs the right path in the error.
  return computed;
}

async function claudeListSessions(cwd) {
  const projectDir = await resolveClaudeProjectDir(cwd);
  let files;
  try {
    files = await fsp.readdir(projectDir);
  } catch {
    console.error(`[bridge] claudeListSessions: project dir not found: ${projectDir}`);
    return [];
  }
  const summaries = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const sessionId = file.slice(0, -6);
    const filePath = path.join(projectDir, file);
    try {
      const stat = await fsp.stat(filePath);
      let createdAt = stat.birthtimeMs;
      let lastActivityAt = stat.mtimeMs;
      const content = await fsp.readFile(filePath, "utf8");
      const lines = content.split("\n").filter(l => l.trim());
      const allMessages = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.isMeta === true || entry.isSidechain === true) continue;
          let text = "";
          const msgContent = entry.message?.content;
          if (typeof msgContent === "string") {
            text = msgContent;
          } else if (Array.isArray(msgContent)) {
            text = msgContent.filter(c => c.type === "text").map(c => c.text || "").join("\n");
          }
          const ts = entry.timestamp ? Date.parse(entry.timestamp) : undefined;
          if (ts && !isNaN(ts)) {
            if (allMessages.length === 0) createdAt = ts;
            lastActivityAt = ts;
          }
          if (text.trim()) {
            allMessages.push({ sender: entry.type === "user" ? "human" : "agent", text: text.trim() });
          }
        } catch { /* skip malformed line */ }
      }
      let previewLines = allMessages.length <= 16
        ? allMessages
        : [...allMessages.slice(0, 6), ...allMessages.slice(-10)];
      const estimatedTokens = Math.ceil(allMessages.map(m => m.text).join("\n\n").length / 4);
      summaries.push({ sessionId, createdAt, lastActivityAt, previewLines, estimatedTokens });
    } catch { /* skip unreadable file */ }
  }
  summaries.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  console.error(`[bridge] claudeListSessions: found ${summaries.length} session(s)`);
  return summaries;
}

async function claudeGetTranscript(cwd, sessionId) {
  const filePath = path.join(await resolveClaudeProjectDir(cwd), `${sessionId}.jsonl`);
  const content = await fsp.readFile(filePath, "utf8");
  const lines = content.split("\n").filter(l => l.trim());
  const out = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.isMeta === true || entry.isSidechain === true) continue;
      let text = "";
      const msgContent = entry.message?.content;
      if (typeof msgContent === "string") text = msgContent;
      else if (Array.isArray(msgContent)) text = msgContent.filter(c => c.type === "text").map(c => c.text || "").join("\n");
      if (text.trim()) out.push(`### ${entry.type === "user" ? "User" : "Assistant"}\n${text.trim()}`);
    } catch { /* skip */ }
  }
  return out.join("\n\n");
}

async function claudeDeleteSession(cwd, sessionId) {
  const projectDir = await resolveClaudeProjectDir(cwd);
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  await fsp.unlink(file).catch(() => {});
  const subDir = path.join(projectDir, sessionId);
  await fsp.rm(subDir, { recursive: true, force: true }).catch(() => {});
}

async function claudeCompactSession(cwd, sessionId, summaryText) {
  const projectDir = await resolveClaudeProjectDir(cwd);
  await fsp.mkdir(projectDir, { recursive: true });
  const newSessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const newFile = path.join(projectDir, `${newSessionId}.jsonl`);
  const now = new Date().toISOString();
  const summaryEntry = { type: "user", message: { role: "user", content: summaryText }, timestamp: now, sessionId: newSessionId, isMeta: false };
  await fsp.writeFile(newFile, JSON.stringify(summaryEntry) + "\n");
  return newSessionId;
}

async function claudeCloneSession(cwd, oldSessionId, newSessionId) {
  const projectDir = await resolveClaudeProjectDir(cwd);
  const src = path.join(projectDir, `${oldSessionId}.jsonl`);
  const dst = path.join(projectDir, `${newSessionId}.jsonl`);
  await fsp.copyFile(src, dst);
}

/** Write an uploaded attachment to this machine's filesystem under
 *  `<cwd>/.seam-attachments/<filename>` and return the absolute path. Used by
 *  network-restricted remote agents that can't fetch Discord CDN URLs but
 *  can still consume local files. */
async function writeAttachment(cwd, filename, base64) {
  // Sanitize filename: strip path separators so callers can't write outside
  // the .seam-attachments directory.
  const safe = path.basename(filename).replace(/[\/\\]/g, "_");
  const dir = path.join(cwd, ".seam-attachments");
  await fsp.mkdir(dir, { recursive: true });
  const absPath = path.join(dir, safe);
  await fsp.writeFile(absPath, Buffer.from(base64, "base64"));
  return { path: absPath };
}

/** Match the same logic claude-agent-acp uses to decide if a model has a 1M
 *  context window. The "1m" token appears either as "opus[1m]" or as a
 *  hyphenated suffix like "claude-opus-4-7-1m" in API model ids. */
function inferClaudeContextLimit(model) {
  if (!model) return 200_000;
  if (/\b1m\b/i.test(model) || /-1m\b/i.test(model)) return 1_000_000;
  return 200_000;
}

/** Read the most recent assistant `usage` block from a Claude Code JSONL
 *  transcript. Returns zeros if no JSONL or no assistant message found.
 *  When newerThanMs is provided, skips any entry whose timestamp is older. */
async function claudeGetUsage(cwd, sessionId, newerThanMs) {
  const empty = { model: null, totalUsed: 0, contextLimit: 200_000 };
  const projectDir = await resolveClaudeProjectDir(cwd);
  let files;
  try {
    files = await fsp.readdir(projectDir);
  } catch {
    return empty;
  }

  let targetPath;
  if (sessionId) {
    const file = `${sessionId}.jsonl`;
    if (files.includes(file)) targetPath = path.join(projectDir, file);
  }
  if (!targetPath) {
    let newest = null;
    let newestMtime = 0;
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const stat = await fsp.stat(path.join(projectDir, f));
        if (stat.mtimeMs > newestMtime) {
          newest = f;
          newestMtime = stat.mtimeMs;
        }
      } catch { /* skip */ }
    }
    if (!newest) return empty;
    targetPath = path.join(projectDir, newest);
  }

  let content;
  try {
    content = await fsp.readFile(targetPath, "utf8");
  } catch {
    return empty;
  }
  const cutoff = typeof newerThanMs === "number" ? newerThanMs : 0;
  const lines = content.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type !== "assistant" || !entry.message?.usage) continue;
      // If a timestamp filter is set, skip entries older than the cutoff.
      if (cutoff > 0 && entry.timestamp) {
        const entryMs = Date.parse(entry.timestamp);
        if (!isNaN(entryMs) && entryMs < cutoff) continue;
      }
      const u = entry.message.usage;
      const model = entry.message.model ?? null;
      const inputTokens = u.input_tokens || 0;
      const cacheRead = u.cache_read_input_tokens || 0;
      const cacheCreation = u.cache_creation_input_tokens || 0;
      const outputTokens = u.output_tokens || 0;
      return {
        model,
        input_tokens: inputTokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        output_tokens: outputTokens,
        totalUsed: inputTokens + cacheRead + cacheCreation + outputTokens,
        contextLimit: inferClaudeContextLimit(model),
      };
    } catch { /* skip malformed line */ }
  }
  return empty;
}

function escapeSql(val) {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return String(val);
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function parseSqliteLineFormat(stdout) {
  const lines = stdout.split("\n");
  const results = [];
  let currentRow = null;
  for (const line of lines) {
    if (!line.trim()) {
      if (currentRow) {
        results.push(currentRow);
        currentRow = null;
      }
      continue;
    }
    const match = line.match(/^\s*([^=\s]+)\s*=\s*(.*)$/);
    if (match) {
      if (!currentRow) currentRow = {};
      currentRow[match[1]] = match[2];
    }
  }
  if (currentRow) {
    results.push(currentRow);
  }
  return results;
}

function execSql(dbPath, sql) {
  try {
    const stdout = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" });
    return stdout.trim() ? JSON.parse(stdout) : [];
  } catch (err) {
    try {
      const stdout = execFileSync("sqlite3", ["-line", dbPath, sql], { encoding: "utf8" });
      return parseSqliteLineFormat(stdout);
    } catch (fallbackErr) {
      console.error("[bridge] SQL execution error:", err.message, fallbackErr.message);
      throw err;
    }
  }
}


/** Milliseconds to wait before reconnecting after a disconnect (client mode). */
const RECONNECT_DELAY_MS = 5_000;

// Unique ID for this bridge process lifetime. Sent to seam-acp on every WS
// connect so it can detect a bridge restart and evict stale runtimes.
const BRIDGE_INSTANCE_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

/** Interval for sending WS ping frames to keep the tunnel/proxy alive. */
const KEEPALIVE_PING_MS = 25_000;

async function loadWs() {
  try {
    const mod = await import("ws");
    return { WebSocket: mod.WebSocket, WebSocketServer: mod.WebSocketServer };
  } catch {
    console.error("Error: 'ws' package not found. Install it with: npm install ws");
    process.exit(1);
  }
}

/**
 * Rewrites the `cwd` field in an ACP chunk when it contains an initialize or
 * create_session message. Uses simple text replacement — safe because cwd is
 * always a plain path string and the method check prevents false positives.
 */
function rewriteCwdInChunk(text, localCwd) {
  if (!text.includes('"initialize"') && !text.includes('"session/new"') && !text.includes('"session/resume"') && !text.includes('"session/load"')) {
    return text;
  }
  const escaped = localCwd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const rewritten = text.replace(/"cwd"\s*:\s*"[^"]*"/g, `"cwd":"${escaped}"`);
  if (rewritten !== text) {
    console.error(`[bridge] Rewrote cwd to: ${localCwd}`);
  }
  return rewritten;
}

function spawnAgent(copilotCmd, localCwd) {
  const ghToken = process.env.GH_TOKEN || (() => {
    try { return execSync("gh auth token", { stdio: ["pipe", "pipe", "ignore"] }).toString().trim(); }
    catch { return ""; }
  })();
  const cmdParts = copilotCmd.split(" ");
  const cmd = cmdParts[0];
  // Forward-compat parity with the local spawn path (buildCopilotAcpArgs): request
  // Copilot's long-context tier so remote Copilot sessions pick up the larger
  // window automatically once GitHub enables it over ACP. Harmless no-op today
  // (effective window still ~264K). Gated to copilot commands — it is a
  // Copilot-only flag and would be an invalid arg for other ACP agents this
  // bridge can spawn (e.g. claude-agent-acp). COPILOT_ARGS, when set, overrides
  // the whole default (set it to "--acp --context long_context" for a custom
  // copilot path, or to the appropriate flags for a non-copilot agent).
  const isCopilotCmd = /copilot/i.test(path.basename(cmd));
  const extraArgs = process.env.COPILOT_ARGS !== undefined
    ? process.env.COPILOT_ARGS.split(" ").filter(Boolean)
    : isCopilotCmd
      ? ["--acp", "--context", "long_context"]
      : ["--acp"];
  const cmdArgs = [...cmdParts.slice(1), ...extraArgs];
  console.error(`[bridge] Spawning agent: ${cmd} ${cmdArgs.join(" ")} (GH_TOKEN: ${ghToken ? ghToken.slice(0, 8) + "..." : "MISSING"})`);
  return spawn(cmd, cmdArgs, {
    cwd: localCwd,
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...(ghToken ? { GH_TOKEN: ghToken } : {}) },
  });
}

/**
 * Send a multiplexed message over a WebSocket.
 * Protocol: { slot, type, data?, code? }
 *   "data"  — ACP payload (UTF-8 text)
 *   "kill"  — seam-acp → bridge: terminate agent for this slot
 *   "exit"  — bridge → seam-acp: agent exited
 */
function muxSend(ws, WebSocket, slot, type, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ slot, type, ...payload }));
}

/**
 * Create a slot manager that multiplexes multiple agent processes over one WS.
 * Each slot gets its own agent process, spawned lazily on first message.
 * Agents survive WS reconnects — stdout is routed to `currentWs`.
 */
function makeSlotManager(copilotCmd, localCwd, WebSocket) {
  let currentWs = null;
  const slots = new Map(); // slot -> ChildProcess
  let draining = false;
  const lastStdoutAt = new Map(); // slot -> timestamp

  function setWs(ws) {
    currentWs = ws;
    if (ws) {
      // Announce our instance ID immediately. seam-acp uses this to detect a
      // bridge restart and evict its stale runtimes before sending new traffic.
      try {
        ws.send(JSON.stringify({ type: "bridge_hello", instanceId: BRIDGE_INSTANCE_ID }));
      } catch { /* ws may not be open yet — best effort */ }
    }
  }

  function getOrSpawnSlot(slot) {
    if (slots.has(slot)) return slots.get(slot);
    if (draining) {
      console.error(`[bridge] Slot ${slot}: drain mode — ignoring new slot spawn`);
      return null;
    }

    console.error(`[bridge] Slot ${slot}: spawning agent`);
    const agent = spawnAgent(copilotCmd, localCwd);
    slots.set(slot, agent);

    agent.stdout.on("data", (chunk) => {
      lastStdoutAt.set(slot, Date.now());
      muxSend(currentWs, WebSocket, slot, "data", { data: chunk.toString("utf8") });
    });

    agent.on("error", (err) => {
      console.error(`[bridge] Slot ${slot} agent error: ${err.message}`);
      slots.delete(slot);
      muxSend(currentWs, WebSocket, slot, "exit", { code: 1 });
    });

    agent.on("exit", (code, signal) => {
      console.error(`[bridge] Slot ${slot} agent exited (code=${code}, signal=${signal})`);
      slots.delete(slot);
      lastStdoutAt.delete(slot);
      muxSend(currentWs, WebSocket, slot, "exit", { code: code ?? 1 });
    });

    return agent;
  }

  function wsSend(payload) {
    if (currentWs && currentWs.readyState === WebSocket.OPEN) {
      currentWs.send(JSON.stringify(payload));
    }
  }

  async function handleCmd(msg) {
    const { cmdId, action } = msg;
    // Rewrite the cwd in session-management payloads to the local path, the
    // same way rewriteCwdInChunk handles it for ACP messages. Without this,
    // listSessions/compactSession/etc. send the seam-acp host's path which
    // never matches rows stored under the remote machine's localCwd.
    const payload = msg.payload && msg.payload.cwd
      ? { ...msg.payload, cwd: localCwd }
      : msg.payload;
    console.error(`[bridge] cmd: ${action} (cmdId=${cmdId}, session-type=${sessionType})`);
    try {
      let result;
      // Route to Claude Code session handlers when --session-type claude is set.
      if (sessionType === "claude") {
        if (action === "listSessions") {
          result = await claudeListSessions(payload.cwd);
        } else if (action === "getTranscript") {
          result = await claudeGetTranscript(payload.cwd, payload.sessionId);
        } else if (action === "deleteSession") {
          await claudeDeleteSession(payload.cwd, payload.sessionId);
          result = null;
        } else if (action === "cloneSession") {
          await claudeCloneSession(payload.cwd, payload.oldSessionId, payload.newSessionId);
          result = null;
        } else if (action === "compactSession") {
          result = await claudeCompactSession(payload.cwd, payload.sessionId, payload.summary);
        } else if (action === "getUsage") {
          result = await claudeGetUsage(payload.cwd, payload.sessionId, payload.newerThanMs);
        } else if (action === "writeAttachment") {
          result = await writeAttachment(payload.cwd, payload.filename, payload.base64);
        } else {
          throw new Error(`Unknown action: ${action}`);
        }
        wsSend({ type: "cmd_reply", cmdId, payload: result });
        return;
      }
      if (action === "listSessions") {
        try {
          await fsp.access(dbPath);
        } catch {
          console.error(`[bridge] listSessions: DB not found at ${dbPath}`);
          wsSend({ type: "cmd_reply", cmdId, payload: [] });
          return;
        }
        // Match sessions by cwd OR by sessions with no cwd (created before the
        // cwd-rewrite fix). The latter covers existing sessions on the remote
        // machine that the Copilot CLI stored without a cwd value.
        const sessions = execSql(
          dbPath,
          `SELECT * FROM sessions WHERE cwd = ${escapeSql(payload.cwd)} OR cwd IS NULL OR cwd = '' ORDER BY updated_at DESC LIMIT 50`
        );
        console.error(`[bridge] listSessions: found ${sessions.length} session(s) for cwd=${payload.cwd}`);
        const summaries = [];
        for (const sess of sessions) {
          const sessionId = sess.id;
          const createdAt = sess.created_at ? Date.parse(sess.created_at) : Date.now();
          const lastActivityAt = sess.updated_at ? Date.parse(sess.updated_at) : Date.now();
          const turns = execSql(
            dbPath,
            `SELECT * FROM turns WHERE session_id = ${escapeSql(sessionId)} ORDER BY turn_index ASC`
          );
          const allMessages = [];
          for (const turn of turns) {
            if (turn.user_message) {
              allMessages.push({ sender: "human", text: turn.user_message });
            }
            if (turn.assistant_response) {
              allMessages.push({ sender: "agent", text: turn.assistant_response });
            }
          }
          let previewLines = [];
          if (allMessages.length <= 16) {
            previewLines = allMessages;
          } else {
            const firstSix = allMessages.slice(0, 6);
            const lastTen = allMessages.slice(-10);
            previewLines = [...firstSix, ...lastTen];
          }
          const transcriptLines = [];
          for (const turn of turns) {
            if (turn.user_message?.trim()) {
              transcriptLines.push(`### User\n${turn.user_message.trim()}`);
            }
            if (turn.assistant_response?.trim()) {
              transcriptLines.push(`### Assistant\n${turn.assistant_response.trim()}`);
            }
          }
          const estimatedTokens = Math.ceil(transcriptLines.join("\n\n").length / 4);

          summaries.push({
            sessionId,
            createdAt,
            lastActivityAt,
            previewLines,
            estimatedTokens,
          });
        }
        result = summaries;
      } else if (action === "cloneSession") {
        const sessions = execSql(
          dbPath,
          `SELECT * FROM sessions WHERE id = ${escapeSql(payload.oldSessionId)}`
        );
        const sessionRow = sessions[0];
        if (sessionRow) {
          const nowIso = new Date().toISOString();
          execSql(
            dbPath,
            `INSERT INTO sessions (id, cwd, repository, host_type, branch, summary, created_at, updated_at)
             VALUES (
               ${escapeSql(payload.newSessionId)},
               ${escapeSql(payload.cwd)},
               ${escapeSql(sessionRow.repository)},
               ${escapeSql(sessionRow.host_type)},
               ${escapeSql(sessionRow.branch)},
               ${escapeSql(sessionRow.summary)},
               ${escapeSql(nowIso)},
               ${escapeSql(nowIso)}
             )`
          );
        }
        const turns = execSql(
          dbPath,
          `SELECT * FROM turns WHERE session_id = ${escapeSql(payload.oldSessionId)} ORDER BY turn_index ASC`
        );
        for (const turn of turns) {
          execSql(
            dbPath,
            `INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
             VALUES (
               ${escapeSql(payload.newSessionId)},
               ${escapeSql(turn.turn_index)},
               ${escapeSql(turn.user_message)},
               ${escapeSql(turn.assistant_response)},
               ${escapeSql(turn.timestamp)}
             )`
          );
        }
        const oldSubDir = path.join(sessionStateDir, payload.oldSessionId);
        const newSubDir = path.join(sessionStateDir, payload.newSessionId);
        try {
          const stat = await fsp.stat(oldSubDir);
          if (stat.isDirectory()) {
            await fsp.mkdir(newSubDir, { recursive: true });
            await fsp.cp(oldSubDir, newSubDir, { recursive: true });
          }
        } catch {
          // ignore
        }
        result = null;
      } else if (action === "deleteSession") {
        execSql(dbPath, `DELETE FROM sessions WHERE id = ${escapeSql(payload.sessionId)}`);
        execSql(dbPath, `DELETE FROM turns WHERE session_id = ${escapeSql(payload.sessionId)}`);
        try {
          execSql(dbPath, `DELETE FROM search_index_content WHERE c1 = ${escapeSql(payload.sessionId)}`);
        } catch {
          // ignore
        }
        const subDir = path.join(sessionStateDir, payload.sessionId);
        try {
          await fsp.rm(subDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        result = null;
      } else if (action === "getTranscript") {
        const turns = execSql(
          dbPath,
          `SELECT * FROM turns WHERE session_id = ${escapeSql(payload.sessionId)} ORDER BY turn_index ASC`
        );
        const transcriptLines = [];
        for (const turn of turns) {
          if (turn.user_message?.trim()) {
            transcriptLines.push(`### User\n${turn.user_message.trim()}`);
          }
          if (turn.assistant_response?.trim()) {
            transcriptLines.push(`### Assistant\n${turn.assistant_response.trim()}`);
          }
        }
        result = transcriptLines.join("\n\n");
      } else if (action === "compactSession") {
        const nowIso = new Date().toISOString();
        execSql(
          dbPath,
          `INSERT INTO sessions (id, cwd, updated_at) 
           VALUES (${escapeSql(payload.sessionId)}, ${escapeSql(payload.cwd)}, ${escapeSql(nowIso)}) 
           ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
        );
        execSql(dbPath, `DELETE FROM turns WHERE session_id = ${escapeSql(payload.sessionId)}`);
        execSql(
          dbPath,
          `INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
           VALUES (
             ${escapeSql(payload.sessionId)},
             0,
             ${escapeSql("[Session history compacted due to context limits]")},
             ${escapeSql(payload.summary)},
             ${escapeSql(nowIso)}
           )`
        );
        execSql(
          dbPath,
          `UPDATE sessions SET updated_at = ${escapeSql(nowIso)} WHERE id = ${escapeSql(payload.sessionId)}`
        );
        result = null;
      } else if (action === "listSlots") {
        // Returns the slot IDs of currently-active agent processes so the
        // seam-acp side can detect and evict stale slots on reconnect.
        result = { slots: [...slots.keys()] };
      } else if (action === "writeAttachment") {
        result = await writeAttachment(payload.cwd, payload.filename, payload.base64);
      } else {
        throw new Error(`Unknown action: ${action}`);
      }
      wsSend({ type: "cmd_reply", cmdId, payload: result });
    } catch (err) {
      console.error(`[bridge] Error handling cmd ${action}:`, err);
      wsSend({ type: "cmd_reply", cmdId, error: err.message });
    }
  }

  function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "data" && msg.data !== undefined) {
      const agent = getOrSpawnSlot(msg.slot);
      if (agent && !agent.killed) {
        agent.stdin.write(rewriteCwdInChunk(msg.data, localCwd));
      }
    } else if (msg.type === "kill") {
      const agent = slots.get(msg.slot);
      if (agent) {
        console.error(`[bridge] Slot ${msg.slot}: kill received — terminating agent`);
        agent.kill();
        slots.delete(msg.slot);
      }
    } else if (msg.type === "cmd") {
      handleCmd(msg);
    }
  }

  function drain() {
    if (draining) return;
    draining = true;

    if (slots.size === 0) {
      console.error("[bridge] Drain complete (no active slots) — exiting for restart");
      process.exit(0);
    }

    console.error(`[bridge] Drain mode entered — waiting for ${slots.size} active slot(s) to go idle`);

    const IDLE_SILENCE_MS = 10_000;
    const POLL_INTERVAL_MS = 2_000;
    const HARD_TIMEOUT_MS = 5 * 60 * 1_000;
    const deadline = Date.now() + HARD_TIMEOUT_MS;

    const timer = setInterval(() => {
      const now = Date.now();
      if (now >= deadline) {
        clearInterval(timer);
        console.error("[bridge] Drain hard timeout reached — forcing exit for restart");
        process.exit(0);
      }

      if (slots.size === 0) {
        clearInterval(timer);
        console.error("[bridge] Drain complete — exiting for restart");
        process.exit(0);
      }

      const allIdle = [...slots.keys()].every((slot) => {
        const last = lastStdoutAt.get(slot) ?? 0;
        return now - last >= IDLE_SILENCE_MS;
      });

      if (allIdle) {
        clearInterval(timer);
        console.error("[bridge] Drain complete — exiting for restart");
        process.exit(0);
      }

      const remaining = [...slots.keys()].filter((slot) => {
        const last = lastStdoutAt.get(slot) ?? 0;
        return now - last < IDLE_SILENCE_MS;
      });
      console.error(`[bridge] Draining — ${remaining.length} slot(s) still active`);
    }, POLL_INTERVAL_MS);
  }

  return { setWs, handleMessage, drain };
}

async function runClientMode(wsUrl, token, copilotCmd, localCwd) {
  const { WebSocket } = await loadWs();
  const mgr = makeSlotManager(copilotCmd, localCwd, WebSocket);
  activeMgr = mgr;

  function connect() {
    console.error(`[bridge] Connecting to ${wsUrl} ...`);
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    ws.on("open", () => {
      console.error("[bridge] Connected.");
      mgr.setWs(ws);

      const keepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, KEEPALIVE_PING_MS);
      ws.once("close", () => clearInterval(keepalive));
    });

    ws.on("message", (raw) => mgr.handleMessage(raw));

    ws.on("close", (code, reason) => {
      mgr.setWs(null);
      console.error(`[bridge] Disconnected (code=${code}, reason=${reason || "(none)"})`);
      if (code !== 4001) {
        console.error(`[bridge] Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
        setTimeout(connect, RECONNECT_DELAY_MS);
      } else {
        console.error("[bridge] Authentication failed — check your token.");
        process.exit(1);
      }
    });

    ws.on("error", (err) => {
      console.error(`[bridge] WebSocket error: ${err.message}`);
    });
  }

  connect();
}

async function runServerMode(port, token, copilotCmd, localCwd) {
  const { WebSocket, WebSocketServer } = await loadWs();
  const mgr = makeSlotManager(copilotCmd, localCwd, WebSocket);
  activeMgr = mgr;

  const wss = new WebSocketServer({ port });

  wss.on("listening", () => {
    console.error(`[bridge] Listening on ws://localhost:${port}`);
    console.error(`[bridge] Expose with: cloudflared tunnel --url ws://localhost:${port}`);
  });

  wss.on("connection", (ws, req) => {
    const auth = req.headers["authorization"];
    if (!auth || auth !== `Bearer ${token}`) {
      console.error("[bridge] Rejected connection: bad token");
      ws.close(4001, "unauthorized");
      return;
    }
    console.error("[bridge] seam-acp connected.");
    mgr.setWs(ws);

    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, KEEPALIVE_PING_MS);
    ws.once("close", () => clearInterval(keepalive));

    ws.on("message", (raw) => mgr.handleMessage(raw));

    ws.on("close", () => {
      mgr.setWs(null);
      console.error("[bridge] seam-acp disconnected.");
    });
  });

  wss.on("error", (err) => {
    console.error(`[bridge] Server error: ${err.message}`);
    process.exit(1);
  });
}

// ─── Argument parsing ────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);

/** Extract a named flag + its value from rawArgs in-place. Returns value or null. */
function extractFlag(flag) {
  const idx = rawArgs.indexOf(flag);
  if (idx === -1) return null;
  const val = rawArgs[idx + 1];
  if (!val || val.startsWith("-")) {
    console.error(`Error: ${flag} requires a value argument`);
    process.exit(1);
  }
  rawArgs.splice(idx, 2);
  return val;
}

// Extract all named flags before touching positional args.
const cwdArg = extractFlag("--cwd");
const gistArg = extractFlag("--gist");
const sessionTypeArg = extractFlag("--session-type"); // "copilot" (default) or "claude"

let localCwd = cwdArg ? cwdArg.replace(/^~/, homedir()) : process.cwd();
const sessionType = sessionTypeArg ?? "claude";

console.error(`[bridge] Local cwd: ${localCwd}`);

/**
 * Resolve a WebSocket URL from a GitHub Gist.
 * Accepts "owner/gistId" and fetches the raw content directly from
 * gist.githubusercontent.com — no API call, no rate limits.
 */
async function resolveUrlFromGist(ownerAndId) {
  const parts = ownerAndId.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    console.error(`[bridge] --gist must be in "owner/gistId" format, got: ${ownerAndId}`);
    process.exit(1);
  }
  const [owner, gistId] = parts;
  const rawUrl = `https://gist.githubusercontent.com/${owner}/${gistId}/raw/tunnel-url.txt`;
  console.error(`[bridge] Fetching tunnel URL from gist …`);
  const res = await fetch(rawUrl, { headers: { "User-Agent": "seam-acp-bridge" } });
  if (!res.ok) {
    console.error(`[bridge] Failed to fetch gist content: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const url = (await res.text()).trim();
  if (!url.startsWith("wss://")) {
    console.error(`[bridge] Unexpected URL in gist: ${url}`);
    process.exit(1);
  }
  console.error(`[bridge] Resolved tunnel URL: ${url}`);
  return url;
}

// Set by runClientMode / runServerMode so the signal handler can reach the mgr.
let activeMgr = null;

process.on("SIGUSR2", () => {
  console.error("[bridge] SIGUSR2 received — entering drain mode");
  if (activeMgr) {
    activeMgr.drain();
  } else {
    console.error("[bridge] No active slot manager — exiting immediately");
    process.exit(0);
  }
});

if (rawArgs[0] === "--server") {
  const port = Number(rawArgs[1]);
  const token = rawArgs[2];
  const copilotCmd = process.env.COPILOT_CMD ?? rawArgs[3] ?? "copilot";

  if (!port || !token) {
    console.error("Usage: node remote-agent-bridge.mjs --server <port> <token> [--cwd <path>] [copilot-cmd]");
    process.exit(1);
  }

  runServerMode(port, token, copilotCmd, localCwd);
} else {
  // wsUrl may come from --gist flag or as a positional arg.
  const wsUrlPositional = rawArgs[0];
  const token = rawArgs[1];
  const copilotCmd = process.env.COPILOT_CMD ?? rawArgs[2] ?? "copilot";

  if (!token && !gistArg) {
    console.error("Usage: node remote-agent-bridge.mjs [--gist <owner/gistId>] <ws-url> <token> [--cwd <path>] [copilot-cmd]");
    console.error("       node remote-agent-bridge.mjs --server <port> <token> [--cwd <path>] [copilot-cmd]");
    process.exit(1);
  }

  if (gistArg) {
    // When --gist is provided the positional arg order shifts: token is first.
    const tokenFromArg = rawArgs[0];
    const copilotCmdFromArg = process.env.COPILOT_CMD ?? rawArgs[1] ?? "copilot";
    if (!tokenFromArg) {
      console.error("Usage: node remote-agent-bridge.mjs --gist <owner/gistId> <token> [--cwd <path>] [copilot-cmd]");
      process.exit(1);
    }
    resolveUrlFromGist(gistArg).then((wsUrl) => {
      runClientMode(wsUrl, tokenFromArg, copilotCmdFromArg, localCwd);
    });
  } else {
    if (!wsUrlPositional || !token) {
      console.error("Usage: node remote-agent-bridge.mjs <ws-url> <token> [--cwd <path>] [copilot-cmd]");
      console.error("       node remote-agent-bridge.mjs --server <port> <token> [--cwd <path>] [copilot-cmd]");
      process.exit(1);
    }
    runClientMode(wsUrlPositional, token, copilotCmd, localCwd);
  }
}
