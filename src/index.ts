import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { loadConfig, REMOTE_MAC_MODELS, CODEX_STATIC_MODELS, GROK_STATIC_MODELS, ZAI_STATIC_MODELS, OLLAMA_CLOUD_STATIC_MODELS } from "./config.js";
import { logger } from "./lib/logger.js";
import { startHealthServer } from "./lib/health.js";
import { SessionStore } from "./core/session-store.js";
import { SessionRouter } from "./core/session-router.js";
import { ChoiceBroker } from "./core/choice-broker.js";
import { makeCopilotProfile } from "./agents/profiles/copilot.js";
import { makeClaudeProfile } from "./agents/profiles/claude.js";
import { makeAgyProfile } from "./agents/profiles/agy.js";
import { makeOpencodeProfile, fetchLmStudioModels, syncOpencodeLmStudioConfig } from "./agents/profiles/opencode.js";
import { makeCodexProfile } from "./agents/profiles/codex.js";
import { makeGrokProfile, fetchXaiModels } from "./agents/profiles/grok.js";
import { makeRemoteCopilotServerProfile, makeRemoteCopilotClientProfile } from "./agents/profiles/remote.js";
import { discordRenderer } from "./platforms/discord/renderer.js";
import { DiscordAdapter } from "./platforms/discord/adapter.js";
import { Orchestrator } from "./platforms/discord/orchestrator.js";
import { buildGlobalMcpServers } from "./mcp.js";
import { startTunnelGistPublisher } from "./lib/tunnel-gist.js";
import { ScheduledPromptManager } from "./core/scheduled-prompts/manager.js";

/**
 * Whether a CLI is runnable — an existing path, or a bare command resolvable on
 * PATH. Used to load an agent profile only when its CLI is actually installed,
 * so a Copilot-only host doesn't crash warming up another agent (e.g. agy's
 * catalog probe throws an unhandled spawn ENOENT when `agy` is absent).
 */
function commandExists(bin: string | undefined): boolean {
  const b = bin?.trim();
  if (!b) return false;
  if (b.includes("/") || b.includes("\\")) return fs.existsSync(b);
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    return spawnSync(finder, [b], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`[BOOT] Loaded REPO_EMOJIS with ${config.REPO_EMOJIS.size} entries.`);
  logger.info(
    {
      agent: config.DEFAULT_AGENT,
      model: config.DEFAULT_MODEL,
      reposRoot: config.REPOS_ROOT,
      dataDir: config.DATA_DIR,
    },
    "seam-acp starting"
  );

  const health = startHealthServer(config.HEALTH_PORT, logger);

  const store = new SessionStore(path.join(config.DATA_DIR, "seam.db"));

  const { servers: mcpServers } = buildGlobalMcpServers(logger, {
    dataDir: config.DATA_DIR,
  });

  const copilot = makeCopilotProfile({
    ...(config.COPILOT_CLI_PATH ? { cliPath: config.COPILOT_CLI_PATH } : {}),
    defaultModel: config.DEFAULT_MODEL,
    staticModels: config.COPILOT_MODELS,
    threadAbbr: "🤖🛢️",
    mcpServers,
  });

  const extraCopilots = config.COPILOT_PROFILES.map((p) =>
    makeCopilotProfile({
      id: `copilot-${p.id}`,
      displayName: `GitHub Copilot (${p.id})`,
      configDir: p.configDir,
      ...(config.COPILOT_CLI_PATH ? { cliPath: config.COPILOT_CLI_PATH } : {}),
      defaultModel: config.DEFAULT_MODEL,
      staticModels: config.COPILOT_MODELS,
      threadAbbr: p.id === "jbulpitt" ? "🤖 👨‍💻" : "🤖",
      mcpServers,
    })
  );

  const claude = commandExists(config.CLAUDE_CLI_PATH || "claude-agent-acp")
    ? makeClaudeProfile({
        ...(config.CLAUDE_CLI_PATH ? { cliPath: config.CLAUDE_CLI_PATH } : {}),
        defaultModel: config.CLAUDE_DEFAULT_MODEL,
        staticModels: config.CLAUDE_MODELS,
        threadAbbr: "👾",
        maxThinkingTokens: config.CLAUDE_MAX_THINKING_TOKENS,
        thinkingDisplay: config.CLAUDE_THINKING_DISPLAY,
        compactionTokenThreshold: config.CLAUDE_COMPACTION_TOKEN_THRESHOLD,
        mcpServers,
      })
    : undefined;

  const extraClaudes = config.CLAUDE_PROFILES.map((p) =>
    makeClaudeProfile({
      id: `claude-${p.id}`,
      displayName: `Anthropic Claude (${p.id})`,
      configDir: p.configDir,
      ...(config.CLAUDE_CLI_PATH ? { cliPath: config.CLAUDE_CLI_PATH } : {}),
      defaultModel: config.CLAUDE_DEFAULT_MODEL,
      staticModels: config.CLAUDE_MODELS,
      maxThinkingTokens: config.CLAUDE_MAX_THINKING_TOKENS,
      thinkingDisplay: config.CLAUDE_THINKING_DISPLAY,
      compactionTokenThreshold: config.CLAUDE_COMPACTION_TOKEN_THRESHOLD,
      mcpServers,
    })
  );

  // Optional Vertex AI Claude profile: same claude-agent-acp binary, but with
  // CLAUDE_CODE_USE_VERTEX=1 and GCP project/region injected per-spawn so the
  // standard `claude` profile stays on the direct Anthropic API.
  const claudeVertex = config.CLAUDE_VERTEX_PROJECT_ID
    ? makeClaudeProfile({
        id: "claude-vertex",
        displayName: "Claude (Vertex AI)",
        ...(config.CLAUDE_CLI_PATH ? { cliPath: config.CLAUDE_CLI_PATH } : {}),
        defaultModel: config.CLAUDE_DEFAULT_MODEL,
        staticModels: config.CLAUDE_MODELS,
        threadAbbr: "👾☁️",
        maxThinkingTokens: config.CLAUDE_MAX_THINKING_TOKENS,
        thinkingDisplay: config.CLAUDE_THINKING_DISPLAY,
        compactionTokenThreshold: config.CLAUDE_COMPACTION_TOKEN_THRESHOLD,
        mcpServers,
        extraEnv: {
          CLAUDE_CODE_USE_VERTEX: "1",
          ANTHROPIC_VERTEX_PROJECT_ID: config.CLAUDE_VERTEX_PROJECT_ID,
          CLOUD_ML_REGION: config.CLAUDE_VERTEX_REGION,
        },
      })
    : undefined;

  const agy = commandExists(config.AGY_CLI_PATH || "agy")
    ? makeAgyProfile({
        ...(config.AGY_CLI_PATH ? { cliPath: config.AGY_CLI_PATH } : {}),
        defaultModel: config.AGY_DEFAULT_MODEL,
        staticModels: config.AGY_MODELS,
        threadAbbr: "🌌",
        dataDir: config.DATA_DIR,
        printTimeoutSeconds: config.TURN_TIMEOUT_SECONDS,
      })
    : undefined;

  // Optional OpenAI Codex agent via @agentclientprotocol/codex-acp.
  const codex = config.CODEX_ENABLED
    ? makeCodexProfile({
        ...(config.CODEX_CLI_PATH ? { cliPath: config.CODEX_CLI_PATH } : {}),
        defaultModel: config.CODEX_DEFAULT_MODEL,
        staticModels: config.CODEX_MODELS ?? CODEX_STATIC_MODELS,
        threadAbbr: "🧬",
      })
    : undefined;

  // Optional xAI Grok Build agent — speaks ACP natively via `grok agent stdio`.
  // When GROK_API_KEY is set and no explicit GROK_MODELS override, discover the
  // live model list from xAI's /v1/models endpoint so the picker stays current.
  let grokModels: Array<{ modelId: string; name: string; contextLimit?: number }> | undefined;
  if (config.GROK_ENABLED && !config.GROK_MODELS && config.GROK_API_KEY) {
    const discovered = await fetchXaiModels(config.GROK_API_KEY).catch((err) => {
      logger.warn({ err }, "grok: xAI model discovery failed; using static list");
      return [];
    });
    if (discovered.length > 0) {
      grokModels = discovered;
      logger.info({ count: discovered.length }, "grok: discovered xAI models");
    }
  }
  const grok = config.GROK_ENABLED
    ? makeGrokProfile({
        ...(config.GROK_CLI_PATH ? { cliPath: config.GROK_CLI_PATH } : {}),
        defaultModel: config.GROK_DEFAULT_MODEL,
        staticModels: config.GROK_MODELS ?? grokModels ?? GROK_STATIC_MODELS,
        threadAbbr: "🪐",
        ...(config.GROK_API_KEY ? { extraEnv: { XAI_API_KEY: config.GROK_API_KEY } } : {}),
      })
    : undefined;

  // Optional Z.ai (Zhipu) agent: Claude Code (claude-agent-acp) pointed at Z.ai's
  // Anthropic-compatible endpoint.  Uses GLM models (glm-5.2 flagship, 1M context).
  // Only registered when ZAI_ENABLED and ZAI_API_KEY are set.
  const zai = config.ZAI_ENABLED && config.ZAI_API_KEY
    ? makeClaudeProfile({
        id: "zai",
        displayName: "Z.ai (Zhipu GLM)",
        defaultModel: config.ZAI_DEFAULT_MODEL,
        staticModels: config.ZAI_MODELS ?? ZAI_STATIC_MODELS,
        threadAbbr: "🀄",
        // GLM models don't support Anthropic's effort mechanism.
        effort: { mechanism: "none" as const, levels: [] },
        extraEnv: {
          ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
          ANTHROPIC_API_KEY: config.ZAI_API_KEY,
        },
      })
    : undefined;

  // Optional Ollama Cloud agent: Claude Code (claude-agent-acp) pointed at
  // Ollama's Anthropic-compatible endpoint.  Runs open-weight models
  // (qwen3-coder 480B, deepseek-v3.1 671B, etc.) on Ollama's cloud GPUs.
  // Only registered when OLLAMA_CLOUD_ENABLED and OLLAMA_CLOUD_API_KEY are set.
  const ollamaCloud = config.OLLAMA_CLOUD_ENABLED && config.OLLAMA_CLOUD_API_KEY
    ? makeClaudeProfile({
        id: "ollama-cloud",
        displayName: "Ollama Cloud",
        defaultModel: config.OLLAMA_CLOUD_DEFAULT_MODEL,
        staticModels: config.OLLAMA_CLOUD_MODELS ?? OLLAMA_CLOUD_STATIC_MODELS,
        configDir: path.join(process.env.HOME ?? "", ".claude-ollama-cloud"),
        threadAbbr: "🦙☁️",
        // Open-weight models don't support Anthropic's effort mechanism.
        effort: { mechanism: "none" as const, levels: [] },
        extraEnv: {
          ANTHROPIC_BASE_URL: "https://ollama.com",
          // Ollama Cloud expects Authorization: Bearer — ANTHROPIC_AUTH_TOKEN
          // sends the key as a Bearer token; ANTHROPIC_API_KEY would send it
          // via x-api-key which Ollama rejects (401).
          ANTHROPIC_AUTH_TOKEN: config.OLLAMA_CLOUD_API_KEY,
          // Remap claude-agent-acp's internal model aliases so it doesn't try
          // to resolve "claude-sonnet-5" etc. against Ollama's endpoint.
          ANTHROPIC_DEFAULT_SONNET_MODEL: config.OLLAMA_CLOUD_DEFAULT_MODEL,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: config.OLLAMA_CLOUD_DEFAULT_MODEL,
          ANTHROPIC_DEFAULT_OPUS_MODEL: config.OLLAMA_CLOUD_DEFAULT_MODEL,
          ANTHROPIC_MODEL: config.OLLAMA_CLOUD_DEFAULT_MODEL,
        },
      })
    : undefined;

  // Optional "LM Studio 🦙" agent: opencode (sst/opencode) over ACP, pointed at a
  // local/remote LM Studio via opencode's own config. Provider-agnostic, so it
  // drives local models natively — no Anthropic proxy. The model list is
  // discovered live from LM Studio's /api/v0/models at startup (no hardcoding),
  // and seam-acp writes the matching `models` block into opencode's config —
  // opencode does NOT auto-discover custom providers, so the declared list must
  // track what the server serves. Only registered when OPENCODE_ENABLED.
  let opencodeModels: Array<{ modelId: string; name: string; contextLimit?: number }> | undefined;
  let opencodeDefaultModel = config.OPENCODE_DEFAULT_MODEL;
  if (config.OPENCODE_ENABLED && config.OPENCODE_LMSTUDIO_URL) {
    const discovered = await fetchLmStudioModels(
      config.OPENCODE_LMSTUDIO_URL,
      config.OPENCODE_LMSTUDIO_API_KEY || undefined,
      config.OPENCODE_MODEL_PREFIX,
    ).catch((err) => {
      logger.warn({ err }, "opencode: LM Studio model discovery failed; picker empty until reachable");
      return [];
    });
    if (discovered.length > 0) {
      const opencodeConfigPath =
        config.OPENCODE_CONFIG_PATH ||
        path.join(
          process.env.XDG_CONFIG_HOME || path.join(process.env.HOME ?? "", ".config"),
          "opencode",
          "opencode.json",
        );
      // Pick a real, loaded default so opencode never falls back to its built-in
      // `big-pickle` (no vision): the configured default if it's actually loaded,
      // else the first discovered model.
      opencodeDefaultModel =
        discovered.find((m) => m.modelId === config.OPENCODE_DEFAULT_MODEL)?.modelId ??
        discovered[0]!.modelId;
      // Web-search MCP(s) for the agent. seam-acp manages these keys, reconciling on
      // each sync (disabling a source removes its entry).
      const opencodeMcp: Record<string, unknown> = {};
      if (config.OPENCODE_DDG_SEARCH) {
        opencodeMcp["ddg-search"] = {
          type: "local",
          command: ["npx", "-y", "@oevortex/ddg_search"],
          enabled: true,
          timeout: 20000,
        };
      }
      if (config.OPENCODE_TAVILY_URL) {
        opencodeMcp["tavily"] = { type: "remote", url: config.OPENCODE_TAVILY_URL, enabled: true };
      }
      await syncOpencodeLmStudioConfig({
        configPath: opencodeConfigPath,
        providerKey: config.OPENCODE_MODEL_PREFIX,
        baseURL: config.OPENCODE_LMSTUDIO_URL.replace(/\/+$/, "") + "/v1",
        ...(config.OPENCODE_LMSTUDIO_API_KEY ? { apiKey: config.OPENCODE_LMSTUDIO_API_KEY } : {}),
        defaultModel: opencodeDefaultModel,
        mcp: opencodeMcp,
        mcpManagedKeys: ["ddg-search", "tavily"],
        models: discovered.map((m) => ({
          rawId: m.rawId,
          ...(m.attachment ? { attachment: true } : {}),
          ...(m.toolCall ? { toolCall: true } : {}),
          ...(m.reasoning ? { reasoning: true } : {}),
        })),
      }).catch((err) => logger.warn({ err }, "opencode: config sync failed"));
      opencodeModels = discovered.map(({ modelId, name, contextLimit }) => ({
        modelId,
        name,
        ...(contextLimit ? { contextLimit } : {}),
      }));
    }
    logger.info({ count: discovered.length }, "opencode: discovered LM Studio models");
  }
  const ollama = config.OPENCODE_ENABLED
    ? makeOpencodeProfile({
        id: "opencode",
        displayName: "LM Studio 🔮",
        threadAbbr: "🔮",
        ...(config.OPENCODE_CLI_PATH ? { cliPath: config.OPENCODE_CLI_PATH } : {}),
        defaultModel: opencodeDefaultModel,
        ...(opencodeModels && opencodeModels.length > 0 ? { staticModels: opencodeModels } : {}),
      })
    : undefined;

  // Late-bound so the callback can reference `orchestrator` which isn't created yet.
  let notifyBridgeConnect: (id: string) => void = () => {};

  const remoteCopilots = config.REMOTE_COPILOT_PROFILES.map((p) =>
    p.mode === "server"
      ? makeRemoteCopilotServerProfile({
          id: `copilot-remote-${p.id}`,
          wsPort: p.wsPort,
          token: p.token,
          defaultModel: p.defaultModel ?? config.DEFAULT_MODEL,
          staticModels: p.id === "mac" ? REMOTE_MAC_MODELS : config.COPILOT_MODELS,
          threadAbbr: "🤖 💳",
          restrictDiscordAccess: config.REMOTE_DISCORD_RESTRICTED_PROFILES.has(p.id),
          onBridgeConnect: () => notifyBridgeConnect(`copilot-remote-${p.id}`),
        })
      : makeRemoteCopilotClientProfile({
          id: `copilot-remote-${p.id}`,
          wsUrl: p.wsUrl,
          token: p.token,
          defaultModel: p.defaultModel ?? config.DEFAULT_MODEL,
          staticModels: p.id === "mac" ? REMOTE_MAC_MODELS : config.COPILOT_MODELS,
          threadAbbr: "🤖 💳",
          restrictDiscordAccess: config.REMOTE_DISCORD_RESTRICTED_PROFILES.has(p.id),
          onBridgeConnect: () => notifyBridgeConnect(`copilot-remote-${p.id}`),
        })
  );

  const router = new SessionRouter({
    logger,
    store,
    profiles: [copilot, ...extraCopilots, ...(claude ? [claude] : []), ...extraClaudes, ...(claudeVertex ? [claudeVertex] : []), ...(agy ? [agy] : []), ...(codex ? [codex] : []), ...(grok ? [grok] : []), ...(zai ? [zai] : []), ...(ollamaCloud ? [ollamaCloud] : []), ...(ollama ? [ollama] : []), ...remoteCopilots],
    defaultAgentId: config.DEFAULT_AGENT,
    defaultModel: config.DEFAULT_MODEL,
    // Legacy DEFAULT_AUTO_APPROVE=true overrides the policy default to "always".
    defaultPermissionMode: config.DEFAULT_AUTO_APPROVE
      ? "always"
      : config.DEFAULT_PERMISSION_POLICY,
    mcpServers,
  });

  const renderer = discordRenderer;

  const adapter: DiscordAdapter = new DiscordAdapter({
    config,
    logger,
    slashHandler: async (interaction) => {
      await orchestrator.handleSlashInteraction(interaction);
    },
    autocompleteHandler: async (interaction) => {
      await orchestrator.handleAutocomplete(interaction);
    },
  });

  const orchestrator = new Orchestrator({
    logger,
    config,
    adapter,
    router,
    store,
    renderer,
  });

  orchestrator.install();

  // Now that orchestrator exists, wire the bridge-connect notification callback.
  notifyBridgeConnect = (id) =>
    void orchestrator.postNotification(`🟢 Remote bridge connected: ${id}`);

  // Wire the ask-the-user callback now that both the router and the adapter
  // exist. Router calls this when a session's policy is "ask".
  router.setAskUser(async (record, req) => {
    if (!adapter.requestApproval) {
      return { outcome: { outcome: "cancelled" } };
    }
    const channel = {
      platform: record.platform,
      id: record.channelRef,
      ...(record.parentRef ? { parentId: record.parentRef } : {}),
    };
    return adapter.requestApproval(channel, req);
  });

  // Wire the interactive ask_user broker. The per-session ask_user MCP server
  // (injected into each Copilot spawn) POSTs the model's question here; we
  // present it as a Discord picker in that session's thread and return the
  // chosen answer. Loopback + per-session bearer token; see ChoiceBroker.
  const choiceBroker = new ChoiceBroker({
    logger,
    timeoutMs: 6 * 60 * 1000,
    presenter: async (key, prompt) => {
      const record = store.get(key);
      if (!record) return { status: "error", error: "session not found" };
      if (prompt.options.length === 0) {
        // Nothing to render as buttons — let the model ask in prose instead.
        return { status: "error", error: "no options provided" };
      }
      const channel = {
        platform: record.platform,
        id: record.channelRef,
        ...(record.parentRef ? { parentId: record.parentRef } : {}),
      };
      const picked = await adapter.sendChoicePicker(channel, {
        prompt: prompt.question,
        choices: prompt.options.map((o) => ({
          value: o.optionId,
          label: o.label,
          ...(o.description ? { description: o.description } : {}),
        })),
        authorizedUserIds: config.DISCORD_ALLOWED_USER_IDS,
      });
      if (!picked) return { status: "timed_out" };
      const opt = prompt.options.find((o) => o.optionId === picked.value);
      return {
        status: "selected",
        optionId: picked.value,
        ...(opt ? { label: opt.label } : {}),
      };
    },
  });
  await choiceBroker.start();
  router.setChoiceBroker(choiceBroker);

  await adapter.start();

  // Scheduled prompts: arm timers from the DB once Discord is connected (so a
  // catch-up fire can post immediately). onFire runs the schedule as an isolated
  // job and posts output to the thread.
  const scheduledManager = new ScheduledPromptManager({
    store,
    logger: logger.child({ mod: "scheduled" }),
    onFire: (id) => orchestrator.runScheduledPrompt(id),
  });
  orchestrator.setScheduledManager(scheduledManager);
  scheduledManager.start();

  logger.info("seam-acp ready");

  // Best-effort startup notification to a configured channel.
  void orchestrator.postNotification("✅ Seam online.");

  // Publish quick-tunnel URL to gist whenever it changes.
  let stopTunnelGist: (() => void) | undefined;
  if (config.TUNNEL_GIST_ID) {
    const urlFile = path.join(config.DATA_DIR, "tunnel-url.txt");
    stopTunnelGist = startTunnelGistPublisher(config.TUNNEL_GIST_ID, urlFile, logger);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    orchestrator.stopSentinelWatcher();
    scheduledManager.stop();
    stopTunnelGist?.();
    try {
      await adapter.stop();
    } catch (err) {
      logger.warn({ err }, "adapter stop failed");
    }
    try {
      await choiceBroker.stop();
    } catch (err) {
      logger.warn({ err }, "choice-broker stop failed");
    }
    try {
      await router.disposeAll();
    } catch (err) {
      logger.warn({ err }, "router disposeAll failed");
    }
    try {
      store.close();
    } catch {
      /* ignore */
    }
    health.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err }, "fatal startup error");
  process.exit(1);
});
