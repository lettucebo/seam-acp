import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { MessageFlags, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, type ChatInputCommandInteraction, type AutocompleteInteraction, type MessageComponentInteraction, type Message } from "discord.js";
import {
  IMAGE_MODELS,
  getImageModelById,
  generateImage,
  resolveGoogleApiKey,
  type AspectRatio,
  type ImageModel,
  type ReferenceImage,
  type Resolution,
} from "../../core/image-gen.js";
import type { Logger } from "../../lib/logger.js";
import type { Config } from "../../config.js";
import type { Renderer } from "../renderer.js";
import { serializePanelText } from "../renderer.js";
import { chunkMarkdownForDiscord, unwrapMarkdownCodeFences } from "../../core/text-chunker.js";
import type {
  ChatAdapter,
  ChannelRef,
  IncomingMessage,
  MessageRef,
  MessageAttachment,
  SessionRecord,
} from "../chat-adapter.js";
import { AgentRuntime, type AgentEventHandler, type PromptOutcome } from "../../agents/agent-runtime.js";
import { cleanTextForPreview, type SessionSummary, type SessionSummaryLine, type ISessionManager } from "../../agents/session-manager.js";
import { readRichHistory, renderHistory, type HistoryEvent, type RichHistory } from "../../core/compaction/source-reader.js";
import { analyzeSessionCoverage, detectGaps, type TimeRange, type GapReport } from "../../core/compaction/gap-detector.js";
import { runPremiumCompaction, type PremiumCompactionResult, type RunAgent } from "../../core/compaction/pipeline.js";
import { pinnedFactsPrompt, parseJsonOutput, mergePinnedFacts, assembleNewSession, type PinnedFacts } from "../../core/compaction/prompts.js";
import type { AgentProfile } from "../../agents/agent-profile.js";
import type { ScheduledPromptManager } from "../../core/scheduled-prompts/manager.js";
import type { ScheduledPrompt } from "../../core/scheduled-prompts/types.js";
import {
  loadScheduledAttachments,
  deleteScheduledAttachmentDir,
  saveScheduledAttachment,
  deleteScheduledAttachment,
} from "../../core/scheduled-prompts/attachments.js";
import { describeCron, validateCron, nextRun as cronNextRun } from "../../core/scheduled-prompts/cron.js";

/** Accent color for scheduled-prompt cards ("cron blue"). */
const SCHEDULED_COLOR = 0x3498db;

const SCHEDULE_DEFAULT_TZ = "America/Chicago";
const SCHEDULE_TIMEZONES = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
];
/** Common-cadence presets for the builder card; value is a full cron or the
 *  sentinel for the custom-cron modal. */
const SCHEDULE_PRESETS: Array<{ label: string; value: string }> = [
  { label: "Every day at 9:00 AM", value: "0 9 * * *" },
  { label: "Weekdays at 9:00 AM", value: "0 9 * * 1-5" },
  { label: "Every Monday at 9:00 AM", value: "0 9 * * 1" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Custom cron…", value: "__custom__" },
];
import type { SessionStore } from "../../core/session-store.js";
import { SessionRouter } from "../../core/session-router.js";
import { TurnStatus, renderStatusPanel } from "../../core/status-panel.js";
import { isWithinRoot, resolveRepoPath, resolveRepoWithinRoot } from "../../core/path-utils.js";
import { RepoProvisioner } from "../../core/repo-provisioner.js";
import { ATTACH_FENCE_LANG, withHarnessPreamble } from "../../core/agent-conventions.js";
import { isModelInlineableAttachment } from "../../agents/attachments.js";
import { stageAttachment, sweepStagedAttachments } from "../../agents/attachment-staging.js";
import { splitForFlush } from "../../core/stream-flush.js";
import { FenceStream, type CompletedFence } from "../../core/fence-stream.js";
import { SerialQueue } from "../../core/serial-queue.js";
import { mimeTypeForFilename } from "../../core/fence-mime.js";
import {
  defaultSessionConfig,
  type SessionConfigState,
  type StructuredPanel,
} from "../../core/types.js";
import type { DiscordAdapter } from "./adapter.js";

const STATUS_EDIT_DEBOUNCE_MS = 2500;
const STATUS_HEARTBEAT_MS = 5000;
const PLATFORM = "discord";

/** Reasoning-effort options for the `/seam effort` picker. Mirror of the SDK's
 *  EffortLevel type — keep in sync with commands.ts and the bundled SDK
 *  (docs/model-management-runbook.md §11). `ultra` is not in the SDK. */
const EFFORT_CHOICES = [
  { value: "low", label: "Low", description: "Fastest, least reasoning" },
  { value: "medium", label: "Medium", description: "Light reasoning" },
  { value: "high", label: "High", description: "Default for most models" },
  { value: "xhigh", label: "X-High", description: "Deeper reasoning (Opus 4.7+)" },
  { value: "max", label: "Max", description: "Maximum reasoning depth" },
];
// Maximum total size of an inline-rendered fence message
// (```lang\n...\n``` plus optional notice). Fences whose rendered
// inline form would exceed this are uploaded as attachments instead.
// Discord's hard limit per message is 2000 chars; 1900 leaves headroom
// for the optional `_(notice)_` paragraph and a tiny safety margin.
const ORCH_INLINE_FENCE_MAX = 1900;

/**
 * Glues the Discord adapter, the SessionRouter, and the agent runtimes
 * together. Handles incoming thread messages and `/seam` slash commands.
 */
export class Orchestrator {
  private readonly logger: Logger;
  private readonly config: Config;
  private readonly adapter: ChatAdapter;
  private readonly router: SessionRouter;
  private readonly store: SessionStore;
  private readonly renderer: Renderer;

  private activeTurns = 0;
  private restartPending = false;
  private readonly channelQueues = new Map<string, Promise<void>>();
  private readonly channelGenerations = new Map<string, number>();
  /** Per-session timers that settle a woken "Working" card back to "Monitoring"
   *  after background activity goes quiet. Display-only; cleared when a new turn
   *  takes over the session's status card. */
  private readonly bgSettleTimers = new Map<string, NodeJS.Timeout>();
  /** Last rendered plan text per session, to dedupe repeated plan updates. */
  private readonly lastPlanRender = new Map<string, string>();
  /** Set by index.ts after construction; used by /seam schedule handlers to
   *  arm/disarm timers and by the fire runner to drop deleted-thread schedules. */
  private scheduledManager?: ScheduledPromptManager;
  private readonly provisioner: RepoProvisioner;
  /** In-flight repo provisioning (clone/new) per channel id — one at a time. */
  private readonly provisioningThreads = new Set<string>();

  constructor(opts: {
    logger: Logger;
    config: Config;
    adapter: ChatAdapter;
    router: SessionRouter;
    store: SessionStore;
    renderer: Renderer;
  }) {
    this.logger = opts.logger.child({ comp: "orchestrator" });
    this.config = opts.config;
    this.adapter = opts.adapter;
    this.router = opts.router;
    this.store = opts.store;
    this.renderer = opts.renderer;
    this.provisioner = new RepoProvisioner(opts.config.REPOS_ROOT, this.logger, {
      hostPolicy: opts.config.REPO_CLONE_HOST_POLICY,
      ...(opts.config.REPO_CLONE_ALLOWED_HOSTS
        ? { allowlistHosts: opts.config.REPO_CLONE_ALLOWED_HOSTS }
        : {}),
      cloneTimeoutMs: opts.config.REPO_CLONE_TIMEOUT_MS,
      commandName: opts.config.DISCORD_COMMAND_NAME,
    });
  }

  install(): void {
    this.provisioner.sweepStaleStaging();
    this.adapter.onMessage((msg) => this.handleIncomingMessage(msg));
    this.adapter.onThreadDelete?.((channelRef) => this.handleThreadDeleted(channelRef));
    this.watchSentinel();
  }

  /** Instant cleanup when a thread is deleted: drop its scheduled prompts and
   *  their stored attachments. (Fire-time 404 is the lazy fallback if the bot
   *  was offline when the delete happened.) */
  private async handleThreadDeleted(channelRef: string): Promise<void> {
    const rows = this.store.listScheduledByChannel(PLATFORM, channelRef);
    if (rows.length === 0) return;
    this.logger.info({ channelRef, count: rows.length }, "thread deleted; dropping scheduled prompts");
    for (const row of rows) {
      this.scheduledManager?.disarm(row.id);
      this.store.deleteScheduled(row.id);
      await deleteScheduledAttachmentDir(this.config.DATA_DIR, row.id).catch(() => {});
    }
  }

  async postNotification(message: string): Promise<void> {
    const channelId = this.config.DISCORD_NOTIFICATIONS_CHANNEL_ID;
    if (!channelId) return;
    try {
      await this.adapter.sendMessage({ platform: PLATFORM, id: channelId }, `**seam-acp**: ${message}`);
    } catch (err) {
      this.logger.warn({ err }, "failed to post notification");
    }
  }

  private sentinelPoller: ReturnType<typeof setInterval> | null = null;

  /** Stop the sentinel file watcher (call on shutdown). */
  stopSentinelWatcher(): void {
    if (this.sentinelPoller) {
      clearInterval(this.sentinelPoller);
      this.sentinelPoller = null;
    }
  }

  private sentinelPath(): string {
    return path.join(this.config.DATA_DIR, ".restart-pending");
  }

  private watchSentinel(): void {
    const checkSentinel = () => {
      if (this.restartPending) return;
      if (!fs.existsSync(this.sentinelPath())) return;
      this.logger.info("restart sentinel detected");
      void this.handleRestartSentinel();
    };

    // Poll every 2s — more reliable than fs.watch on Linux
    this.sentinelPoller = setInterval(checkSentinel, 2000);
    // Also check immediately in case sentinel was written before startup
    checkSentinel();

    // Clear out any stale staged attachments from prior runs (TTL backstop).
    void sweepStagedAttachments();
  }

  private async handleRestartSentinel(): Promise<void> {
    this.restartPending = true;
    // Stop firing NEW scheduled jobs immediately so the drain only waits for
    // jobs already in flight (they're counted in activeTurns). Timers re-arm from
    // the DB after the restart.
    this.scheduledManager?.stop();

    if (this.activeTurns > 0) {
      const turnWord = this.activeTurns === 1 ? "turn" : "turn(s)";
      await this.postNotification(
        `♻️ Restart requested — waiting for ${this.activeTurns} ${turnWord} to finish.`
      );
      this.logger.info({ activeTurns: this.activeTurns }, "restart pending, draining turns");

      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (this.activeTurns === 0) {
            clearInterval(check);
            resolve();
          }
        }, 500);
      });
    }

    // Give agents 2 seconds to flush their SQLite DBs and transcripts after the
    // final JSON-RPC prompt() response is returned. Without this, the instant 
    // SIGTERM during shutdown can interrupt the final background DB commit.
    this.logger.info("turns drained; waiting 2s for background I/O to flush");
    await new Promise((resolve) => setTimeout(resolve, 2000));

    this.logger.info("all turns drained, executing restart");
    try {
      await fsp.unlink(this.sentinelPath());
    } catch {
      // ignore if already gone
    }

    // Spawn pm2 restart in a detached process so this process can be killed
    // without interrupting the restart command mid-flight.
    const { spawn } = await import("node:child_process");
    const child = spawn("pm2", ["restart", "seam-acp"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  // --- message turn ---

  private async handleIncomingMessage(msg: IncomingMessage): Promise<void> {
    const channelId = msg.channel.id;

    // Bump the generation so any previously-queued (but not-yet-started) tasks
    // for this channel know they've been superseded and should skip themselves.
    const myGen = (this.channelGenerations.get(channelId) ?? 0) + 1;
    this.channelGenerations.set(channelId, myGen);

    if (this.channelQueues.has(channelId)) {
      const channel = msg.channel;
      const record = this.router.ensureSessionRecord({
        platform: channel.platform,
        channelRef: channel.id,
        ...(channel.parentId ? { parentRef: channel.parentId } : {}),
        cwd: this.config.REPOS_ROOT,
      });
      this.logger.info({ channelId, sessionId: record.id }, "new message arrived while turn active; aborting running turn");
      // Escalate to a force-kill if the turn ignores the graceful cancel, so a
      // hung turn can't block the new message behind it forever.
      await this.router.abortTurn(record.id, { force: true });
    }

    const existingQueue = this.channelQueues.get(channelId) ?? Promise.resolve();

    const newQueue = existingQueue.then(async () => {
      // A newer message arrived after us — skip this turn entirely.
      if ((this.channelGenerations.get(channelId) ?? 0) > myGen) return;
      this.activeTurns++;
      try {
        await this.handleIncomingMessageInner(msg);
      } catch (err) {
        this.logger.error({ err, channelId }, "error in handleIncomingMessageInner");
      } finally {
        this.activeTurns--;
      }
    });

    this.channelQueues.set(channelId, newQueue);

    void newQueue.then(() => {
      if (this.channelQueues.get(channelId) === newQueue) {
        this.channelQueues.delete(channelId);
      }
    });

    await newQueue;
  }

  private async handleIncomingMessageInner(msg: IncomingMessage): Promise<void> {
    const channel = msg.channel;
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });

    // Refuse turns while this thread is provisioning a repo (clone/new): the
    // rebind at the end of provisioning would otherwise interrupt this turn.
    if (this.provisioningThreads.has(channel.id)) {
      await this.adapter.sendMessage(
        channel,
        "⏳ 這個 thread 正在 clone / 建立 repo，請等完成後再送訊息。"
      );
      return;
    }

    // A new turn owns this session's status card now — cancel any lingering
    // "settle back to Monitoring" timer left by the previous turn's background
    // activity so it can't edit the new card.
    const prevSettle = this.bgSettleTimers.get(record.id);
    if (prevSettle) {
      clearTimeout(prevSettle);
      this.bgSettleTimers.delete(record.id);
    }
    // `backgroundLaunched`: the agent started a Monitor / background task this
    // turn, so it should rest at "Monitoring" instead of "Done". `turnFinalized`:
    // the main turn has fully finalized, so any *further* generative activity is
    // an agent-initiated woken turn (not the trailing in-turn backlog the idle()
    // drain handles) and should flip the card back to Working. Display-only.
    const BG_SETTLE_MS = 10_000;
    let backgroundLaunched = false;
    let turnFinalized = false;

    const cfg = this.store.readConfig(record);
    const repoDisplay = this.repoDisplay(record.repoPath);
    const status = new TurnStatus({
      model: cfg.model ?? this.config.DEFAULT_MODEL,
      repoDisplay,
      mode: this.friendlyModeLabel(cfg.mode) ?? "Agent",
      ...(cfg.reasoningEffort ? { effort: cfg.reasoningEffort } : {}),
    });

    // Seed the status panel with the last-known usage from the previous turn,
    // so the user sees continuity before any usage_update events fire. The
    // saved value is invalidated when the model changes (size belongs to a
    // different model). Any staleness is corrected by the post-turn
    // side-channel read.
    const cachedUsage = cfg.lastContextUsage;
    const activeModel = cfg.model ?? this.config.DEFAULT_MODEL;
    // Authoritative per-model window when seam-acp knows it (staticModels
    // contextLimit — e.g. opencode/Ollama, discovered from /api/show). Some
    // agents report a generic default (~200K) in usage_update regardless of the
    // real window; use this as a FLOOR so the panel shows the true size.
    const turnProfile = this.router.getProfile(record.agentId);
    // Look up the authoritative context window from static models.  When
    // claude-agent-acp is pointed at a non-Anthropic backend (Ollama Cloud,
    // Z.ai) it reports its *internal* Claude model name, not the real model.
    // Fallback: if the activeModel doesn't match any static entry, try the
    // profile's defaultModel — that's what the backend is actually running.
    const modelContextFloor =
      turnProfile?.staticModels?.find((m) => m.modelId === activeModel)?.contextLimit
        ?? turnProfile?.staticModels?.find((m) => m.modelId === turnProfile.defaultModel)?.contextLimit
        ?? 0;
    if (
      cachedUsage &&
      cachedUsage.model === activeModel &&
      cachedUsage.size > 0 &&
      cachedUsage.used > 0
    ) {
      status.contextUsedHighWater = cachedUsage.used;
      status.contextWindowSize = cachedUsage.size;
      status.context = formatContextUsage(cachedUsage.used, cachedUsage.size);
    }
    if (modelContextFloor > status.contextWindowSize) {
      status.contextWindowSize = modelContextFloor;
      status.context = formatContextUsage(status.contextUsedHighWater, modelContextFloor);
    }

    const initialPanel = renderStatusPanel(this.renderer, status.toInput(), Date.now());
    const statusMsg = this.adapter.sendPanel
      ? await this.adapter.sendPanel(channel, initialPanel)
      : await this.adapter.sendMessage(channel, serializePanelText(initialPanel));

    let lastEdit = 0;
    let lastRendered = "";
    let pendingRefresh: NodeJS.Timeout | undefined;
    const refresh = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastEdit < STATUS_EDIT_DEBOUNCE_MS) {
        if (!pendingRefresh) {
          const remaining = STATUS_EDIT_DEBOUNCE_MS - (now - lastEdit);
          pendingRefresh = setTimeout(() => {
            pendingRefresh = undefined;
            void refresh(false);
          }, remaining);
        }
        return;
      }
      if (pendingRefresh) {
        clearTimeout(pendingRefresh);
        pendingRefresh = undefined;
      }
      const panel = renderStatusPanel(this.renderer, status.toInput(), now);
      const fingerprint = JSON.stringify(panel);
      if (fingerprint === lastRendered) return;
      lastRendered = fingerprint;
      lastEdit = now;
      try {
        if (this.adapter.editPanel) {
          await this.adapter.editPanel(statusMsg, panel);
        } else {
          await this.adapter.editMessage(statusMsg, serializePanelText(panel));
        }
      } catch (err) {
        this.logger.warn({ err }, "status edit failed");
      }
    };

    // Heartbeat: tick the elapsed counter periodically. Edits to the same
    // message are heavily rate-limited by Discord (~5/5s per message), and
    // those rate-limit waits also queue behind regular sends — so we keep
    // this conservative.
    const heartbeat = setInterval(() => {
      void refresh();
    }, STATUS_HEARTBEAT_MS);

    // Typing indicator: refresh on real agent activity (text, tool calls,
    // thoughts) rather than a dumb timer. Discord's typing indicator
    // expires after ~10s, so we re-arm it every 8s while the agent is
    // working. Stops once we start posting actual messages — keeping it
    // alive past that point looks wrong.
    const TYPING_INTERVAL_MS = 8_000;
    let lastTypingSentAt = 0;
    let typingDone = false;
    const refreshTyping = (): void => {
      if (typingDone) return;
      const now = Date.now();
      if (now - lastTypingSentAt < TYPING_INTERVAL_MS) return;
      lastTypingSentAt = now;
      if (this.adapter.sendTyping) {
        void this.adapter.sendTyping(channel).catch(() => {});
      }
    };

    let textBuffer = "";
    let textSent = false;
    let totalAgentChars = 0;
    // Set true mid-turn (in the usage-update handler) when agy's context
    // usage crosses AGY_AUTO_COMPACT_THRESHOLD; consumed post-turn to run
    // the /compact flow before the next prompt.
    let agyAutoCompactNeeded = false;
    // Streaming fence extractor: pulls every ```lang ... ``` block out
    // of the agent's text and emits ordered segments. Fence-close
    // segments are routed to inline-or-attachment rendering based on
    // size; bare-filename fences resolve to a host-file upload.
    const fenceStream = new FenceStream();
    let fenceCounter = 0;
    // Watchdog: if a fence stays open longer than this with no closer,
    // we emit whatever's accumulated and treat the fence as closed so
    // subsequent bytes flow as prose. Checked on each chunk.
    const FENCE_MAX_OPEN_MS = 60_000;
    let fenceWatchdogTripped = false;
    // Per-turn timing for diagnosing slow turns. Set when we send the
    // prompt; first-chunk + total recorded as info logs.
    let turnStartedAt = 0;
    let firstChunkAt: number | undefined;
    // Streaming policy: only flush mid-turn when we have a *substantial*
    // amount of buffered text AND a clean paragraph boundary exists.
    // Otherwise wait for end-of-turn — Discord rate-limits us hard if we
    // send one tiny message per paragraph (e.g. each verse of "99 bottles"
    // would be its own message).
    const HARD_MAX = 1800;
    const SOFT_MIN = 800;
    const drainBufferInner = async (force: boolean, allowUnsafeCut = false) => {
      while (textBuffer) {
        const split = splitForFlush(textBuffer, {
          maxLen: HARD_MAX,
          softMin: SOFT_MIN,
          force,
          allowUnsafeCut,
        });
        if (!split) return;
        textBuffer = split.keep;
        if (split.send) {
          await this.adapter.sendMessage(channel, split.send);
          textSent = true;
          typingDone = true;
        }
        if (!force) return;
      }
    };
    // Serialize every drain. maybeFlush(), the idle timer, fence boundaries,
    // and end-of-turn all trigger drains; without this they could run
    // concurrently, each reassigning `textBuffer` and issuing an independent
    // sendMessage whose delivery order isn't guaranteed — reordering output.
    // Enqueueing is synchronous, so drains (and their sends) run strictly in
    // call order.
    const flushQueue = new SerialQueue();
    const drainBuffer = (force: boolean, allowUnsafeCut = false): Promise<void> =>
      flushQueue.run(() => drainBufferInner(force, allowUnsafeCut));
    const flushChunks = async () => {
      // End-of-turn: must drain everything. An open link will never be
      // closed, so allow unsafe cuts here.
      await drainBuffer(true, true);
    };
    /**
     * Idle-flush timer: if text has been buffered for IDLE_FLUSH_MS
     * with no new chunks arriving, force-flush whatever's there. This
     * keeps UX responsive when the agent emits a slow trickle that
     * never crosses HARD_MAX or hits a clean paragraph boundary
     * (e.g. a short poem).
     */
    const IDLE_FLUSH_MS = 4000;
    // Hard ceiling: even inside an open fence, force-flush if the buffer
    // grows past this. Defends against runaway model loops (e.g. Copilot
    // spamming the language tag) without losing legitimate long fences.
    const FENCE_BUFFER_CEILING = 16000;
    let idleTimer: NodeJS.Timeout | undefined;
    const cancelFlushTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const armIdleFlush = () => {
      cancelFlushTimer();
      if (!textBuffer) return;
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        // Idle for IDLE_FLUSH_MS — any open markdown link is probably
        // never going to close. Allow unsafe cuts so we don't strand
        // the buffer waiting for a `)` that won't come.
        if (textBuffer) void drainBuffer(true, true);
      }, IDLE_FLUSH_MS);
    };
    const maybeFlush = () => {
      if (textBuffer.length >= HARD_MAX) {
        void drainBuffer(true);
        return;
      }
      void drainBuffer(false);
    };

    const RETRY_MARKER = "— 🔁 retried — output above may repeat —";
    const RETRY_REGEX = /response was interrupted.*retrying/i;
    let currentMessageId: string | undefined;
    let postedRetryNotice = false;
    // Runaway-loop detector: some agent models get stuck repeating the
    // same chunk — Copilot spams short language tags (e.g. "markdown"),
    // Gemini sometimes loops a full sentence. Cancel the turn once the
    // exact same trimmed chunk repeats. Threshold is lower for long
    // chunks (a repeated full sentence is much more obviously broken
    // than a repeated short token).
    const LOOP_THRESHOLD_SHORT = 12; // for chunks <= 40 chars
    const LOOP_THRESHOLD_LONG = 4; // for longer chunks
    const LOOP_SHORT_MAX = 40;
    let loopChunk: string | null = null;
    let loopCount = 0;
    let loopAborted = false;
    // Whitespace runaway: when the model gets stuck emitting nothing but
    // newlines/spaces, no trimmed chunk ever lands so the repeat-detector
    // can't fire. Count whitespace-only chunks separately and bail out
    // after enough of them in a row.
    const WHITESPACE_RUN_THRESHOLD = 30;
    let whitespaceRun = 0;
    const noteRetry = async () => {
      if (postedRetryNotice) return;
      postedRetryNotice = true;
      // Flush whatever we already buffered from the failed attempt first.
      await flushChunks();
      try {
        await this.adapter.sendMessage(channel, RETRY_MARKER);
      } catch (err) {
        this.logger.warn({ err }, "retry notice send failed");
      }
    };

    const isSessionGoneError = (e: unknown): boolean => {
      const message = e instanceof Error ? e.message : String(e);
      const details = String((e as any)?.data?.details ?? "");
      return (
        message.toLowerCase().includes("session not found") ||
        details.toLowerCase().includes("session not found")
      );
    };

    // A 400 error from the agent means the current prompt was rejected (e.g.
    // invalid image). The session itself may still be valid, but we invalidate
    // anyway so the next message doesn't replay the same bad content.
    const isAgentRejectionError = (e: unknown): boolean => {
      return (e as any)?.code === 400;
    };

    // The Anthropic vision API caps per-image dimensions at 2000px once a request
    // carries many images (~20+). A run of high-res testing screenshots trips
    // this, and then EVERY follow-up turn that re-sends the history fails the same
    // way. Recognize it so we can auto-strip images (repairSession) and recover.
    const isImageDimensionError = (msg: string): boolean =>
      /dimension limit for many-image|exceeds the dimension limit/i.test(msg);

    // ACP connection dropped mid-turn — typically the remote bridge restarted or
    // the underlying WS dropped after the agent had already finished its response.
    // Different from session-gone: the session files are still intact, so we can
    // invalidate (keeping the session ID) and replay the prompt on reconnect.
    const isConnectionClosedError = (e: unknown): boolean => {
      const msg = e instanceof Error ? e.message : String(e);
      return msg.includes("ACP connection closed");
    };
    // Transient server-side throttle — "Server is temporarily limiting requests
    // (not your usage limit) · Rate limited". NOT a quota/usage error; it clears
    // on its own, so a short backoff-and-retry recovers it invisibly.
    const isRateLimitError = (e: unknown): boolean => {
      const err = e as { data?: { errorKind?: string }; message?: string } | undefined;
      if (err?.data?.errorKind === "rate_limit") return true;
      const msg = e instanceof Error ? e.message : String(e);
      return /temporarily limiting requests|rate limited/i.test(msg);
    };

    try {
      let activeRuntime = await this.router.getOrStartRuntime(record);
      const eventHandler = async (event: Parameters<Parameters<typeof activeRuntime.onEvent>[0]>[0]) => {
        // Note the agent launching a Monitor so the turn rests at "Monitoring"
        // rather than "Done" even before any woken activity arrives. Anchored to
        // the title start to avoid matching ordinary tools that merely mention
        // "monitor" (e.g. reading monitor.ts); the reactive path below backstops
        // any miss when the first woken activity actually arrives.
        if (event.kind === "tool-start" && /^\s*monitor\b/i.test(event.title ?? "")) {
          backgroundLaunched = true;
        }
        // Woken/background turn: once the main turn has finalized, further
        // generative activity is the agent resuming on its own (a Monitor wake
        // or a background task reporting). Flip the card back to Working and
        // settle to Monitoring on quiescence, so it never sits on a stale "Done"
        // while output is still streaming. Display-only — no session state touched.
        if (
          turnFinalized &&
          (event.kind === "agent-text" ||
            event.kind === "agent-thought" ||
            event.kind === "tool-start")
        ) {
          backgroundLaunched = true;
          if (status.state !== "Working") {
            status.setState("Working");
            status.setAction("Resumed — background activity");
            void refresh();
          }
          const prev = this.bgSettleTimers.get(record.id);
          if (prev) clearTimeout(prev);
          this.bgSettleTimers.set(
            record.id,
            setTimeout(() => {
              this.bgSettleTimers.delete(record.id);
              status.setState("Monitoring");
              status.setAction("🛰️ Background task active — resumes when it reports");
              void refresh(true);
            }, BG_SETTLE_MS)
          );
        }
        switch (event.kind) {
          case "plan": {
            await this.renderPlanUpdate(channel, record.id, event.entries);
            return;
          }
          case "agent-text": {
            refreshTyping();
            // Detect Copilot CLI retry: either the agent emits a "Retrying"
            // sentinel, or the messageId rolls over mid-turn.
            const isRetrySentinel = RETRY_REGEX.test(event.text);
            // A messageId rollover means "a new message started" (ACP schema
            // v1.16.0). For Copilot CLI that's how an in-band retry surfaces —
            // but for other agents (Claude on claude-agent-acp ≥0.54, which now
            // stamps a distinct messageId per message) it's just a normal
            // multi-message turn (e.g. text → tool call → text). Only treat it
            // as a retry for Copilot, else every post-tool continuation posts a
            // spurious "retried" notice.
            const isNewMessage =
              record.agentId.startsWith("copilot") &&
              event.messageId !== undefined &&
              currentMessageId !== undefined &&
              event.messageId !== currentMessageId;
            if (isRetrySentinel || isNewMessage) {
              await noteRetry();
              postedRetryNotice = false; // allow future retries to notify again
            }
            if (event.messageId) currentMessageId = event.messageId;
            // Runaway-loop check (cheap; runs before buffering).
            if (!loopAborted) {
              const trimmed = event.text.trim();
              if (trimmed) {
                whitespaceRun = 0;
                if (trimmed === loopChunk) {
                  loopCount += 1;
                } else {
                  loopChunk = trimmed;
                  loopCount = 1;
                }
              } else {
                // pure-whitespace chunk: track separately so a runaway
                // newline loop still trips the canary.
                whitespaceRun += 1;
              }
              const repeatThreshold =
                loopChunk && loopChunk.length <= LOOP_SHORT_MAX
                  ? LOOP_THRESHOLD_SHORT
                  : LOOP_THRESHOLD_LONG;
              const repeatTripped =
                loopChunk !== null && loopCount >= repeatThreshold;
              const whitespaceTripped =
                whitespaceRun >= WHITESPACE_RUN_THRESHOLD;
              if (repeatTripped || whitespaceTripped) {
                loopAborted = true;
                const reason = whitespaceTripped
                  ? "whitespace"
                  : "repeated chunk";
                this.logger.warn(
                  {
                    session: record.id,
                    reason,
                    chunkLen: loopChunk?.length ?? 0,
                    chunkPreview: loopChunk?.slice(0, 80),
                    repeats: loopCount,
                    whitespaceRun,
                  },
                  "runaway agent output detected; cancelling turn"
                );
                try {
                  await activeRuntime.cancel();
                } catch (err) {
                  this.logger.warn({ err }, "cancel after loop failed");
                }
                try {
                  await flushChunks();
                  const notice = whitespaceTripped
                    ? "⚠️ Agent got stuck emitting blank output — turn cancelled. Try rephrasing."
                    : (() => {
                        const c = loopChunk ?? "";
                        const preview =
                          c.length > 80 ? `${c.slice(0, 77)}...` : c;
                        return `⚠️ Agent got stuck repeating the same output (\`${preview}\`) — turn cancelled. Try rephrasing.`;
                      })();
                  await this.adapter.sendMessage(channel, notice);
                  textSent = true;
                } catch (err) {
                  this.logger.warn({ err }, "loop notice send failed");
                }
                return;
              }
            }
            totalAgentChars += event.text.length;
            // Run text through the fence extractor and process each
            // ordered segment. Prose flows into the chat pipeline;
            // fence-open forces a flush of preceding prose; fence-close
            // routes to inline-or-attachment rendering based on size.
            const fenceResult = fenceStream.feed(event.text);
            for (const seg of fenceResult.segments) {
              if (seg.kind === "prose") {
                if (seg.text) {
                  textBuffer += seg.text;
                  maybeFlush();
                  armIdleFlush();
                }
              } else if (seg.kind === "fence-open") {
                // Commit any pending prose before the fence so message
                // ordering matches the agent's stream order.
                cancelFlushTimer();
                await drainBuffer(true);
              } else {
                // fence-close: emit as inline message or attachment.
                fenceCounter += 1;
                await this.emitClosedFence(channel, seg.fence, fenceCounter, {
                  preferredRoot: record.repoPath,
                });
                textSent = true;
                typingDone = true;
              }
            }
            // Watchdog: if a fence has been open too long, snapshot what
            // we have, emit it with a notice, and treat the fence as
            // closed so subsequent bytes flow as prose.
            if (
              !fenceWatchdogTripped &&
              fenceStream.inFence &&
              fenceStream.openSinceMs() > FENCE_MAX_OPEN_MS
            ) {
              fenceWatchdogTripped = true;
              this.logger.warn(
                { session: record.id },
                "open fence exceeded watchdog timeout; emitting partial content"
              );
              const snap = fenceStream.forceClose();
              if (snap) {
                fenceCounter += 1;
                await this.emitClosedFence(channel, snap, fenceCounter, {
                  preferredRoot: record.repoPath,
                  notice:
                    "_(fence exceeded the watchdog timeout and was closed early)_",
                });
                textSent = true;
                typingDone = true;
              }
            }
            if (firstChunkAt === undefined) {
              firstChunkAt = Date.now();
              this.logger.info(
                {
                  ttftMs: firstChunkAt - turnStartedAt,
                  session: record.id,
                },
                "agent first text chunk"
              );
            }
            return;
          }
          case "tool-start": {
            refreshTyping();
            const label = event.title ?? event.kindLabel ?? "…";
            status.setAction(`Tool: ${label}`);
            status.pushActivity(label);
            await refresh();
            return;
          }
          case "tool-update":
            refreshTyping();
            if (event.status === "completed" || event.status === "failed") {
              status.setAction("Working…");
            } else if (event.title) {
              status.setAction(`Tool: ${event.title}`);
              status.pushActivity(event.title);
            }
            await refresh();
            return;
          case "model-changed":
            status.setModel(event.modelId);
            await refresh();
            return;
          case "mode-changed":
            status.setMode(this.friendlyModeLabel(event.modeId) ?? "Agent");
            await refresh();
            return;
          case "agent-file": {
            // Flush pending text first so the file shows up after the
            // assistant's narration in the thread.
            await flushChunks();
            try {
              await this.sendAgentFile(channel, event);
              textSent = true;
            } catch (err) {
              this.logger.warn(
                { err, filename: event.filename },
                "sendFile failed; falling back to text notice"
              );
              await this.adapter.sendMessage(
                channel,
                `_Agent produced a file (\`${event.filename}\`) but it couldn't be uploaded._`
              );
            }
            return;
          }
          case "agent-thought":
            refreshTyping();
            status.pushThinkingChunk(event.text);
            void refresh();
            return;
          case "agent-state":
            refreshTyping();
            status.setAction(event.state);
            void refresh();
            return;
          case "usage-update": {
            if (event.size <= 0) return;
            // Ignore mid-turn used:0 events. claude-agent-acp emits them on
            // compact_boundary, but the remote-claude→copilot-api proxy path
            // also surfaces spurious 0s when intermediate response chunks
            // arrive with missing usage fields — making the display flicker.
            // We can't tell the two apart, so hold steady. The end-of-turn
            // side-channel (getUsage / JSONL read) lands the authoritative
            // post-compaction value if a compaction really did happen.
            if (event.used === 0) return;
            const used = Math.max(event.used, status.contextUsedHighWater);
            status.contextUsedHighWater = used;
            // Monotonic ceiling on the window too. claude-agent-acp starts each
            // session at its 200K default and the authoritative window (e.g. 1M)
            // arrives a beat later — without this, the card blips 200K→1M on the
            // first event. The window only ever grows within a turn (default →
            // authoritative); it never legitimately shrinks (compaction changes
            // `used`, not `size`; model switches clear the cache between turns).
            // `modelContextFloor` overrides an agent's generic default (e.g.
            // opencode reporting 200K for a 256K gemma model).
            const size = Math.max(event.size, modelContextFloor, status.contextWindowSize);
            status.contextWindowSize = size;
            status.context = formatContextUsage(used, size);
            // agy has no built-in auto-compaction. Mark the turn for an
            // end-of-turn /compact when usage crosses the configured threshold.
            if (
              this.config.AGY_AUTO_COMPACT_THRESHOLD > 0 &&
              record.agentId.startsWith("agy") &&
              used / size >= this.config.AGY_AUTO_COMPACT_THRESHOLD
            ) {
              agyAutoCompactNeeded = true;
            }
            void refresh();
            return;
          }
          case "config-options":
          case "error":
            return;
        }
      };
      activeRuntime.onEvent(eventHandler);

      status.setAction("Thinking…");
      await refresh(true);
      refreshTyping();

      turnStartedAt = Date.now();
      const timeoutMs = this.config.TURN_TIMEOUT_SECONDS * 1000;

      // If the active profile is on a Discord-restricted host (e.g. remote
      // Mac with strict network policy), don't expose Discord CDN URLs to
      // the LLM. Instead, download the bytes server-side and stream them to
      // the agent's filesystem via the bridge's `writeAttachment` cmd. The
      // model gets a local path in the prompt; attachments are stripped.
      // Prepend the standing agent conventions (attach-fence, table rendering)
      // as a provenance-tagged preamble so every backend knows the operating
      // rules without depending on a per-backend system-prompt path.
      let promptText = withHarnessPreamble(msg.text);
      let promptAttachments = msg.attachments;
      const activeProfile = this.router.getProfile(record.agentId);
      if (
        activeProfile?.restrictDiscordAccess &&
        msg.attachments &&
        msg.attachments.length > 0 &&
        typeof activeProfile.sessionManager?.writeAttachment === "function"
      ) {
        const writer = activeProfile.sessionManager.writeAttachment.bind(
          activeProfile.sessionManager
        );
        const cwd = record.repoPath ?? process.cwd();
        const pathLines: string[] = [];
        for (const a of msg.attachments) {
          try {
            const res = await fetch(a.url);
            if (!res.ok) throw new Error(`download ${res.status} ${res.statusText}`);
            const buf = Buffer.from(await res.arrayBuffer());
            const { path: written } = await writer(
              cwd,
              a.filename,
              buf.toString("base64")
            );
            pathLines.push(`- \`${a.filename}\` → \`${written}\``);
          } catch (err) {
            this.logger.warn(
              { err, filename: a.filename },
              "failed to write attachment to restricted agent; falling back to skipping"
            );
            pathLines.push(`- \`${a.filename}\` — could not be transferred to the agent host`);
          }
        }
        const hint =
          `\n\n_The following file${pathLines.length === 1 ? " was" : "s were"} ` +
          `uploaded and saved to the agent's filesystem:_\n${pathLines.join("\n")}`;
        promptText = promptText ? `${promptText}${hint}` : hint.trimStart();
        promptAttachments = undefined; // already on disk; no ACP attachment blocks
      } else if (
        !activeProfile?.restrictDiscordAccess &&
        msg.attachments &&
        msg.attachments.length > 0
      ) {
        // Local agent: text + standard images go inline; everything else
        // (PDF/Office/HEIC/binary) is staged to a temp path the agent opens with
        // its file tools. Shared with the scheduled fire runner.
        const { inline, hint } = await this.partitionAndStageAttachments(msg.attachments);
        if (hint) promptText = promptText ? `${promptText}${hint}` : hint.trimStart();
        promptAttachments = inline.length > 0 ? inline : undefined;
      }

      // One transparent retry on transient failures. Both cases fire before any
      // output is buffered so the retry is invisible to the user.
      //   session-gone: session files are lost; start a fresh session.
      //   connection-closed: bridge/agent restarted mid-turn but session files
      //     are intact; keep the session ID so loadSession() resumes context.
      //     getOrStartRuntime will wait up to 44s for the bridge to reconnect.
      let result: PromptOutcome | "timeout";
      try {
        result = await raceWithTimeout(activeRuntime.prompt(promptText, promptAttachments), timeoutMs);
      } catch (promptErr) {
        if (isSessionGoneError(promptErr)) {
          this.logger.warn({ session: record.id }, "session-gone on prompt; invalidating and retrying with new session");
          await this.router.invalidate(record.id, { clearAcpSession: true });
          activeRuntime = await this.router.getOrStartRuntime(record);
          activeRuntime.onEvent(eventHandler);
          result = await raceWithTimeout(activeRuntime.prompt(promptText, promptAttachments), timeoutMs);
        } else if (isConnectionClosedError(promptErr)) {
          this.logger.warn({ session: record.id }, "connection closed mid-turn; waiting for reconnect and retrying");
          await this.router.invalidate(record.id, { clearAcpSession: false });
          activeRuntime = await this.router.getOrStartRuntime(record);
          activeRuntime.onEvent(eventHandler);
          result = await raceWithTimeout(activeRuntime.prompt(promptText, promptAttachments), timeoutMs);
        } else if (isRateLimitError(promptErr) && !textSent && !textBuffer) {
          // Transient server-side throttle with nothing emitted yet: the session
          // is intact, so back off and retry the SAME prompt on the SAME runtime
          // (no invalidate). Guarded on no-output-yet so a mid-stream limit can't
          // double-emit — if output already started we fall through and surface
          // it. Schedule clears typical brief throttles invisibly.
          let rlResult: PromptOutcome | "timeout" | undefined;
          for (const backoffMs of [2_000, 5_000, 10_000]) {
            this.logger.warn({ session: record.id, backoffMs }, "rate limited before output; backing off and retrying");
            await new Promise((r) => setTimeout(r, backoffMs));
            try {
              rlResult = await raceWithTimeout(activeRuntime.prompt(promptText, promptAttachments), timeoutMs);
              break;
            } catch (rlErr) {
              if (!isRateLimitError(rlErr)) throw rlErr; // a different failure — surface it
            }
          }
          if (rlResult === undefined) throw promptErr; // still throttled after backoff
          result = rlResult;
        } else {
          throw promptErr;
        }
      }

      // Drain the session-update queue so every update received before the
      // prompt response is processed into the chat pipeline BEFORE we flush and
      // finalize. Without this, updates still backlogged in the SerialQueue post
      // and refresh the status card AFTER it already shows "Done" — the display
      // trails the (already-finished) turn. Skip on timeout (the agent may be
      // hung and idle() could then block), and race a short guard so a stuck
      // update handler can't lock the turn open.
      if (result !== "timeout") {
        await Promise.race([
          activeRuntime.idle(),
          new Promise<void>((r) => setTimeout(r, 5_000)),
        ]);
      }

      cancelFlushTimer();
      // Drain the fence extractor: any final segments enter the chat
      // pipeline; an unclosed fence is emitted with a notice rather
      // than dropped.
      const tail = fenceStream.flush();
      for (const seg of tail.segments) {
        if (seg.kind === "prose") {
          if (seg.text) textBuffer += seg.text;
        } else if (seg.kind === "fence-open") {
          // Shouldn't appear in flush output, but handle defensively.
          await drainBuffer(true, true);
        } else {
          fenceCounter += 1;
          await this.emitClosedFence(channel, seg.fence, fenceCounter, {
            preferredRoot: record.repoPath,
          });
          textSent = true;
        }
      }
      if (tail.unclosed && !fenceWatchdogTripped) {
        this.logger.warn(
          {
            session: record.id,
            lang: tail.unclosed.lang,
            chars: tail.unclosed.content.length,
          },
          "agent ended turn with an unclosed code fence; emitting partial"
        );
        // Drain any prose preceding the unclosed fence first.
        await drainBuffer(true, true);
        fenceCounter += 1;
        await this.emitClosedFence(channel, tail.unclosed, fenceCounter, {
          preferredRoot: record.repoPath,
          notice: "_(fence was not closed by the agent)_",
        });
        textSent = true;
      }
      await flushChunks();
      this.logger.info(
        {
          session: record.id,
          totalMs: Date.now() - turnStartedAt,
          ttftMs:
            firstChunkAt !== undefined ? firstChunkAt - turnStartedAt : null,
          chars: totalAgentChars,
          fenceFiles: fenceCounter,
        },
        "turn timing"
      );

      // Plan mode: after the planning turn ends, offer to proceed. Copilot's TUI
      // plan-approval / mode-switch prompt is not emitted over ACP, so add it.
      {
        const modeId = activeRuntime.getSessionInfo()?.currentModeId;
        const inPlan = modeId
          ? modeId.endsWith("#plan")
          : (this.store.readConfig(record).mode ?? "").toLowerCase().includes("plan");
        if (result !== "timeout" && inPlan) {
          // Approach 2 (PLAN_FULL_AUTO): auto-post the full plan.md file card.
          // Approach 1 (default): the full plan is available on-demand via the
          // "顯示完整執行計畫" option inside offerPlanProceed. Short plan checklist
          // is shown by default in both cases.
          if (this.config.PLAN_FULL_AUTO) {
            await this.postPlanDetail(channel, record, "file").catch((err) =>
              this.logger.warn({ err, session: record.id }, "auto post plan.md failed")
            );
          }
          void this.offerPlanProceed(channel, record).catch((err) =>
            this.logger.warn({ err, session: record.id }, "plan-proceed picker failed")
          );
        }
      }

      if (
        result !== "timeout" &&
        result.rejectedAttachments &&
        result.rejectedAttachments.length > 0
      ) {
        const lines = result.rejectedAttachments
          .map((r) => `• \`${r.filename}\` — ${r.reason}`)
          .join("\n");
        await this.adapter.sendMessage(
          channel,
          `_Some attachments were not sent to the agent:_\n${lines}`
        );
      }

      if (!textSent && result !== "timeout" && !(result as { cancelled?: boolean }).cancelled) {
        // Turn completed but the agent produced no visible text (e.g. tools ran
        // but emitted no assistant message). Make it visible so the user isn't
        // left wondering if their message was received.
        await this.adapter.sendMessage(channel, "_Agent completed with no text response._");
      }

      if (result === "timeout") {
        // Guard against cancel() hanging when the agent connection is broken
        // (e.g. remote bridge restarted while a turn was in progress). Without
        // a timeout here, cancel() can await a response that never arrives and
        // the channel queue stays locked indefinitely.
        await Promise.race([
          activeRuntime.cancel(),
          new Promise<void>((r) => setTimeout(r, 5_000)),
        ]);
        await this.router.invalidate(record.id, { clearAcpSession: false });
        status.setState("Timed out");
        status.setAction(`Exceeded ${this.config.TURN_TIMEOUT_SECONDS}s`);
      } else if (result.cancelled) {
        status.setState("Failed");
        status.setAction("Cancelled");
      } else if (backgroundLaunched) {
        // The agent launched a Monitor / background task and yielded the turn —
        // it isn't finished, it's watching and may resume. Rest at Monitoring;
        // a woken turn flips it back to Working (see the event handler).
        status.setState("Monitoring");
        status.setAction("🛰️ Background task active — resumes when it reports");
      } else {
        status.setState("Done");
        status.setAction(result.stopReason);
      }

      // Surface context-window usage after the turn. Two paths:
      //   1. Profiles with a side-channel `getUsage` (e.g. remote bridge that
      //      reads Claude Code's JSONL transcript) — preferred, no extra prompt.
      //   2. Copilot CLI fallback — probe its `/context` slash command, which
      //      the CLI handles client-side (no LLM call).
      if (result !== "timeout" && !result.cancelled) {
        const profile = this.router.getProfile(record.agentId);
        const usageReader = profile?.sessionManager?.getUsage;
        let sideChannelEmitted = false;
        if (usageReader) {
          try {
            const cwd = record.repoPath ?? process.cwd();
            const usage = await usageReader.call(
              profile.sessionManager,
              cwd,
              record.acpSessionId || undefined,
              turnStartedAt || undefined
            );
            // Trust seam-acp's per-profile model→limit table over whatever the
            // bridge inferred from the JSONL — on proxied setups the JSONL
            // model id can be remapped/wrong.
            const selectedModel = cfg.model ?? profile?.defaultModel;
            const modelEntry = profile?.staticModels?.find(
              (m) => m.modelId === selectedModel
            ) ?? profile?.staticModels?.find(
              (m) => m.modelId === profile.defaultModel
            );
            const computedSize = modelEntry?.contextLimit ?? usage?.contextLimit ?? 0;
            // `used` may legitimately drop (post-compaction), so we bypass its
            // ceiling. But the window must never shrink: getUsage can return a
            // stale 200K default when the JSONL model id (which has [1m]
            // stripped, e.g. "claude-opus-4-8") doesn't reveal the real window.
            // Trust the larger of the computed value and what the live stream /
            // cache already established for this turn.
            const size = Math.max(status.contextWindowSize, computedSize);
            if (usage && usage.totalUsed > 0 && size > 0) {
              status.contextUsedHighWater = usage.totalUsed;
              status.contextWindowSize = size;
              status.context = formatContextUsage(usage.totalUsed, size);
              // Record the resolved model id (e.g. "claude-opus-4-8[1m]") so
              // the status card can display the actual model alongside the alias.
              if (usage.model) {
                status.resolvedModel = usage.model;
              }
              void refresh();
              sideChannelEmitted = true;
            }
          } catch (err) {
            this.logger.debug({ err }, "getUsage side-channel unavailable");
          }
        }
        if (!sideChannelEmitted && record.agentId.startsWith("copilot")) {
          await this.probeCopilotContext(activeRuntime, eventHandler, refresh);
        }

        // Persist final usage to the session record so the next turn can
        // seed its status panel without waiting for the first usage_update.
        if (status.contextUsedHighWater > 0 && status.contextWindowSize > 0) {
          try {
            const persistedCfg = this.store.readConfig(record);
            persistedCfg.lastContextUsage = {
              used: status.contextUsedHighWater,
              size: status.contextWindowSize,
              model: cfg.model ?? this.config.DEFAULT_MODEL,
              atUtc: new Date().toISOString(),
            };
            this.persistConfig(record, persistedCfg);
          } catch (err) {
            this.logger.debug({ err }, "failed to persist lastContextUsage");
          }
        }
      }

      // agy has no native auto-compaction. If usage crossed the threshold
      // mid-turn, run the same /compact flow now before the next prompt.
      if (agyAutoCompactNeeded && result !== "timeout" && !result.cancelled) {
        try {
          await this.runAgyAutoCompact(record, channel, status, refresh, status.contextUsedHighWater);
        } catch (err) {
          this.logger.warn({ err, session: record.id }, "agy auto-compact failed");
        }
      }
    } catch (err) {
      this.logger.error({ err, session: record.id }, "turn failed");
      cancelFlushTimer();
      await flushChunks();
      // If the agent reports that the session is gone (e.g. bridge restarted
      // with a fresh agent process), evict the dead runtime so the next message
      // triggers a clean newSession rather than repeatedly failing.
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isSessionGoneError(err)) {
        this.logger.warn({ session: record.id }, "session not found on agent; invalidating runtime");
        await this.router.invalidate(record.id, { clearAcpSession: true });
      } else if (isAgentRejectionError(err) || errMsg.includes("Prompt is too long") || isImageDimensionError(errMsg)) {
        const isPromptTooLong = errMsg.includes("Prompt is too long");
        const isImageDimension = isImageDimensionError(errMsg);
        // Both "prompt too long" and the many-image dimension cap are fixed by
        // stripping images from the on-disk history; keep the ACP session ID so
        // the repaired (image-stripped) JSONL is re-resumed on retry.
        const needsRepair = isPromptTooLong || isImageDimension;
        this.logger.warn(
          { session: record.id, isPromptTooLong, isImageDimension },
          "agent rejected prompt; invalidating session runtime"
        );
        await this.router.invalidate(record.id, { clearAcpSession: !needsRepair });

        if (needsRepair) {
          const profile = this.router.getProfile(record.agentId);
          const manager = profile?.sessionManager;
          const cwd = record.repoPath ?? this.config.REPOS_ROOT;
          let repaired = false;

          if (manager && typeof manager.repairSession === "function" && record.acpSessionId) {
            try {
              this.logger.info(
                { session: record.id, acpSessionId: record.acpSessionId, reason: isImageDimension ? "image-dimension" : "context-size" },
                "auto-repairing session"
              );
              await manager.repairSession(cwd, record.acpSessionId);
              repaired = true;
            } catch (repairErr) {
              this.logger.error({ err: repairErr, session: record.id }, "failed to auto-repair session");
            }
          }

          if (repaired && isImageDimension) {
            await this.adapter.sendMessage(
              channel,
              "⚠️ **An image in the conversation exceeded the 2000px many-image limit.** The session was automatically repaired by stripping image payloads from the history (testing screenshots are the usual cause). You can safely retry your message now!"
            );
          } else if (repaired) {
            await this.adapter.sendMessage(
              channel,
              "⚠️ **Claude hit its context limit before auto-compacting.** The session was automatically repaired by stripping heavy base64 image payloads and rolling back the last incomplete message. You can safely retry your message now!"
            );
          } else {
            await this.adapter.sendMessage(
              channel,
              "⚠️ **Claude hit its context limit before auto-compacting.** The context grew too large in a single turn. Try running `/compact` to free up space!"
            );
          }
        }
      }
      status.setState("Failed");
      status.setAction(this.renderer.trimShort(isSessionGoneError(err) ? "Session lost — please resend your message." : errMsg, 120));
    } finally {
      // The main turn is fully finalized: any further generative activity on
      // this runtime is an agent-initiated woken turn (handled in eventHandler),
      // not the in-turn backlog already drained above.
      turnFinalized = true;
      clearInterval(heartbeat);
      if (pendingRefresh) {
        clearTimeout(pendingRefresh);
        pendingRefresh = undefined;
      }
      await refresh(true);
    }
  }

  // --- slash commands ---

  async handleSlashInteraction(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    if (interaction.options.getSubcommandGroup(false) === "schedule") {
      return this.cmdSchedule(interaction);
    }
    if (interaction.options.getSubcommandGroup(false) === "repo") {
      return this.cmdRepoGroup(interaction);
    }
    const sub = interaction.options.getSubcommand(true);
    switch (sub) {
      case "new":
        return this.cmdNew(interaction);
      case "model":
        return this.cmdModel(interaction);
      case "mode":
        return this.cmdMode(interaction);
      case "effort":
        return this.cmdEffort(interaction);
      case "abort":
        return this.cmdAbort(interaction);
      case "cancel":
        return this.cmdCancel(interaction);
      case "kill":
        return this.cmdKill(interaction);
      case "image":
        return this.cmdImage(interaction);
      case "reset":
        return this.cmdReset(interaction);
      case "tools":
        return this.cmdTools(interaction);
      case "config":
        return this.cmdConfig(interaction);
      case "config-set":
        return this.cmdConfigSet(interaction);
      case "sessions":
        return this.cmdSessions(interaction);
      case "init":
        return this.cmdInit(interaction);
      case "approve":
        return this.cmdApprove(interaction);
      case "agent":
        return this.cmdAgent(interaction);
      case "attach":
        return this.cmdAttach(interaction);
      case "whoami":
        return this.cmdWhoami(interaction);
      case "usage":
        return this.cmdUsage(interaction);
      case "avatar":
        return this.cmdAvatar(interaction);
      case "help":
        return this.cmdHelp(interaction);
      default:
        await interaction.reply({
          content: `Unknown subcommand: ${sub}`,
          flags: MessageFlags.Ephemeral,
        });
    }
  }

  private async cmdRepoGroup(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const sub = interaction.options.getSubcommand(true);
    switch (sub) {
      case "set":
        return this.cmdRepo(interaction);
      case "list":
        return this.cmdRepos(interaction);
      case "clone":
        return this.cmdRepoClone(interaction);
      case "new":
        return this.cmdRepoNew(interaction);
      default:
        await interaction.reply({
          content: `Unknown repo subcommand: ${sub}`,
          flags: MessageFlags.Ephemeral,
        });
    }
  }

  /**
   * Autocomplete for `/seam repo set <path>`. Substring-matches REPOS_ROOT
   * children by basename, ranks most-recently-bound repos first (so the ones
   * you actually use surface even past Discord's 25-choice cap), then falls
   * back to alphabetic. This is what makes repos like `Work` reachable even
   * though the static picker truncates at 25.
   */
  async handleAutocomplete(
    interaction: AutocompleteInteraction
  ): Promise<void> {
    try {
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand(false);
      const focused = interaction.options.getFocused(true);
      if (group === "repo" && sub === "set" && focused.name === "path") {
        await interaction.respond(
          this.repoAutocompleteChoices(String(focused.value))
        );
        return;
      }
      await interaction.respond([]);
    } catch (err) {
      this.logger.warn({ err }, "repo autocomplete failed");
      try {
        await interaction.respond([]);
      } catch {
        /* interaction may already be resolved */
      }
    }
  }

  private repoAutocompleteChoices(
    query: string
  ): { name: string; value: string }[] {
    const dirs = this.listRepoDirs(); // full paths, excludes dot dirs (.staging-*)
    if (!dirs) return [];
    const q = query.trim().toLowerCase();

    // Most-recent bind time per repo path, from the session store.
    const recency = new Map<string, number>();
    for (const rec of this.store.list(200)) {
      if (!rec.repoPath) continue;
      const key = rec.repoPath.toLowerCase();
      const t = Date.parse(rec.updatedUtc ?? "") || 0;
      if (t > (recency.get(key) ?? 0)) recency.set(key, t);
    }

    const matched = dirs.filter((d) =>
      path.basename(d).toLowerCase().includes(q)
    );
    matched.sort((a, b) => {
      const ra = recency.get(a.toLowerCase()) ?? 0;
      const rb = recency.get(b.toLowerCase()) ?? 0;
      if (ra !== rb) return rb - ra; // most-recently-used first
      return path.basename(a).localeCompare(path.basename(b));
    });

    return matched.slice(0, 25).map((d) => {
      const name = path.basename(d);
      // value = basename (relative to REPOS_ROOT); bindRepo joins it under the
      // root, keeping the value well under Discord's 100-char limit.
      return { name: name.slice(0, 100), value: name.slice(0, 100) };
    });
  }

  private async probeCopilotContext(
    runtime: AgentRuntime,
    realHandler: AgentEventHandler,
    refresh: () => void
  ): Promise<void> {
    let captured = "";
    runtime.onEvent(async (event) => {
      if (event.kind === "agent-text") {
        captured += event.text;
        return;
      }
      await realHandler(event);
    });
    try {
      await Promise.race([
        runtime.prompt("/context"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("/context probe timed out")), 5_000)
        ),
      ]);
      const m = captured.match(
        /(\d+(?:\.\d+)?)k\s*\/\s*(\d+(?:\.\d+)?)k\s*tokens/i
      );
      if (m) {
        const used = Math.round(parseFloat(m[1]!) * 1000);
        const size = Math.round(parseFloat(m[2]!) * 1000);
        if (size > 0) {
          await realHandler({ kind: "usage-update", used, size });
          refresh();
        }
      }
    } catch (err) {
      this.logger.warn({ err }, "copilot /context probe failed");
    } finally {
      runtime.onEvent(realHandler);
    }
  }

  /** Returns the configured compaction model for an agent id, or "" if the
   *  agent isn't supported. Compaction always uses a known-good high-context
   *  summarizer rather than the session's own model — the latter can be too
   *  small to fit a near-full transcript with any response headroom. */
  private compactionModelFor(agentId: string): string {
    if (agentId === "agy" || agentId.startsWith("agy-")) {
      return this.config.AGY_COMPACTION_MODEL;
    }
    if (agentId === "claude" || agentId.startsWith("claude-")) {
      return this.config.CLAUDE_COMPACTION_MODEL;
    }
    if (
      agentId === "copilot" ||
      agentId.startsWith("copilot-") ||
      agentId === "remote"
    ) {
      return this.config.COPILOT_COMPACTION_MODEL;
    }
    if (agentId === "codex" || agentId.startsWith("codex-")) {
      return this.config.CODEX_COMPACTION_MODEL;
    }
    if (agentId === "grok" || agentId.startsWith("grok-")) {
      return this.config.GROK_COMPACTION_MODEL;
    }
    if (agentId === "zai" || agentId.startsWith("zai-")) {
      return this.config.ZAI_COMPACTION_MODEL;
    }
    if (agentId === "ollama-cloud" || agentId.startsWith("ollama-cloud-")) {
      return this.config.OLLAMA_CLOUD_COMPACTION_MODEL;
    }
    return "";
  }

  /** End-of-turn auto-compaction for agy. Mirrors the manual /compact flow
   *  (read transcript → summarize → seed the summary into a NEW session and bind
   *  the thread to it) but runs unattended when usage crosses
   *  AGY_AUTO_COMPACT_THRESHOLD. The original session is preserved. */
  private async runAgyAutoCompact(
    record: SessionRecord,
    channel: ChannelRef,
    status: TurnStatus,
    refresh: (force?: boolean) => Promise<void>,
    tokensBefore: number
  ): Promise<void> {
    const profile = this.router.getProfile(record.agentId);
    const manager = profile?.sessionManager;
    if (!profile || !manager?.getTranscript) {
      this.logger.debug({ agent: record.agentId }, "auto-compact skipped: missing manager methods");
      return;
    }

    status.setState("Working");
    status.setAction("Auto-compacting context…");
    await refresh(true);

    const compactStartedAt = Date.now();
    const thresholdPct = Math.round(this.config.AGY_AUTO_COMPACT_THRESHOLD * 100);

    // Status card so a queued follow-up message has context for why it's waiting.
    const inProgressPanel: StructuredPanel = {
      color: 0xe67e22,
      title: "🗜️ Auto-Compacting Context",
      fields: [
        { name: "Trigger", value: `≥ ${thresholdPct}% used`, inline: true },
        { name: "Before", value: fmtTokens(tokensBefore), inline: true },
        { name: "Status", value: "Generating summary…", inline: true },
      ],
    };
    let cardRef: MessageRef | undefined;
    try {
      if (this.adapter.sendPanel) {
        cardRef = await this.adapter.sendPanel(channel, inProgressPanel);
      } else {
        cardRef = await this.adapter.sendMessage(channel, serializePanelText(inProgressPanel));
      }
    } catch { /* best-effort — don't block compaction on a failed card send */ }

    const cwd = record.repoPath ?? process.cwd();
    if (!this.compactionModelFor(record.agentId)) {
      this.logger.warn({ agent: record.agentId }, "auto-compact: no compaction model configured");
      return;
    }

    let built: { seed: string; keptTurns: number; summarizedTurns: number; pinnedCount: number } | null = null;
    try {
      built = await this.buildDefaultCompactionSeed({
        profile,
        manager,
        agentId: record.agentId,
        cwd,
        sessionId: record.acpSessionId,
      });
    } catch (err) {
      this.logger.warn({ err, session: record.id }, "auto-compact: seed build failed");
      return;
    }
    if (!built) {
      this.logger.warn({ session: record.id }, "auto-compact: nothing to compact");
      return;
    }

    // Non-destructive: seed a new resumable session and bind the thread to it
    // (the original session is preserved on disk).
    const acCfg = this.store.readConfig(record);
    const acNewId = await this.seedNewSession({
      profile, cwd,
      ...(acCfg.model ? { model: acCfg.model } : {}),
      ...(acCfg.reasoningEffort ? { effort: acCfg.reasoningEffort } : {}),
      summary: built.seed,
    });
    record.acpSessionId = acNewId; // keep the in-memory record in sync (see getOrStartRuntime)
    this.store.setAcpSessionId(record.id, acNewId);
    await this.router.invalidate(record.id, { clearAcpSession: false });

    const elapsedSec = Math.round((Date.now() - compactStartedAt) / 1000);
    const summaryText = built.seed;
    // Rough estimate — 4 chars per token. The next real turn will replace this
    // with an authoritative usage_update reading.
    const tokensAfterEst = Math.ceil(summaryText.length / 4);
    const completedPanel: StructuredPanel = {
      color: 0x57f287,
      title: "✅ Compaction Complete",
      fields: [
        { name: "Before", value: fmtTokens(tokensBefore), inline: true },
        { name: "After (~)", value: fmtTokens(tokensAfterEst), inline: true },
        { name: "Duration", value: `${elapsedSec}s`, inline: true },
      ],
    };
    try {
      if (cardRef && this.adapter.editPanel) {
        await this.adapter.editPanel(cardRef, completedPanel);
      } else if (cardRef && this.adapter.editMessage) {
        await this.adapter.editMessage(cardRef, serializePanelText(completedPanel));
      } else {
        await this.adapter.sendMessage(channel, serializePanelText(completedPanel));
      }
    } catch { /* best-effort */ }
  }

  /** Build a premium-compaction `runAgent`: each call spawns a FRESH throwaway
   *  AgentRuntime (model "default" → real Opus @ 1M; the "opus[1m]" alias
   *  mis-resolves) in cwd /tmp so the analysis sessions never pollute the real
   *  project's session list, collects the agent's text, and tears down +
   *  deletes the temp session. Fresh-per-call is required: the pipeline fans out
   *  ~16 concurrent calls, and a shared session would accumulate context and
   *  mis-attribute interleaved text. */
  private makeCompactionRunAgent(
    profile: AgentProfile,
    manager: ISessionManager,
    opts?: { model?: string; cwd?: string; effort?: string }
  ): RunAgent {
    const model = opts?.model ?? "default";
    const cwd = opts?.cwd ?? "/tmp";
    // Effort MUST be passed as `opts.effort` so newSessionMeta folds it into
    // `_meta.claudeCode.options.effort` (Claude) or applyConfigOptionEffort sets
    // `reasoning_effort` (Copilot) — the paths the wrappers actually honor. (A
    // prior `meta: { reasoningEffort }` was a silent no-op.) Undefined ⇒ no knob
    // for this agent (agy is modelBaked; remote has none) — left at its default.
    const effort = opts?.effort;
    // The AGY CLI (Gemini) silently truncates stdin prompts larger than ~150KB.
    // For large prompts, write the content to a temp file and reference it.
    const LARGE_PROMPT_THRESHOLD = 100 * 1024; // 100 KB
    return async (prompt: string, label: string): Promise<string> => {
      let rt: AgentRuntime | undefined;
      let tempFile: string | undefined;
      try {
        rt = new AgentRuntime({
          profile,
          logger: this.logger.child({ compaction: label }),
          mcpServers: [],
        });
        await rt.start();
        await rt.newSession({ cwd, model, effort });
        let text = "";
        rt.onEvent((event) => {
          if (event.kind === "agent-text") text += event.text;
        });

        let actualPrompt = prompt;
        if (prompt.length > LARGE_PROMPT_THRESHOLD) {
          tempFile = path.join(os.tmpdir(), `compaction-prompt-${label}-${Date.now()}.txt`);
          await fsp.writeFile(tempFile, prompt, "utf8");
          actualPrompt =
            `Your full instructions and content have been saved to the file: ${tempFile}\n` +
            `Read that file NOW and follow all instructions in it. ` +
            `The file is ${Math.round(prompt.length / 1024)} KB. ` +
            `You MUST read the ENTIRE file before producing your response.`;
        }

        await rt.prompt(actualPrompt);
        await rt.idle();
        return text;
      } finally {
        if (tempFile) {
          await fsp.unlink(tempFile).catch(() => {});
        }
        if (rt) {
          const tempSessionId = rt.getSessionInfo()?.sessionId;
          await rt.dispose().catch(() => {});
          if (tempSessionId) {
            await manager.deleteSession(cwd, tempSessionId).catch(() => {});
          }
        }
      }
    };
  }

  /** Resolve the reasoning-effort level for a compaction tier against the
   *  AGENT'S OWN scale — effort levels are not portable across agents. Claude
   *  (low→max) deliberately uses xhigh for premium (not max) and high for cheap.
   *  A generic scale like Copilot's (low/medium/high) tops out lower, so premium
   *  takes the top level and cheap one below it. agy (modelBaked — effort IS the
   *  model choice) and the remote Mac (no effort mechanism) return undefined:
   *  there is no separate knob to set, so the runner leaves the agent's default. */
  private compactionEffortFor(profile: AgentProfile, tier: "premium" | "cheap"): string | undefined {
    const levels = profile.effort?.levels ?? [];
    if (levels.length === 0) return undefined;
    if (levels.includes("xhigh")) return tier === "premium" ? "xhigh" : "high";
    return tier === "premium"
      ? levels[levels.length - 1]
      : levels[levels.length - 2] ?? levels[levels.length - 1];
  }

  /** Render flagged Discord ranges to plain text for the deep-dive of any span
   *  where the session store is summary-only/absent (gap-detector's call). */
  private renderDiscordRanges(
    msgs: Array<{ ts: number; authorIsBot: boolean; text: string }>,
    ranges: TimeRange[]
  ): string {
    const inAny = (ts: number) =>
      ranges.some((r) => {
        const from = r.fromTs ? Date.parse(r.fromTs) : -Infinity;
        const to = r.toTs ? Date.parse(r.toTs) : Infinity;
        return ts >= from && ts <= to;
      });
    return msgs
      .filter((m) => m.text && inAny(m.ts))
      .map((m) => `[${new Date(m.ts).toISOString()}] ${m.authorIsBot ? "ASSISTANT" : "USER"}: ${m.text}`)
      .join("\n\n");
  }

  /** Run the premium multi-agent compaction pipeline for a session, READ-ONLY
   *  w.r.t. the real session (analysis runs in temp /tmp runtimes). Resolves the
   *  raw JSONL, runs mandatory gap-detection, pulls Discord only for flagged
   *  ranges, then fans out the pipeline. Returns the full result; the caller
   *  seeds the assembled summary into a new session. */
  private async runPremiumCompactionForSession(args: {
    profile: AgentProfile;
    manager: ISessionManager;
    sessionId: string;
    cwd: string;
    channel?: ChannelRef;
    onProgress?: (msg: string) => void;
  }): Promise<PremiumCompactionResult> {
    const { profile, manager, sessionId, cwd, channel, onProgress } = args;
    const log = (m: string) => { onProgress?.(m); this.logger.debug({ compaction: sessionId }, m); };

    if (!manager.getHistoryPath) {
      throw new Error(`Premium compaction needs a raw-history reader; agent \`${profile.id}\` has none.`);
    }
    const jsonlPath = await manager.getHistoryPath(cwd, sessionId);
    if (!jsonlPath) throw new Error("Could not locate the session's raw history file.");

    log("reading session history…");
    const richHistory = await readRichHistory(jsonlPath);

    // Mandatory gap-detection. Pull the thread's messages (with timestamps) when
    // the adapter supports it, both to anchor threadFirstTs and to enrich any
    // flagged ranges where Discord out-fidelities the session store.
    const coverage = await analyzeSessionCoverage(jsonlPath);
    let threadMsgs: Array<{ ts: number; authorIsBot: boolean; text: string }> = [];
    if (channel && typeof this.adapter.fetchThreadMessagesTimed === "function") {
      try { threadMsgs = await this.adapter.fetchThreadMessagesTimed(channel); }
      catch (err) { this.logger.warn({ err }, "premium-compact: thread fetch failed"); }
    }
    const threadFirstTs = threadMsgs[0]?.ts ? new Date(threadMsgs[0]!.ts).toISOString() : undefined;
    const gapReport = detectGaps({ coverage, ...(threadFirstTs ? { threadFirstTs } : {}) });

    let discordText: string | undefined;
    if (gapReport.needDiscord && threadMsgs.length > 0) {
      discordText = this.renderDiscordRanges(threadMsgs, gapReport.discordRanges);
      log(`gap-detection: ${gapReport.signals.map((s) => s.kind).join(", ")} → ${gapReport.discordRanges.length} Discord range(s)`);
    } else if (gapReport.needDiscord) {
      log(`gap-detection flagged ${gapReport.signals.length} gap(s) but Discord history is unavailable`);
    }

    // Premium tier runs every stage at the agent's top reasoning level (Claude
    // xhigh, Copilot high; agy/remote have no separate knob) — fidelity is the
    // whole point of this tier.
    const runAgent = this.makeCompactionRunAgent(profile, manager, {
      effort: this.compactionEffortFor(profile, "premium"),
    });
    return runPremiumCompaction({
      richHistory,
      gapReport,
      ...(discordText ? { discordText } : {}),
      runAgent,
      log,
    });
  }

  /** Run the premium multi-agent compaction pipeline reconstructed from the full
   *  Discord thread history. Works for any compactable agent profile. */
  private async runPremiumCompactionForDiscord(args: {
    profile: AgentProfile;
    manager: ISessionManager;
    sessionId: string;
    cwd: string;
    channel?: ChannelRef;
    onProgress?: (msg: string) => void;
  }): Promise<PremiumCompactionResult> {
    const { profile, manager, sessionId, cwd, channel, onProgress } = args;
    const log = (m: string) => { onProgress?.(m); this.logger.debug({ compaction: `discord-${sessionId}` }, m); };

    if (!channel) {
      throw new Error("Discord compaction requires an active channel context.");
    }
    if (typeof this.adapter.fetchThreadMessagesTimed !== "function") {
      throw new Error("Chat adapter does not support fetching timed thread messages.");
    }

    log("fetching thread history from Discord…");
    const threadMsgs = await this.adapter.fetchThreadMessagesTimed(channel);
    if (threadMsgs.length === 0) {
      throw new Error("No messages found in this Discord thread to compact.");
    }

    log(`fetched ${threadMsgs.length} message(s) from Discord, mapping to rich history…`);

    const events: HistoryEvent[] = threadMsgs.map((m) => ({
      kind: m.authorIsBot ? "assistant" : "user",
      ts: m.ts,
      text: m.text,
    }));

    const userTurns = events.filter((e) => e.kind === "user").length;
    const assistantTurns = events.filter((e) => e.kind === "assistant").length;
    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];
    const firstTs = firstEvent?.ts ? new Date(firstEvent.ts).toISOString() : undefined;
    const lastTs = lastEvent?.ts ? new Date(lastEvent.ts).toISOString() : undefined;
    const estimatedTokens = Math.ceil(renderHistory(events).length / 4);

    const richHistory: RichHistory = {
      events,
      stats: {
        totalEvents: events.length,
        userTurns,
        assistantTurns,
        thinkingKept: 0,
        thinkingRedactedSkipped: 0,
        toolEvents: 0,
        ...(firstTs ? { firstTs } : {}),
        ...(lastTs ? { lastTs } : {}),
        estimatedTokens,
        thinkingAvailable: false,
      },
    };

    const gapReport: GapReport = {
      signals: [],
      discordRanges: [],
      needDiscord: false,
    };

    const runAgent = this.makeCompactionRunAgent(profile, manager, {
      effort: this.compactionEffortFor(profile, "premium"),
    });
    return runPremiumCompaction({
      richHistory,
      gapReport,
      runAgent,
      log,
    });
  }

  /** Split a `getTranscript` rendering ("### User\n…\n\n### Assistant\n…") into
   *  its turn blocks, preserving order and the role headers. */
  private splitTranscriptTurns(transcript: string): string[] {
    return transcript
      .split(/\n\n(?=### (?:User|Assistant)\n)/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  /** Default-tier ("cheap") compaction seed, with the three shared wins backported
   *  (design §1): a verbatim recent window (last turns kept word-for-word), a
   *  verbatim pinned-facts block, and a visible drop-note so loss is recoverable.
   *  Returns null when there's nothing to compact or no summarizer model — the
   *  caller then keeps the legacy behavior. Works for any agent with a transcript
   *  reader; analysis runs in throwaway runtimes. */
  private async buildDefaultCompactionSeed(args: {
    profile: AgentProfile;
    manager: ISessionManager;
    agentId: string;
    cwd: string;
    sessionId: string;
    recentWindowTokens?: number;
    log?: (msg: string) => void;
  }): Promise<{ seed: string; keptTurns: number; summarizedTurns: number; pinnedCount: number } | null> {
    const { profile, manager, agentId, cwd, sessionId } = args;
    const log = args.log ?? (() => {});
    const recentWindowTokens = args.recentWindowTokens ?? 12_000;

    const transcript = await manager.getTranscript(cwd, sessionId);
    if (!transcript.trim()) return null;
    const compactionModel = this.compactionModelFor(agentId);
    if (!compactionModel) return null;

    // Split into the verbatim recent window (kept word-for-word) and the older
    // prefix (summarized). Budget by chars (~4/token).
    const turns = this.splitTranscriptTurns(transcript);
    const budgetChars = recentWindowTokens * 4;
    const recent: string[] = [];
    let chars = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
      const len = turns[i]!.length + 2;
      if (chars + len > budgetChars && recent.length > 0) break;
      recent.unshift(turns[i]!);
      chars += len;
    }
    const olderTurns = turns.slice(0, turns.length - recent.length);
    const recentVerbatim = recent.join("\n\n");
    const window = compactionWindowFor(compactionModel);
    // Cheap tier (single-pass summary): a notch below premium on each agent's
    // own scale (Claude high, Copilot medium).
    const runAgent = this.makeCompactionRunAgent(profile, manager, {
      model: compactionModel,
      cwd,
      effort: this.compactionEffortFor(profile, "cheap"),
    });

    // Summary of the older prefix via the existing single-pass template.
    let summaryMarkdown = "_(No older history beyond the recent window.)_";
    if (olderTurns.length > 0) {
      log("summarizing older history…");
      const olderText = olderTurns.join("\n\n");
      const template = await fsp.readFile("/home/ubuntu/Projects/compact.md", "utf8");
      const overhead = template.length + "\n\nConversation Transcript:\n".length;
      const fitted = fitTranscriptToWindow(olderText, overhead, window);
      summaryMarkdown = (await runAgent(`${template}\n\nConversation Transcript:\n${fitted}`, "summary")).trim();
      if (!summaryMarkdown) throw new Error("Summarizer returned empty output.");
    }

    // Verbatim pinned-facts (one pass on the fit-to-window transcript). A parse
    // failure degrades to an empty block rather than failing the whole compaction.
    log("extracting pinned facts…");
    let pinnedFacts: PinnedFacts = { corrections: [], constraints: [], decisions: [], openTodos: [], activePaths: [], rules: [] };
    try {
      const fittedAll = fitTranscriptToWindow(transcript, 0, window);
      const raw = await runAgent(pinnedFactsPrompt({ text: fittedAll, thinkingAvailable: false }), "pinned");
      pinnedFacts = mergePinnedFacts([parseJsonOutput<PinnedFacts>(raw)]);
    } catch (err) {
      this.logger.warn({ err, sessionId }, "default-compact: pinned-facts extraction failed; continuing without it");
    }

    const pinnedCount =
      pinnedFacts.corrections.length + pinnedFacts.constraints.length + pinnedFacts.rules.length +
      pinnedFacts.openTodos.length + pinnedFacts.activePaths.length;
    const dropNote =
      `## Compaction note\n` +
      `- Summarized ${olderTurns.length} older turn(s); kept the last ${recent.length} verbatim below.\n` +
      `- Pinned ${pinnedCount} verbatim constraint(s)/correction(s)/rule(s)/path(s).\n` +
      `- If something important seems missing, the full prior transcript is recoverable from the Discord thread (and the session's pre-compaction history).`;

    const seed = assembleNewSession({ summaryMarkdown, pinnedFacts, recentVerbatim, dropNote });
    return { seed, keptTurns: recent.length, summarizedTurns: olderTurns.length, pinnedCount };
  }

  /** Full human-readable report of a premium-compaction run (critic verdicts,
   *  recovery requests, pinned facts, the assembled seed) so the detail is
   *  reviewable beyond the Discord summary card. */
  private formatPremiumReport(result: PremiumCompactionResult, sessionId: string): string {
    return [
      `# Premium compaction report — ${sessionId}`,
      ``,
      `- Stats: ${JSON.stringify(result.stats)}`,
      ``,
      `---`,
      ``,
      `## Pinned facts (verbatim)`, "```json", JSON.stringify(result.pinnedFacts, null, 2), "```",
      ``, `---`, ``,
      `## Assembled session seed`, ``, result.assembledSeed,
    ].join("\n");
  }

  /** Non-destructive compaction primitive (the user's original design): create a
   *  BRAND-NEW session via the SDK and seed it by sending the summary as the
   *  first prompt — a real turn Claude Code writes itself, so it RESUMES cleanly
   *  (unlike overwriting a JSONL with a synthetic assistant message, which hangs
   *  on `--resume`). Returns the new session id; the caller binds the thread to
   *  it and the original session is left intact (recoverable / deletable). */
  private async seedNewSession(args: {
    profile: AgentProfile;
    cwd: string;
    model?: string;
    effort?: string;
    summary: string;
  }): Promise<string> {
    const { profile, cwd, model, effort, summary } = args;
    let rt: AgentRuntime | undefined;
    try {
      rt = new AgentRuntime({ profile, logger: this.logger.child({ compaction: "seed" }), mcpServers: [] });
      await rt.start();
      const info = await rt.newSession({ cwd, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      const prompt =
        "[Loading prior-session context after compaction — read the summary below, reply with a one-line acknowledgement, then await the next instruction. Do not begin work yet.]\n\n" +
        summary;
      await rt.prompt(prompt);
      // Brief pause so Claude Code finishes flushing the new session's JSONL
      // before we tear down (the turn is the only content; it must land on disk).
      await new Promise((r) => setTimeout(r, 1000));
      return info.sessionId;
    } finally {
      if (rt) await rt.dispose().catch(() => {});
    }
  }

  setScheduledManager(m: ScheduledPromptManager): void {
    this.scheduledManager = m;
  }

  /** Manager `onFire` handler: run a scheduled prompt as an **isolated job** (own
   *  throwaway session, thread's repo + model + attachments) and post the output
   *  to the thread as blue cards. Owns last_run/last_status only — the manager
   *  owns next_run. Read-only w.r.t. the thread's live session. */
  async runScheduledPrompt(id: string): Promise<void> {
    const row = this.store.getScheduled(id);
    if (!row) return;
    // Count scheduled jobs in the restart-drain counter (activeTurns) so a
    // redeploy/sentinel waits for an in-flight job to finish instead of killing
    // its agent child mid-run.
    this.activeTurns++;
    try {
      await this.runScheduledPromptInner(row);
    } finally {
      this.activeTurns--;
    }
  }

  private async runScheduledPromptInner(row: ScheduledPrompt): Promise<void> {
    const id = row.id;
    const bindingThread: ChannelRef = {
      platform: PLATFORM,
      id: row.channelRef,
      ...(row.parentRef ? { parentId: row.parentRef } : {}),
    };
    // Output goes to the configured target channel, or the schedule's own thread.
    const target: ChannelRef = row.targetChannel
      ? { platform: PLATFORM, id: row.targetChannel }
      : bindingThread;

    // 1. Can we post to the output target? run / skip-locked / drop-deleted.
    if (typeof this.adapter.getThreadLiveState === "function") {
      let state: { locked: boolean; archived: boolean } | undefined;
      try {
        state = await this.adapter.getThreadLiveState(target);
      } catch (err) {
        this.logger.warn({ id, err }, "scheduled: target state check failed (transient); skipping");
        this.patchScheduledStatus(id, "skipped: target unreachable");
        return;
      }
      if (state === undefined) {
        if (target.id === row.channelRef) {
          // The schedule's own (binding) thread is gone — drop the schedule.
          this.logger.info({ id, channel: row.channelRef }, "scheduled: thread deleted; dropping schedule");
          this.store.deleteScheduled(id);
          this.scheduledManager?.disarm(id);
          await deleteScheduledAttachmentDir(this.config.DATA_DIR, id).catch(() => {});
        } else {
          this.patchScheduledStatus(id, "skipped: target deleted");
        }
        return;
      }
      if (state.locked) {
        this.patchScheduledStatus(id, "skipped: target locked");
        return;
      }
    }

    // 2. Resolve the agent / model / cwd from the binding thread's record,
    //    with per-schedule overrides.
    const record = this.router.ensureSessionRecord({
      platform: PLATFORM,
      channelRef: row.channelRef,
      ...(row.parentRef ? { parentRef: row.parentRef } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const profile = this.router.getProfile(record.agentId);
    if (!profile) {
      this.patchScheduledStatus(id, `error: unknown agent ${record.agentId}`);
      return;
    }
    const cfg = this.store.readConfig(record);
    const cwd = row.cwd ?? record.repoPath ?? this.config.REPOS_ROOT;
    const model = row.model ?? cfg.model;

    // 3. Announce card — stays as a permanent run record (also auto-reopens an
    //    archived-but-unlocked thread). Not edited later.
    const running: StructuredPanel = {
      color: SCHEDULED_COLOR,
      title: `⏰ Running scheduled: ${row.name}`,
      fields: [
        { name: "Schedule", value: `${describeCron(row.cron)} (${row.timezone})` },
        { name: "Working dir", value: `\`${cwd}\``, inline: true },
        { name: "Model", value: model ? `\`${model}\`` : "session default", inline: true },
        ...(row.attachments.length
          ? [{ name: "Files", value: row.attachments.map((a) => `\`${a.filename}\``).join(", ") }]
          : []),
      ],
      footer: `id ${id} · output: ${row.outputType}`,
    };
    try {
      if (this.adapter.sendPanel) await this.adapter.sendPanel(target, running);
      else await this.adapter.sendMessage(target, `⏰ Running scheduled prompt "${row.name}"…`);
    } catch (err) {
      this.logger.warn({ id, err }, "scheduled: announce card failed");
    }

    // 4. Run isolated + capture. Stage non-inlineable files (PDF/Office/HEIC/…)
    //    to a path the agent reads with its tools — same handling as a live turn,
    //    so scheduled jobs aren't limited to text/image attachments.
    const loaded = await loadScheduledAttachments(this.config.DATA_DIR, id, row.attachments);
    const { inline, hint } = profile.restrictDiscordAccess
      ? { inline: loaded, hint: null as string | null }
      : await this.partitionAndStageAttachments(loaded);
    const result = await this.runIsolatedScheduledJob({
      profile,
      cwd,
      ...(model ? { model } : {}),
      ...(cfg.reasoningEffort ? { effort: cfg.reasoningEffort } : {}),
      channel: target,
      promptText: hint ? `${row.promptText}${hint}` : row.promptText,
      attachments: inline,
    });

    // 5. Post result as NEW message(s) + record status.
    if (result.error) {
      this.patchScheduledStatus(id, `error: ${result.error.slice(0, 200)}`);
      await this.sendResultCard(target, `⏰ ${row.name} — failed`, `❌ ${result.error.slice(0, 1500)}`, 0xe74c3c);
    } else {
      this.patchScheduledStatus(id, "ok");
      await this.postScheduledResult(target, row.name, result.text, row.outputType);
    }
  }

  /** Spawn a throwaway runtime, run one prompt with attachments, collect the
   *  text, forward any files the agent produced to the thread, then tear down
   *  and delete the temp session (so it doesn't clutter `/seam sessions`). */
  private async runIsolatedScheduledJob(args: {
    profile: AgentProfile;
    cwd: string;
    model?: string;
    effort?: string;
    channel: ChannelRef;
    promptText: string;
    attachments: MessageAttachment[];
  }): Promise<{ text: string; error?: string }> {
    const { profile, cwd, model, effort, channel, promptText, attachments } = args;
    const manager = profile.sessionManager;
    let rt: AgentRuntime | undefined;
    let text = "";
    try {
      rt = new AgentRuntime({ profile, logger: this.logger.child({ scheduled: "run" }), mcpServers: [] });
      await rt.start();
      await rt.newSession({ cwd, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      rt.onEvent(async (event) => {
        if (event.kind === "agent-text") {
          text += event.text;
        } else if (event.kind === "agent-file") {
          try {
            if (this.adapter.sendFile) {
              const data = event.base64
                ? Buffer.from(event.data, "base64")
                : Buffer.from(event.data, "utf8");
              await this.adapter.sendFile(channel, { data, filename: event.filename, mimeType: event.mimeType });
            }
          } catch (err) {
            this.logger.warn({ err }, "scheduled: forward agent file failed");
          }
        }
      });
      const outcome = await raceWithTimeout(
        rt.prompt(promptText, attachments.length ? attachments : undefined),
        this.config.TURN_TIMEOUT_SECONDS * 1000
      );
      if (outcome === "timeout") {
        return { text, error: `timed out after ${this.config.TURN_TIMEOUT_SECONDS}s` };
      }
      return { text };
    } catch (err) {
      return { text, error: (err as Error).message };
    } finally {
      if (rt) {
        const sid = rt.getSessionInfo()?.sessionId;
        await rt.dispose().catch(() => {});
        if (sid && manager?.deleteSession) {
          await manager.deleteSession(cwd, sid).catch(() => {});
        }
      }
    }
  }

  /** Post captured output as fresh message(s) — blue cards or plain chunked
   *  messages per `outputType`; overflow → a single file attachment. Never edits
   *  the running card (it stays as a run record). */
  private async postScheduledResult(
    channel: ChannelRef,
    name: string,
    text: string,
    outputType: "card" | "messages"
  ): Promise<void> {
    const body = text.trim();
    if (!body) {
      await this.sendResultCard(channel, `⏰ ${name}`, "✅ Done — no output.", SCHEDULED_COLOR);
      return;
    }

    if (outputType === "messages") {
      const chunks = this.chunkString(body, 1900);
      if (chunks.length <= 8) {
        for (const c of chunks) await this.adapter.sendMessage(channel, c);
      } else {
        await this.adapter.sendMessage(channel, `⏰ **${name}** — output attached (${body.length} chars).`);
        await this.sendResultFile(channel, name, body);
      }
      return;
    }

    // card output
    const chunks = this.chunkString(body, 3900);
    if (chunks.length <= 3) {
      for (let j = 0; j < chunks.length; j++) {
        const suffix = chunks.length > 1 ? ` (${j + 1}/${chunks.length})` : "";
        await this.sendResultCard(channel, `⏰ ${name}${suffix}`, chunks[j]!, SCHEDULED_COLOR);
      }
    } else {
      await this.sendResultCard(channel, `⏰ ${name}`, `✅ Done — full output attached (${body.length} chars).`, SCHEDULED_COLOR);
      await this.sendResultFile(channel, name, body);
    }
  }

  private chunkString(s: string, max: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
    return out;
  }

  /** Split attachments into those the model reads inline (text + supported
   *  images → `inline`) and the rest (PDF/Office/HEIC/binary), which are staged
   *  to a temp path the agent opens with its file tools and described in `hint`.
   *  Shared by the live-turn path and the scheduled fire runner so both handle
   *  non-inlineable files identically. Works for https CDN and data: URLs. */
  private async partitionAndStageAttachments(
    attachments: ReadonlyArray<MessageAttachment>
  ): Promise<{ inline: MessageAttachment[]; hint: string | null }> {
    const STAGE_MAX = 100 * 1024 * 1024; // don't fill /tmp with huge files
    const inline: MessageAttachment[] = [];
    const stagedLines: string[] = [];
    const batchId = randomUUID().slice(0, 8);
    for (const a of attachments) {
      if (isModelInlineableAttachment(a.contentType ?? "", a.filename)) {
        inline.push(a);
        continue;
      }
      if (a.size > STAGE_MAX) {
        stagedLines.push(`- \`${a.filename}\` — too large to stage (${a.size} B)`);
        continue;
      }
      try {
        const res = await fetch(a.url);
        if (!res.ok) throw new Error(`download ${res.status} ${res.statusText}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const dest = await stageAttachment(a.filename, buf, batchId);
        stagedLines.push(`- \`${a.filename}\` → \`${dest}\``);
      } catch (err) {
        this.logger.warn({ err, filename: a.filename }, "failed to stage attachment");
        stagedLines.push(`- \`${a.filename}\` — could not be downloaded`);
      }
    }
    if (stagedLines.length === 0) return { inline, hint: null };
    void sweepStagedAttachments();
    const one = stagedLines.length === 1;
    const hint =
      `\n\n_The following file${one ? " was" : "s were"} saved to a temporary directory ` +
      `(auto-cleaned after ~48h) — read ${one ? "it" : "them"} with your file tools, and copy ` +
      `into the workspace anything you need to keep:_\n${stagedLines.join("\n")}`;
    return { inline, hint };
  }

  private async sendResultCard(channel: ChannelRef, title: string, description: string, color: number): Promise<void> {
    const p: StructuredPanel = { color, title, description: description.slice(0, 4096), fields: [] };
    if (this.adapter.sendPanel) await this.adapter.sendPanel(channel, p);
    else await this.adapter.sendMessage(channel, `${title}\n${description}`);
  }

  private async sendResultFile(channel: ChannelRef, name: string, body: string): Promise<void> {
    const filename = `scheduled-${name.replace(/[^\w.-]+/g, "_") || "output"}.md`;
    if (this.adapter.sendFile) {
      await this.adapter.sendFile(channel, { data: Buffer.from(body, "utf8"), filename, mimeType: "text/markdown" });
    } else {
      for (const c of this.chunkString(body, 1900)) await this.adapter.sendMessage(channel, c);
    }
  }

  /** Update last_run/last_status, preserving next_run (manager-owned). */
  private patchScheduledStatus(id: string, status: string): void {
    const fresh = this.store.getScheduled(id);
    if (!fresh) return;
    this.store.upsertScheduled({ ...fresh, lastStatus: status, lastRunUtc: new Date().toISOString() });
  }

  // --- /seam schedule … -----------------------------------------------------

  private async cmdSchedule(i: ChatInputCommandInteraction): Promise<void> {
    const sub = i.options.getSubcommand(true);
    switch (sub) {
      case "add": return this.cmdScheduleAdd(i);
      case "edit": return this.cmdScheduleEdit(i);
      case "list": return this.cmdScheduleList(i);
      case "remove": return this.cmdScheduleRemove(i);
      case "toggle": return this.cmdScheduleToggle(i);
      case "addfile": return this.cmdScheduleAddFile(i);
      case "removefile": return this.cmdScheduleRemoveFile(i);
      default:
        await i.reply({ content: `Unknown schedule subcommand: ${sub}`, flags: MessageFlags.Ephemeral });
    }
  }

  /** Download a Discord attachment's bytes (URL is valid now; we persist them
   *  because Discord CDN URLs expire ~24h). */
  private async downloadAttachmentBytes(url: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  private scheduleSummaryLine(s: ScheduledPrompt): string {
    const state = s.enabled ? "🟢" : "⏸️";
    const last = s.lastStatus ? ` · last: ${s.lastStatus}` : "";
    const next = s.enabled && s.nextRunUtc ? ` · next: <t:${Math.floor(Date.parse(s.nextRunUtc) / 1000)}:R>` : "";
    const files = s.attachments.length ? ` · 📎${s.attachments.length}` : "";
    const model = s.model ? ` · 🤖${s.model}` : "";
    return `${state} **${s.name}** \`${s.id}\`\n   ${describeCron(s.cron)} (${s.timezone})${model}${files}${next}${last}`;
  }

  private async cmdScheduleList(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({ content: "Use this inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const rows = this.store.listScheduledByChannel(PLATFORM, channel.id);
    if (rows.length === 0) {
      await i.reply({ content: `No scheduled prompts for this thread. Create one with \`/${this.cmd} schedule add\`.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await i.reply({ ...this.buildScheduleListMessage(channel), flags: MessageFlags.Ephemeral });
    const msg = await i.fetchReply();
    const collector = msg.createMessageComponentCollector({
      filter: (c) => c.user.id === i.user.id,
      time: 600_000,
    });
    collector.on("collect", async (c) => {
      try {
        if (!c.isButton()) return;
        const [, action, id] = c.customId.split(":");
        const row = id ? this.store.getScheduled(id) : undefined;
        if (!row || !id || row.channelRef !== channel.id) {
          await c.reply({ content: "That schedule no longer exists.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (action === "edit") {
          collector.stop("edit");
          await this.cmdScheduleAdd(c, row); // opens the builder card in edit mode
        } else if (action === "toggle") {
          const updated: ScheduledPrompt = { ...row, enabled: !row.enabled, updatedUtc: new Date().toISOString() };
          this.store.upsertScheduled(updated);
          if (updated.enabled) this.scheduledManager?.armFromRow(updated);
          else this.scheduledManager?.disarm(id);
          await c.update(this.buildScheduleListMessage(channel));
        } else if (action === "del") {
          this.scheduledManager?.disarm(id);
          this.store.deleteScheduled(id);
          await deleteScheduledAttachmentDir(this.config.DATA_DIR, id).catch(() => {});
          await c.update(this.buildScheduleListMessage(channel));
        }
      } catch (err) {
        this.logger.warn({ err }, "schedule-list button handler failed");
      }
    });
  }

  /** `/seam schedule list` message: a summary embed plus per-schedule
   *  Edit / Enable-Disable / Delete buttons (first 5 schedules; manage the rest
   *  via the id-based `/seam schedule …` commands). Rebuilt after toggle/delete. */
  private buildScheduleListMessage(channel: ChannelRef): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
  } {
    const rows = this.store.listScheduledByChannel(PLATFORM, channel.id);
    const embed = new EmbedBuilder()
      .setTitle("⏰ Scheduled prompts")
      .setColor(SCHEDULED_COLOR)
      .setDescription(
        rows.length
          ? rows.map((r) => this.scheduleSummaryLine(r)).join("\n\n")
          : "_No scheduled prompts for this thread._"
      );
    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    for (const r of rows.slice(0, 5)) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`sl:edit:${r.id}`).setLabel(`✏️ ${r.name}`.slice(0, 80)).setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`sl:toggle:${r.id}`).setLabel(r.enabled ? "⏸️ Disable" : "🟢 Enable").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`sl:del:${r.id}`).setLabel("🗑️ Delete").setStyle(ButtonStyle.Danger),
        )
      );
    }
    return { embeds: [embed], components };
  }

  private async cmdScheduleRemove(i: ChatInputCommandInteraction): Promise<void> {
    const id = i.options.getString("id", true);
    const row = this.store.getScheduled(id);
    const channel = this.channelRefFromInteraction(i);
    if (!row || !channel || row.channelRef !== channel.id) {
      await i.reply({ content: `No schedule \`${id}\` in this thread.`, flags: MessageFlags.Ephemeral });
      return;
    }
    this.scheduledManager?.disarm(id);
    this.store.deleteScheduled(id);
    await deleteScheduledAttachmentDir(this.config.DATA_DIR, id).catch(() => {});
    await i.reply({ content: `🗑️ Deleted scheduled prompt **${row.name}** (\`${id}\`).`, flags: MessageFlags.Ephemeral });
  }

  private async cmdScheduleToggle(i: ChatInputCommandInteraction): Promise<void> {
    const id = i.options.getString("id", true);
    const row = this.store.getScheduled(id);
    const channel = this.channelRefFromInteraction(i);
    if (!row || !channel || row.channelRef !== channel.id) {
      await i.reply({ content: `No schedule \`${id}\` in this thread.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const updated: ScheduledPrompt = { ...row, enabled: !row.enabled, updatedUtc: new Date().toISOString() };
    this.store.upsertScheduled(updated);
    if (updated.enabled) this.scheduledManager?.armFromRow(updated);
    else this.scheduledManager?.disarm(id);
    await i.reply({
      content: `${updated.enabled ? "🟢 Enabled" : "⏸️ Disabled"} **${row.name}** (\`${id}\`).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdScheduleAddFile(i: ChatInputCommandInteraction): Promise<void> {
    const id = i.options.getString("id", true);
    const file = i.options.getAttachment("file", true);
    const row = this.store.getScheduled(id);
    const channel = this.channelRefFromInteraction(i);
    if (!row || !channel || row.channelRef !== channel.id) {
      await i.reply({ content: `No schedule \`${id}\` in this thread.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const bytes = await this.downloadAttachmentBytes(file.url);
      const saved = await saveScheduledAttachment(this.config.DATA_DIR, id, {
        filename: file.name,
        mime: file.contentType ?? "application/octet-stream",
        bytes,
      });
      const updated: ScheduledPrompt = {
        ...row,
        attachments: [...row.attachments.filter((a) => a.filename !== saved.filename), saved],
        updatedUtc: new Date().toISOString(),
      };
      this.store.upsertScheduled(updated);
      await i.editReply(`📎 Added \`${saved.filename}\` to **${row.name}** (${updated.attachments.length} file(s)).`);
    } catch (err) {
      await i.editReply(`❌ Failed to add file: ${(err as Error).message}`);
    }
  }

  private async cmdScheduleRemoveFile(i: ChatInputCommandInteraction): Promise<void> {
    const id = i.options.getString("id", true);
    const filename = i.options.getString("filename", true);
    const row = this.store.getScheduled(id);
    const channel = this.channelRefFromInteraction(i);
    if (!row || !channel || row.channelRef !== channel.id) {
      await i.reply({ content: `No schedule \`${id}\` in this thread.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await deleteScheduledAttachment(this.config.DATA_DIR, id, filename).catch(() => {});
    const updated: ScheduledPrompt = {
      ...row,
      attachments: row.attachments.filter((a) => a.filename !== filename),
      updatedUtc: new Date().toISOString(),
    };
    this.store.upsertScheduled(updated);
    await i.reply({ content: `🗑️ Removed \`${filename}\` from **${row.name}**.`, flags: MessageFlags.Ephemeral });
  }

  private async cmdScheduleEdit(i: ChatInputCommandInteraction): Promise<void> {
    const id = i.options.getString("id", true);
    const row = this.store.getScheduled(id);
    const channel = this.channelRefFromInteraction(i);
    if (!row || !channel || row.channelRef !== channel.id) {
      await i.reply({ content: `No schedule \`${id}\` in this thread.`, flags: MessageFlags.Ephemeral });
      return;
    }
    return this.cmdScheduleAdd(i, row);
  }

  /** Shared builder card for create (existing undefined) and edit (existing set).
   *  In edit mode the schedule's stored attachments are managed separately via
   *  addfile/removefile; the card edits prompt/schedule/model/cwd/output. */
  private async cmdScheduleAdd(i: ChatInputCommandInteraction | MessageComponentInteraction, existing?: ScheduledPrompt): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({ content: `Use \`/${this.cmd} schedule add\` inside a thread.`, flags: MessageFlags.Ephemeral });
      return;
    }
    // Bind the thread to a session record if it isn't already (so the job has a
    // repo/agent to run under).
    const record = this.router.ensureSessionRecord({
      platform: PLATFORM,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const profile = this.router.getProfile(record.agentId);
    const cfg = this.store.readConfig(record);
    const sessionModel = cfg.model ?? profile?.defaultModel ?? null;
    const models = (profile?.staticModels ?? []).slice(0, 24);

    // Capture any files supplied on the command (references held; bytes fetched
    // on Create, while the URLs are still valid).
    const pending: Array<{ name: string; url: string; mime: string }> = [];
    if (i.isChatInputCommand()) {
      for (const opt of ["file", "file2", "file3"]) {
        const a = i.options.getAttachment(opt, false);
        if (a) pending.push({ name: a.name, url: a.url, mime: a.contentType ?? "application/octet-stream" });
      }
    }

    const state = {
      name: existing?.name ?? "",
      promptText: existing?.promptText ?? "",
      cron: (existing?.cron ?? null) as string | null,
      timezone: existing?.timezone ?? SCHEDULE_DEFAULT_TZ,
      model: existing?.model ?? null, // null = use session model
      cwd: existing?.cwd ?? null, // null = thread's repoPath
      target: existing?.targetChannel ?? null, // null = this thread
      outputType: (existing?.outputType ?? "card") as "card" | "messages",
      files: pending,
    };
    // Edit mode: manage the row's stored attachments live — remove via the select
    // on the card, add via `/seam schedule addfile` (Discord cards can't accept a
    // file upload). Mutable copy so Save writes the current set, not the stale
    // original spread from `existing`.
    const editFiles = existing ? [...existing.attachments] : [];

    const render = () => {
      const cronLine = state.cron
        ? `${describeCron(state.cron)} \`${state.cron}\``
        : "*(not set)*";
      const next = state.cron ? cronNextRun(state.cron, state.timezone) : null;
      const filesValue = existing
        ? (editFiles.length
            ? editFiles.map((a) => `\`${a.filename}\``).join(", ") + ` · *(remove below; add via \`/${this.cmd} schedule addfile\`)*`
            : `*(none — add via \`/${this.cmd} schedule addfile\`)*`)
        : (state.files.length ? state.files.map((f) => `\`${f.name}\``).join(", ") : "*(none)*");
      const embed = new EmbedBuilder()
        .setTitle(existing ? `✏️ Edit scheduled prompt \`${existing.id}\`` : "⏰ New scheduled prompt")
        .setColor(SCHEDULED_COLOR)
        .setDescription(
          "This runs **on its own, on a clean session** — it won't remember this conversation. " +
          "Write the prompt so it stands alone, and attach any files it needs (re-sent every run)."
        )
        .addFields(
          { name: "🏷️ Name", value: state.name || "*(not set)*" },
          { name: "✏️ Prompt", value: state.promptText ? "```\n" + state.promptText.slice(0, 1000) + "\n```" : "*(not set — click ✏️ Prompt & name)*" },
          { name: "🕐 Runs", value: cronLine + (next ? `\nNext: <t:${Math.floor(next.getTime() / 1000)}:F>` : ""), inline: true },
          { name: "🌍 Timezone", value: state.timezone, inline: true },
          { name: "🤖 Model", value: state.model ? `\`${state.model}\`` : `Session default${sessionModel ? ` (\`${sessionModel}\`)` : ""}`, inline: true },
          { name: "📂 Working dir", value: state.cwd ? `\`${state.cwd}\`` : "*(this thread's repo)*", inline: true },
          { name: "📮 Output to", value: state.target ? `<#${state.target}>` : "*(this thread)*", inline: true },
          { name: "🖼️ Output as", value: state.outputType === "messages" ? "plain messages" : "status cards", inline: true },
          { name: "📎 Files", value: filesValue }
        );
      const cadence = new StringSelectMenuBuilder()
        .setCustomId("sched:cadence")
        .setPlaceholder("🕐 How often?")
        .addOptions(SCHEDULE_PRESETS.map((p) => ({ label: p.label, value: p.value })));
      const tz = new StringSelectMenuBuilder()
        .setCustomId("sched:tz")
        .setPlaceholder("🌍 Timezone")
        .addOptions(SCHEDULE_TIMEZONES.map((z) => ({ label: z, value: z, default: z === state.timezone })));
      const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("sched:prompt").setLabel("✏️ Prompt & details").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("sched:output").setLabel(state.outputType === "messages" ? "🖼️ Output: messages" : "🖼️ Output: cards").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("sched:create").setLabel(existing ? "💾 Save" : "✅ Create").setStyle(ButtonStyle.Success).setDisabled(!state.cron || !state.promptText || !state.name),
        new ButtonBuilder().setCustomId("sched:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      );
      const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(cadence),
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(tz),
      ];
      if (models.length > 0) {
        const modelSelect = new StringSelectMenuBuilder()
          .setCustomId("sched:model")
          .setPlaceholder("🤖 Model")
          .addOptions(
            { label: `Session default${sessionModel ? ` (${sessionModel})` : ""}`.slice(0, 100), value: "__default__", default: state.model === null },
            ...models.map((m) => ({ label: m.name.slice(0, 100), value: m.modelId, default: m.modelId === state.model }))
          );
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modelSelect));
      }
      rows.push(buttons);
      // Edit mode with files: a select to remove one (removal persists live).
      if (existing && editFiles.length > 0) {
        const rmfile = new StringSelectMenuBuilder()
          .setCustomId("sched:rmfile")
          .setPlaceholder("🗑️ Remove a file…")
          .addOptions(editFiles.slice(0, 25).map((a) => ({ label: a.filename.slice(0, 100), value: a.filename })));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(rmfile));
      }
      return { embeds: [embed], components: rows };
    };

    await i.reply({ ...render(), flags: MessageFlags.Ephemeral });
    const msg = await i.fetchReply();
    const collector = msg.createMessageComponentCollector({
      filter: (c) => c.user.id === i.user.id,
      time: 600_000,
    });

    // If the builder times out with nothing saved, clear the (now-inert) buttons
    // and say so. Otherwise the card sits there looking clickable but dead — a
    // second silent-failure path on top of the Create no-op: the user keeps
    // clicking a timed-out builder and nothing happens or persists.
    collector.on("end", async (_collected, reason) => {
      // "created"/"saved"/"cancel" already replaced the message; only handle the
      // timeout (and ignore message-deleted, where there's nothing to edit).
      if (reason !== "time") return;
      try {
        await i.editReply({
          content: "⏰ Schedule builder timed out — nothing was saved. Run the schedule builder again to start over.",
          embeds: [],
          components: [],
        });
      } catch {
        /* interaction token expired (>15 min) — nothing we can edit */
      }
    });

    collector.on("collect", async (c) => {
      try {
        if (c.isStringSelectMenu() && c.customId === "sched:tz") {
          state.timezone = c.values[0]!;
          await c.update(render());
        } else if (c.isStringSelectMenu() && c.customId === "sched:model") {
          const v = c.values[0]!;
          state.model = v === "__default__" ? null : v;
          await c.update(render());
        } else if (c.isStringSelectMenu() && c.customId === "sched:rmfile") {
          // Remove a stored file immediately (matches /seam schedule removefile),
          // independent of Save; keep editFiles in sync so Save writes the rest.
          const filename = c.values[0]!;
          if (existing) {
            await deleteScheduledAttachment(this.config.DATA_DIR, existing.id, filename).catch(() => {});
            const idx = editFiles.findIndex((a) => a.filename === filename);
            if (idx >= 0) editFiles.splice(idx, 1);
            this.store.upsertScheduled({ ...existing, attachments: editFiles, updatedUtc: new Date().toISOString() });
          }
          await c.update(render());
        } else if (c.isStringSelectMenu() && c.customId === "sched:cadence") {
          const v = c.values[0]!;
          if (v === "__custom__") {
            const modal = new ModalBuilder().setCustomId(`sched:cronmodal:${msg.id}`).setTitle("Custom schedule")
              .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId("cron").setLabel("Cron expression (min hour dom mon dow)")
                  .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("0 9 * * 1-5")
              ));
            await c.showModal(modal);
            const sub = await c.awaitModalSubmit({ filter: (m) => m.customId === `sched:cronmodal:${msg.id}` && m.user.id === i.user.id, time: 120_000 }).catch(() => null);
            if (sub) {
              const cron = sub.fields.getTextInputValue("cron").trim();
              const v2 = validateCron(cron, state.timezone);
              if (!v2.ok) {
                await sub.reply({ content: `❌ Invalid cron: ${v2.error}`, flags: MessageFlags.Ephemeral });
              } else {
                state.cron = cron;
                await sub.deferUpdate();
                await i.editReply(render());
              }
            }
          } else {
            state.cron = v;
            await c.update(render());
          }
        } else if (c.isButton() && c.customId === "sched:output") {
          state.outputType = state.outputType === "messages" ? "card" : "messages";
          await c.update(render());
        } else if (c.isButton() && c.customId === "sched:prompt") {
          const modal = new ModalBuilder().setCustomId(`sched:promptmodal:${msg.id}`).setTitle("Prompt & details")
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId("name").setLabel("Name").setStyle(TextInputStyle.Short).setRequired(true).setValue(state.name).setMaxLength(80)
              ),
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId("prompt").setLabel("Prompt (stands on its own — no prior context)")
                  .setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(state.promptText)
                  .setPlaceholder("e.g. Run `npm test`, then post any failures as file:line with a one-line fix.")
              ),
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId("cwd").setLabel("Working dir (optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(state.cwd ?? "")
                  .setPlaceholder("blank = this thread's repo; or a path under REPOS_ROOT")
              ),
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId("target").setLabel("Output channel/thread id (optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(state.target ?? "")
                  .setPlaceholder("blank = post here; or a numeric channel/thread id")
              )
            );
          await c.showModal(modal);
          const sub = await c.awaitModalSubmit({ filter: (m) => m.customId === `sched:promptmodal:${msg.id}` && m.user.id === i.user.id, time: 600_000 }).catch(() => null);
          if (sub) {
            state.name = sub.fields.getTextInputValue("name").trim();
            state.promptText = sub.fields.getTextInputValue("prompt").trim();
            const errors: string[] = [];
            const rawCwd = sub.fields.getTextInputValue("cwd").trim();
            if (rawCwd) {
              try { state.cwd = resolveRepoPath(this.config.REPOS_ROOT, rawCwd); }
              catch (e) { errors.push(`cwd: ${(e as Error).message}`); }
            } else state.cwd = null;
            const rawTarget = sub.fields.getTextInputValue("target").trim();
            if (rawTarget) {
              if (/^\d+$/.test(rawTarget)) state.target = rawTarget;
              else errors.push("output id must be a numeric channel/thread id");
            } else state.target = null;
            await sub.deferUpdate();
            await i.editReply(render());
            if (errors.length) await sub.followUp({ content: `⚠️ ${errors.join("; ")}`, flags: MessageFlags.Ephemeral });
          }
        } else if (c.isButton() && c.customId === "sched:cancel") {
          collector.stop("cancel");
          await c.update({ content: "Cancelled.", embeds: [], components: [] });
        } else if (c.isButton() && c.customId === "sched:create") {
          await c.deferUpdate();
          // Don't silently no-op on a half-filled form. Clicking Create with an
          // unset name/prompt/cadence previously just vanished (deferUpdate ack'd
          // the click, then `return`), so a schedule the user believed they had
          // created was never persisted and never ran. Tell them what's missing
          // and keep the builder open. (Single combined guard so TS narrows the
          // three fields to non-null for the row construction below.)
          if (!state.name || !state.promptText || !state.cron) {
            const missing: string[] = [];
            if (!state.name) missing.push("a name");
            if (!state.promptText) missing.push("a prompt");
            if (!state.cron) missing.push("a cadence/schedule");
            await c.followUp({
              content: `⚠️ Not created yet — still need ${missing.join(", ")}. Use **Prompt & details** to set the name + prompt and pick a cadence, then click Create.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const now = new Date().toISOString();
          const next = cronNextRun(state.cron, state.timezone);
          let row: ScheduledPrompt;
          if (existing) {
            // Edit: preserve id, created*, enabled, last-run. Use editFiles (the
            // live-managed set) for attachments so a file removed via the card's
            // select isn't re-added by spreading the stale `existing`.
            row = {
              ...existing,
              name: state.name, promptText: state.promptText, cron: state.cron, timezone: state.timezone,
              model: state.model, cwd: state.cwd, targetChannel: state.target, outputType: state.outputType,
              attachments: editFiles,
              updatedUtc: now, nextRunUtc: next ? next.toISOString() : null,
            };
            this.store.upsertScheduled(row);
            this.scheduledManager?.reschedule(existing.id);
          } else {
            const id = `sch_${randomUUID().slice(0, 8)}`;
            const attachments = [];
            for (const f of state.files) {
              try {
                const bytes = await this.downloadAttachmentBytes(f.url);
                attachments.push(await saveScheduledAttachment(this.config.DATA_DIR, id, { filename: f.name, mime: f.mime, bytes }));
              } catch (err) {
                this.logger.warn({ err, file: f.name }, "schedule: file download failed");
              }
            }
            row = {
              id, platform: PLATFORM, channelRef: channel.id, parentRef: channel.parentId ?? null,
              name: state.name, promptText: state.promptText, cron: state.cron, timezone: state.timezone,
              model: state.model, cwd: state.cwd, targetChannel: state.target, outputType: state.outputType,
              catchupSeconds: 900, enabled: true, attachments, createdBy: i.user.id,
              createdUtc: now, updatedUtc: now, lastRunUtc: null, lastStatus: null,
              nextRunUtc: next ? next.toISOString() : null, pinnedSessionId: null,
            };
            this.store.upsertScheduled(row);
            this.scheduledManager?.armFromRow(row);
          }
          collector.stop(existing ? "saved" : "created");
          const confirm = new EmbedBuilder()
            .setTitle(existing ? "✏️ Scheduled prompt updated" : "⏰ Scheduled prompt created")
            .setColor(0x2ecc71)
            .setDescription(
              `**${state.name}** \`${row.id}\`\nRuns ${describeCron(state.cron)} (${state.timezone})` +
              (state.model ? `\nModel: \`${state.model}\`` : "") +
              (state.cwd ? `\nWorking dir: \`${state.cwd}\`` : "") +
              (state.target ? `\nOutput to: <#${state.target}>` : "") +
              `\nOutput as: ${state.outputType === "messages" ? "plain messages" : "status cards"}` +
              (next ? `\nNext run: <t:${Math.floor(next.getTime() / 1000)}:F>` : "") +
              (row.attachments.length ? `\n📎 ${row.attachments.length} file(s) attached` : "") +
              (existing && !row.enabled ? `\n\n⏸️ This schedule is currently disabled — enable it with \`/${this.cmd} schedule toggle\`.` : "") +
              `\n\nManage it with \`/${this.cmd} schedule list\`.`
            );
          await i.editReply({ embeds: [confirm], components: [] });
        }
      } catch (err) {
        this.logger.error({ err }, "schedule builder interaction failed");
      }
    });
  }

  private async cmdNew(i: ChatInputCommandInteraction): Promise<void> {
    if (!this.adapter.createThread) {
      await i.reply({
        content: "This platform does not support creating threads.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const name = i.options.getString("name") ?? this.cmd;
    if (!i.channelId) {
      await i.reply({ content: "No channel.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const parent: ChannelRef = { platform: PLATFORM, id: i.channelId };
    const thread = await this.adapter.createThread(parent, name);

    // Auto-init: bind a session to the new thread and post the repo
    // picker so the user doesn't have to /seam init themselves.
    try {
      this.router.ensureSessionRecord({
        platform: thread.platform,
        channelRef: thread.id,
        ...(thread.parentId ? { parentRef: thread.parentId } : {}),
        cwd: this.config.REPOS_ROOT,
      });
      await this.sendRepoPicker(thread);
      await i.editReply(`Created thread <#${thread.id}> and initialized it.`);
    } catch (err) {
      this.logger.warn({ err, threadId: thread.id }, "auto-init after /seam new failed");
      await i.editReply(
        `Created thread <#${thread.id}>. Run \`/${this.cmd} init\` there to begin.`
      );
    }
  }

  private async cmdRepo(i: ChatInputCommandInteraction): Promise<void> {
    const requested = i.options.getString("path", true);
    const target = await this.bindRepo(i, requested);
    if (!target) return; // bindRepo already replied with the failure reason
    await i.reply({
      content: `Repo set to \`${this.repoDisplay(target)}\`. Next message starts a fresh session.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  /**
   * Shared repo-binding gate for every provisioning path (typed `set`, picker,
   * clone, new). Enforces: thread-only, OS-realpath boundary inside REPOS_ROOT,
   * and existing directory. On success it binds this thread's session to
   * `target` and starts a FRESH conversation at the new cwd (clears the old ACP
   * session so the agent does not resume the previous repo's context). Returns
   * the bound canonical path, or null after replying with the failure reason.
   */
  /** The configured slash-command name (the "/seam" prefix), e.g. "copilot". */
  private get cmd(): string {
    return this.config.DISCORD_COMMAND_NAME;
  }

  /** Standard "run this inside a thread" reply text (command-name aware). */
  private threadRequiredMsg(): string {
    return `請在 thread 內使用（先用 \`/${this.cmd} new\` 建立一個 thread）。`;
  }

  private async bindRepo(
    i: ChatInputCommandInteraction,
    requestedPath: string
  ): Promise<string | null> {
    const ch = i.channel;
    if (!ch || !ch.isThread()) {
      await i.reply({
        content: this.threadRequiredMsg(),
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }
    try {
      return await this.doBind(this.channelRefFromInteraction(i)!, requestedPath);
    } catch (err) {
      await i.reply({
        content: `❌ ${(err as Error).message}`,
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }
  }

  /**
   * Bind a channel's session to a repo path (resolved + realpath-confined to
   * REPOS_ROOT) and start a fresh conversation. Throws on validation failure;
   * touches no Discord surface (callers own the reply / editReply).
   */
  private async doBind(channel: ChannelRef, requestedPath: string): Promise<string> {
    const target = resolveRepoWithinRoot(this.config.REPOS_ROOT, requestedPath);
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    await this.router.rebindRepo(record.id, target);
    return target;
  }

  /** Shared gate for provisioning subcommands: require a real thread and be
   *  fail-closed unless DISCORD_ALLOWED_CHANNEL_IDS is configured (clone/new have
   *  host-level side effects, so an unset allowlist must NOT mean "any channel"). */
  private async guardProvisioning(
    i: ChatInputCommandInteraction
  ): Promise<ChannelRef | null> {
    const ch = i.channel;
    if (!ch || !ch.isThread()) {
      await i.reply({
        content: this.threadRequiredMsg(),
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }
    if (!this.config.DISCORD_ALLOWED_CHANNEL_IDS) {
      await i.reply({
        content:
          `Provisioning 已停用：請先設定 \`DISCORD_ALLOWED_CHANNEL_IDS\` 才能使用 \`/${this.cmd} repo clone|new\`。`,
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }
    return this.channelRefFromInteraction(i)!;
  }

  private async cmdRepoClone(i: ChatInputCommandInteraction): Promise<void> {
    const channel = await this.guardProvisioning(i);
    if (!channel) return;
    const source = i.options.getString("source", true);
    const name = i.options.getString("name") ?? undefined;
    if (this.provisioningThreads.has(channel.id)) {
      await i.reply({
        content: "此 thread 已有一個 clone / 建立作業進行中，請稍候。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    this.provisioningThreads.add(channel.id);
    try {
      await i.deferReply(); // non-ephemeral, thread-visible ack within 3s
      await i.editReply(`🔄 Cloning \`${source}\` …`);
      const result = await this.provisioner.clone(source, name);
      try {
        const bound = await this.doBind(channel, result.path);
        await i.editReply(
          `✅ Cloned and bound \`${this.repoDisplay(bound)}\`. Your next message starts a fresh session here.`
        );
      } catch (bindErr) {
        await i.editReply(
          `✅ Cloned to \`${this.repoDisplay(result.path)}\`, but binding failed: ${(bindErr as Error).message}\nRun \`/${this.cmd} repo set ${result.name}\`.`
        );
      }
    } catch (err) {
      await i.editReply(`❌ Clone failed: ${(err as Error).message}`).catch(() => {});
    } finally {
      this.provisioningThreads.delete(channel.id);
    }
  }

  private async cmdRepoNew(i: ChatInputCommandInteraction): Promise<void> {
    const channel = await this.guardProvisioning(i);
    if (!channel) return;
    const name = i.options.getString("name", true);
    if (this.provisioningThreads.has(channel.id)) {
      await i.reply({
        content: "此 thread 已有一個 clone / 建立作業進行中，請稍候。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    this.provisioningThreads.add(channel.id);
    try {
      await i.deferReply();
      await i.editReply(`🔄 Creating \`${name}\` …`);
      const result = await this.provisioner.init(name);
      try {
        const bound = await this.doBind(channel, result.path);
        await i.editReply(
          `✅ Created and bound \`${this.repoDisplay(bound)}\` (empty git repo). Your next message starts a fresh session here.`
        );
      } catch (bindErr) {
        await i.editReply(
          `✅ Created \`${result.name}\`, but binding failed: ${(bindErr as Error).message}\nRun \`/${this.cmd} repo set ${result.name}\`.`
        );
      }
    } catch (err) {
      await i.editReply(`❌ Create failed: ${(err as Error).message}`).catch(() => {});
    } finally {
      this.provisioningThreads.delete(channel.id);
    }
  }

  /** Called on shutdown: kill any in-flight clone/init child process trees. */
  shutdownProvisioning(): void {
    this.provisioner.shutdown();
  }

  private async cmdModel(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const id = i.options.getString("id");
    if (!id) {
      // No id given — show an interactive picker. Eagerly start the
      // runtime if needed so we have an availableModels list (the model
      // catalog comes from the agent at session-start, not from us).
      const cfg = this.store.readConfig(record);
      const current = cfg.model ?? this.config.DEFAULT_MODEL;
      const displayCurrent = `\`${current}\``;
      if (!this.adapter.sendChoicePicker) {
        await i.reply({
          content: `Current model: ${displayCurrent}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      let models: ReadonlyArray<{ modelId: string; name?: string }> = [];
      const profile = this.router.getProfile(record.agentId);
      if (profile?.staticModels && profile.staticModels.length > 0) {
        models = profile.staticModels;
      } else {
        try {
          const rt = await this.router.getOrStartRuntime(record);
          models = rt.getSessionInfo()?.availableModels ?? [];
        } catch (err) {
          this.logger.warn({ err }, "could not start runtime / enumerate models");
          await i.editReply(
            `Current model: ${displayCurrent}\nFailed to start the agent to list models: ${(err as Error).message}`
          );
          return;
        }
      }

      if (models.length === 0) {
        await i.editReply(
          `Current model: ${displayCurrent}\n_(agent did not advertise any models — pass an id manually: \`/${this.cmd} model id:<name>\`.)_`
        );
        return;
      }
      await i.editReply(`Current model: ${displayCurrent}. Posting picker…`);
      const picked = await this.adapter.sendChoicePicker(channel, {
        panel: {
          color: 0x5865f2,
          title: "🧠 Choose a model",
          fields: [{ name: "Current", value: displayCurrent, inline: true }],
        },
        choices: models.slice(0, 25).map((m) => ({
          value: m.modelId,
          label: m.name ?? m.modelId,
          description: m.modelId,
        })),
        authorizedUserIds: this.config.DISCORD_ALLOWED_USER_IDS,
        successPanel: (pickedChoice, username) => ({
          color: 0x57f287,
          title: "✅ Model changed",
          fields: [
            { name: "Previous", value: `\`${current}\``, inline: true },
            { name: "New", value: `\`${pickedChoice.value}\``, inline: true },
          ],
          footer: `Changed by ${username}`
        }),
      });
      if (!picked) return;
      await this.applyModelChange(channel, record, picked.value);
      return;
    }
    await this.applyModelChange(channel, record, id, i);
  }

  /**
   * Persist + (best-effort) live-apply a model id. If `interaction` is
   * supplied, reply ephemerally to it; otherwise post the result to the
   * channel (for picker-driven flows).
   */
  private async applyModelChange(
    channel: ChannelRef,
    record: SessionRecord,
    id: string,
    interaction?: ChatInputCommandInteraction
  ): Promise<void> {
    const cfg = this.store.readConfig(record);
    cfg.model = id;
    // The cached usage was measured under the prior model; window/used both
    // belong to a different model now. Invalidate so the next turn starts
    // clean rather than seeding the panel with mismatched numbers.
    cfg.lastContextUsage = undefined;
    this.persistConfig(record, cfg);
    let message: string;
    if (this.router.hasRuntime(record.id)) {
      try {
        const rt = await this.router.getOrStartRuntime(record);
        await rt.setModel(id);
        message = `🧠 Model set to \`${id}\` (live).`;
      } catch (err) {
        this.logger.warn({ err }, "live model set failed; invalidating runtime for respawn");
        // Kill the runtime so next turn spawns with the correct model in env
        // vars (ANTHROPIC_MODEL). Without this, non-Anthropic backends (Ollama
        // Cloud, Z.ai) keep running the old model since setModel() is rejected.
        await this.router.invalidate(record.id);
        message = `🧠 Model will be \`${id}\` on the next turn (session respawn).`;
      }
    } else {
      message = `🧠 Model will be \`${id}\` on the next turn.`;
    }
    if (interaction) {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    } else {
      await this.adapter.sendMessage(channel, message);
    }
  }

  private async renderPlanUpdate(
    channel: ChannelRef,
    sessionId: string,
    entries: Array<{ content: string; priority?: string; status?: string }>
  ): Promise<void> {
    if (entries.length === 0) return;
    const icon = (s?: string): string =>
      s === "completed" ? "✅" : s === "in_progress" ? "🔄" : "⬜";
    const body = entries
      .map((e, i) => `${icon(e.status)} ${i + 1}. ${e.content}`)
      .join("\n");
    const text = `📋 **計畫**\n${body}`;
    if (this.lastPlanRender.get(sessionId) === text) return; // dedupe repeats
    this.lastPlanRender.set(sessionId, text);
    try {
      await this.adapter.sendMessage(channel, text.slice(0, 1900));
    } catch (err) {
      this.logger.warn({ err, session: sessionId }, "failed to render plan update");
    }
  }

  /**
   * Post the FULL plan the writing-plans skill wrote to Copilot's session-state
   * `plan.md`. Two delivery modes:
   *  - "file" (Approach 2 / auto): attach plan.md as a Discord file card, which
   *    has a real expand/collapse.
   *  - "text" (Approach 1 / on-demand button): print the full plan inline as
   *    chunked plain messages (markdown rendered), no file card.
   * Copilot only summarizes the plan in chat, so this surfaces the full detail.
   */
  private async postPlanDetail(
    channel: ChannelRef,
    record: SessionRecord,
    mode: "file" | "text" = "file"
  ): Promise<void> {
    let content = "";
    if (record.acpSessionId) {
      const profile = this.router.getProfile(record.agentId);
      const home =
        profile?.configDir ||
        process.env.COPILOT_HOME ||
        path.join(os.homedir(), ".copilot");
      const planPath = path.join(home, "session-state", record.acpSessionId, "plan.md");
      try {
        content = (await fsp.readFile(planPath, "utf8")).trim();
      } catch {
        content = "";
      }
    }
    if (!content) {
      await this.adapter.sendMessage(
        channel,
        "（找不到完整計畫檔 plan.md — 這個 session 可能還沒產生詳細計畫。）"
      );
      return;
    }
    if (mode === "file" && this.adapter.sendFile) {
      await this.adapter.sendFile(channel, {
        data: Buffer.from(content, "utf8"),
        filename: "plan.md",
        mimeType: "text/markdown",
      });
      return;
    }
    // Text mode (or no sendFile): print the full plan inline as normal messages
    // (Discord renders the markdown). Unwrap any outer ```markdown wrapper so
    // nested ```powershell blocks render correctly, then split fence-aware so
    // code blocks stay valid across message boundaries.
    const header = "📋 完整執行計畫（plan.md）：";
    const rendered = unwrapMarkdownCodeFences(content);
    for (const chunk of chunkMarkdownForDiscord(`${header}\n${rendered}`, 1900)) {
      await this.adapter.sendMessage(channel, chunk);
    }
  }

  /**
   * After a Plan-mode turn ends, offer the operator a picker to proceed:
   * show the full plan, switch to Autopilot / Agent (and kick off execution),
   * or keep planning. Copilot's native "approve plan & switch mode" prompt is
   * not emitted over ACP, so this recreates it on Discord. Loops so "show full
   * plan" can be chosen without ending the flow.
   */
  private async offerPlanProceed(
    channel: ChannelRef,
    record: SessionRecord
  ): Promise<void> {
    const sendPicker = this.adapter.sendChoicePicker?.bind(this.adapter);
    if (!sendPicker) return;
    for (let i = 0; i < 20; i++) {
      const picked = await sendPicker(channel, {
        prompt: "📋 計畫已完成。接下來要怎麼進行？",
        choices: [
          { value: "showplan", label: "📖 顯示完整執行計畫" },
          { value: "autopilot", label: "🚀 切 Autopilot 執行" },
          { value: "agent", label: "🤖 用 Agent 逐步執行" },
          { value: "keep", label: "✋ 保持 Plan（我要補充）" },
        ],
        authorizedUserIds: this.config.DISCORD_ALLOWED_USER_IDS,
        timeoutMs: 0, // never time out — the picker stays clickable indefinitely
      });
      if (!picked || picked.value === "keep") return;
      if (picked.value === "showplan") {
        await this.postPlanDetail(channel, record, "text").catch((err) =>
          this.logger.warn({ err, session: record.id }, "show full plan failed")
        );
        continue; // re-offer the picker so they can still choose how to proceed
      }
      const targetMode = picked.value; // "autopilot" | "agent"
      const cfg = this.store.readConfig(record);
      cfg.mode = targetMode;
      this.persistConfig(record, cfg);
      try {
        const rt = await this.router.getOrStartRuntime(record);
        await rt.applyMode(targetMode);
      } catch (err) {
        this.logger.warn({ err, session: record.id }, "plan-proceed: applyMode failed");
      }
      const proceedText =
        targetMode === "autopilot"
          ? "請依剛才規劃好的計畫開始執行，直到完成。"
          : "請開始逐步執行剛才規劃好的計畫。";
      void this.handleIncomingMessage({
        channel,
        authorId: picked.userId,
        authorIsBot: false,
        text: proceedText,
      });
      return;
    }
  }

  /** Map an ACP mode id or stored mode string to a short display label. */
  private friendlyModeLabel(mode?: string): string | undefined {
    if (!mode) return undefined;
    const m = mode.toLowerCase();
    if (m.includes("autopilot")) return "Autopilot";
    if (m.includes("plan")) return "Plan";
    if (m.includes("agent")) return "Agent";
    const seg = (mode.split("#").pop() ?? mode).trim();
    return seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : undefined;
  }

  private async cmdMode(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const id = i.options.getString("id", true);
    const cfg = this.store.readConfig(record);
    let message: string;
    if (this.router.hasRuntime(record.id)) {
      try {
        const rt = await this.router.getOrStartRuntime(record);
        const applied = await rt.applyMode(id);
        if (applied) {
          // Persist the resolved, advertised mode id (not the raw input).
          cfg.mode = applied;
          this.persistConfig(record, cfg);
          message = `Mode set to \`${applied}\`.`;
        } else {
          // Don't persist an input the live agent doesn't advertise.
          message = `⚠️ \`${id}\` isn't a mode this agent advertises — mode unchanged.`;
        }
      } catch (err) {
        this.logger.warn({ err }, "live mode set failed");
        message = `⚠️ Failed to switch mode (\`${id}\`) — mode unchanged.`;
      }
    } else {
      // No live session yet: we can't validate against advertised modes, so
      // store optimistically and attempt to apply on the next turn.
      cfg.mode = id;
      this.persistConfig(record, cfg);
      message = `Mode \`${id}\` will be attempted on the next turn.`;
    }
    await i.reply({ content: message, flags: MessageFlags.Ephemeral });
  }

  private async cmdEffort(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const level = i.options.getString("level");
    const cfg = this.store.readConfig(record);
    const current = cfg.reasoningEffort ?? "default";

    // Gate by the active agent's effort capability. Not every agent exposes a
    // settable reasoning effort: agy bakes it into the model choice; others have
    // none. Showing the picker for those would be a false "✅ changed".
    const profile = this.router.getProfile(record.agentId);
    const eff = profile?.effort;
    const supported = eff?.levels ?? [];
    if (supported.length === 0) {
      const msg =
        eff?.mechanism === "modelBaked"
          ? `Effort for \`${record.agentId}\` is part of the **model** choice — pick a high/med/low model variant with \`/${this.cmd} model\`.`
          : `The active agent (\`${record.agentId}\`) doesn't support a reasoning-effort setting.`;
      await i.reply({ content: msg, flags: MessageFlags.Ephemeral });
      return;
    }
    const effortChoices = EFFORT_CHOICES.filter((c) => supported.includes(c.value));
    const supportedList = supported.map((l) => `\`${l}\``).join(", ");

    // No argument → interactive picker (falling back to a text report when the
    // adapter has no picker support).
    if (!level) {
      const channel = this.channelRefFromInteraction(i);
      if (!channel || !this.adapter.sendChoicePicker) {
        const body =
          cfg.reasoningEffort
            ? `Reasoning effort: \`${cfg.reasoningEffort}\`.`
            : `Reasoning effort is **unset** — the agent uses its own default. Set with \`/${this.cmd} effort level:<${supported.join("|")}>\`.`;
        await i.reply({ content: body, flags: MessageFlags.Ephemeral });
        return;
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await i.editReply(`Current effort: \`${current}\`. Posting picker…`);
      const picked = await this.adapter.sendChoicePicker(channel, {
        panel: {
          color: 0x5865f2,
          title: "🧠 Choose reasoning effort",
          fields: [{ name: "Current", value: `\`${current}\``, inline: true }],
        },
        choices: effortChoices,
        authorizedUserIds: this.config.DISCORD_ALLOWED_USER_IDS,
        successPanel: (pickedChoice, username) => ({
          color: 0x57f287,
          title: "✅ Effort changed",
          fields: [
            { name: "Previous", value: `\`${current}\``, inline: true },
            { name: "New", value: `\`${pickedChoice.value}\``, inline: true },
          ],
          footer: `Changed by ${username} — applies on the next message`,
        }),
      });
      if (!picked) return;
      await this.applyEffortChange(record, picked.value);
      return;
    }

    // Explicit level: validate against what THIS agent supports. The slash
    // command registers the full 5-level list statically, so an agent with a
    // narrower range (e.g. Copilot: low/medium/high) must reject xhigh/max here.
    if (!supported.includes(level)) {
      await i.reply({
        content: `\`${level}\` isn't supported by \`${record.agentId}\` — choose one of: ${supportedList}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await this.applyEffortChange(record, level);
    await i.reply({
      content: `Reasoning effort set to \`${level}\` — applies on your next message.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  /** Persist the effort and invalidate the live runtime so the next turn
   *  recreates/resumes the session with the new effort applied. */
  private async applyEffortChange(
    record: SessionRecord,
    level: string
  ): Promise<void> {
    const cfg = this.store.readConfig(record);
    cfg.reasoningEffort = level;
    this.persistConfig(record, cfg);
    // Effort is applied when the session is (re)built, per the agent's
    // mechanism: Claude via `_meta.claudeCode.options.effort` (set_config_option
    // for "effort" errors there); Copilot via the `reasoning_effort` config
    // option (AgentRuntime.applyConfigOptionEffort). Invalidate so the next turn
    // rebuilds with the new effort; preserve the ACP session id for context.
    if (this.router.hasRuntime(record.id)) {
      await this.router.invalidate(record.id, { clearAcpSession: false });
    }
  }

  /** Graceful: ask the agent to stop the current turn (ACP cancel). Usually the
   *  cleanest — the runtime stays alive and the session continues. A truly hung
   *  turn may ignore it; use /seam abort to force the kill. */
  private async cmdCancel(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const outcome = await this.router.abortTurn(record.id, { force: false });
    await i.editReply(
      outcome === "idle" ? "No active turn." :
      `🟡 Cancel sent. If the turn doesn't stop shortly, use \`/${this.cmd} abort\` to force it.`
    );
  }

  /** Escalating: cancel first, and if the turn is still running after a short
   *  grace period (a hung turn ignoring the cancel), force-kill the agent
   *  process. The acpSessionId is preserved so the next message resumes cleanly. */
  private async cmdAbort(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!this.router.hasRuntime(record.id)) {
      await i.reply({ content: "No active turn.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const outcome = await this.router.abortTurn(record.id, { force: true });
    await i.editReply(
      outcome === "idle" ? "No active turn." :
      outcome === "killed" ? "🔪 Turn was hung — force-killed the agent. Your next message resumes the session." :
      "🛑 Active turn aborted."
    );
  }

  /** Nuclear: force-kill EVERY active agent session the bot is running,
   *  INCLUDING this thread — a slash command isn't an LLM turn, so it runs even
   *  when the current thread's turn is wedged, and that wedged turn is usually
   *  exactly what you're trying to kill. Session ids are preserved, so every
   *  killed session resumes cleanly on its next message. */
  private async cmdKill(i: ChatInputCommandInteraction): Promise<void> {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const killed = await this.router.killAll();
    await i.editReply(
      killed === 0
        ? "No active sessions to kill."
        : `🔪 Force-killed ${killed} active session(s) — including this thread. Each resumes on its next message.`
    );
  }

  // -----------------------------------------------------------------------
  // /seam image — multi-provider image generation picker
  // -----------------------------------------------------------------------

  private imagePickers = new Map<string, ImagePickerState>();

  private async cmdImage(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({ content: `Use \`/${this.cmd} image\` from inside a thread.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const initialPrompt = i.options.getString("prompt") ?? "";

    // If no prompt was provided, open a modal so the user can paste a longer one.
    let prompt = initialPrompt;
    if (!prompt.trim()) {
      const modalId = `img:prompt:${i.id}`;
      const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle("New image prompt")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("prompt")
              .setLabel("Describe the image")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(4000)
          )
        );
      await i.showModal(modal);
      const submitted = await i.awaitModalSubmit({
        filter: (m) => m.customId === modalId && m.user.id === i.user.id,
        time: 300_000,
      }).catch(() => null);
      if (!submitted) return;
      prompt = submitted.fields.getTextInputValue("prompt").trim();
      if (!prompt) {
        await submitted.reply({ content: "Empty prompt — cancelled.", flags: MessageFlags.Ephemeral });
        return;
      }
      await submitted.deferReply();
      const state = this.makePickerState(prompt);
      await submitted.editReply(renderImagePicker(state));
      const msg = await submitted.fetchReply();
      this.imagePickers.set(msg.id, state);
      this.attachImagePickerCollector(msg as Message, state);
      return;
    }

    await i.deferReply();
    const state = this.makePickerState(prompt);
    await i.editReply(renderImagePicker(state));
    const msg = await i.fetchReply();
    this.imagePickers.set(msg.id, state);
    this.attachImagePickerCollector(msg as Message, state);
  }

  private makePickerState(prompt: string): ImagePickerState {
    const defaultModel =
      getImageModelById("nano-banana-2") ?? IMAGE_MODELS[0]!;
    return {
      prompt,
      modelId: defaultModel.id,
      aspectRatio: defaultModel.aspectRatios.includes("16:9") ? "16:9" : defaultModel.aspectRatios[0]!,
      resolution: defaultModel.resolutions.includes("1K") ? "1K" : defaultModel.resolutions[0]!,
      count: 1,
      references: [],
      bflKeyAvailable: this.config.BFL_API_KEY.trim().length > 0,
    };
  }

  private attachImagePickerCollector(msg: Message, state: ImagePickerState): void {
    const collector = msg.createMessageComponentCollector({ time: 30 * 60_000 });
    collector.on("collect", async (bi) => {
      const customId = bi.customId;
      try {
        if (customId === "img:cancel") {
          collector.stop("cancelled");
          await bi.update({ content: "Cancelled.", embeds: [], components: [] });
          return;
        }
        if (customId === "img:edit") {
          const modalId = `img:edit:${bi.id}`;
          const modal = new ModalBuilder()
            .setCustomId(modalId)
            .setTitle("Edit image prompt")
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                  .setCustomId("prompt")
                  .setLabel("Describe the image")
                  .setStyle(TextInputStyle.Paragraph)
                  .setRequired(true)
                  .setMaxLength(4000)
                  .setValue(state.prompt.slice(0, 4000))
              )
            );
          await bi.showModal(modal);
          const submitted = await bi.awaitModalSubmit({
            filter: (m) => m.customId === modalId && m.user.id === bi.user.id,
            time: 300_000,
          }).catch(() => null);
          if (!submitted) return;
          state.prompt = submitted.fields.getTextInputValue("prompt").trim();
          await submitted.deferUpdate();
          await submitted.editReply(renderImagePicker(state));
          return;
        }
        if (customId === "img:model") {
          if (!bi.isStringSelectMenu()) return;
          const picked = bi.values[0]!;
          const model = getImageModelById(picked);
          if (!model) return;
          state.modelId = model.id;
          if (!model.aspectRatios.includes(state.aspectRatio)) {
            state.aspectRatio = model.aspectRatios.includes("16:9") ? "16:9" : model.aspectRatios[0]!;
          }
          if (!model.resolutions.includes(state.resolution)) {
            state.resolution = model.resolutions.includes("1K") ? "1K" : model.resolutions[0]!;
          }
          if (state.references.length > model.maxReferenceImages) {
            state.references = state.references.slice(0, model.maxReferenceImages);
          }
          if (state.count > model.maxCount) state.count = model.maxCount;
          await bi.update(renderImagePicker(state));
          return;
        }
        if (customId.startsWith("img:aspect:")) {
          state.aspectRatio = customId.slice("img:aspect:".length) as AspectRatio;
          await bi.update(renderImagePicker(state));
          return;
        }
        if (customId === "img:aspect-select") {
          if (!bi.isStringSelectMenu()) return;
          state.aspectRatio = bi.values[0]! as AspectRatio;
          await bi.update(renderImagePicker(state));
          return;
        }
        if (customId.startsWith("img:count:")) {
          state.count = parseInt(customId.slice("img:count:".length), 10) || 1;
          await bi.update(renderImagePicker(state));
          return;
        }
        if (customId.startsWith("img:res:")) {
          state.resolution = customId.slice("img:res:".length) as Resolution;
          await bi.update(renderImagePicker(state));
          return;
        }
        if (customId === "img:refs") {
          await this.handleImageRefsButton(bi, state);
          return;
        }
        if (customId === "img:clear-refs") {
          state.references = [];
          await bi.update(renderImagePicker(state));
          return;
        }
        if (customId === "img:generate") {
          await this.handleImageGenerate(bi, state, msg);
          return;
        }
      } catch (err) {
        this.logger.error({ err, customId }, "image picker handler error");
        if (!bi.replied && !bi.deferred) {
          await bi.reply({ content: `Picker error: ${(err as Error).message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      }
    });
    collector.on("end", () => {
      this.imagePickers.delete(msg.id);
    });
  }

  private async handleImageRefsButton(bi: MessageComponentInteraction, state: ImagePickerState): Promise<void> {
    const model = getImageModelById(state.modelId);
    if (!model || model.maxReferenceImages === 0) {
      await bi.reply({ content: "This model doesn't support reference images.", flags: MessageFlags.Ephemeral });
      return;
    }
    const remaining = model.maxReferenceImages - state.references.length;
    if (remaining <= 0) {
      await bi.reply({ content: `Already at the ${model.maxReferenceImages}-ref limit.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await bi.reply({
      content: `Upload up to **${remaining}** reference image${remaining === 1 ? "" : "s"} in this channel within 60 seconds. (Or send any non-image message to cancel.)`,
      flags: MessageFlags.Ephemeral,
    });

    const channel = bi.channel;
    if (!channel || !("createMessageCollector" in channel)) {
      await bi.followUp({ content: "Channel doesn't support uploads.", flags: MessageFlags.Ephemeral });
      return;
    }
    const mCollector = channel.createMessageCollector({
      filter: (m) => m.author.id === bi.user.id,
      time: 60_000,
    });
    mCollector.on("collect", async (m) => {
      const images = m.attachments.filter((a) =>
        (a.contentType ?? "").startsWith("image/")
      );
      if (images.size === 0) {
        mCollector.stop("done");
        return;
      }
      let added = 0;
      for (const a of images.values()) {
        if (state.references.length >= model.maxReferenceImages) break;
        try {
          const res = await fetch(a.url);
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          state.references.push({
            data: buf,
            mimeType: a.contentType ?? "image/png",
            ...(a.name ? { filename: a.name } : {}),
          });
          added++;
        } catch { /* skip */ }
      }
      try {
        const picker = renderImagePicker(state);
        await bi.message.edit(picker);
      } catch { /* ignore */ }
      if (added < images.size) mCollector.stop("done");
    });
    mCollector.on("end", () => {
      try {
        bi.message.edit(renderImagePicker(state)).catch(() => {});
      } catch { /* ignore */ }
    });
  }

  private async handleImageGenerate(
    bi: MessageComponentInteraction,
    state: ImagePickerState,
    msg: Message
  ): Promise<void> {
    const model = getImageModelById(state.modelId);
    if (!model) {
      await bi.reply({ content: "Model not found.", flags: MessageFlags.Ephemeral });
      return;
    }
    const googleApiKey = await resolveGoogleApiKey(
      this.config.GOOGLE_AI_STUDIO_API_KEY,
      this.config.GOOGLE_AI_STUDIO_API_KEY_FILE
    );
    const bflKey = this.config.BFL_API_KEY.trim();
    if (model.provider === "google" && !googleApiKey) {
      await bi.reply({ content: "Google AI Studio API key not configured.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (model.provider === "bfl" && !bflKey) {
      await bi.reply({ content: "BFL API key not configured.", flags: MessageFlags.Ephemeral });
      return;
    }

    await bi.update(renderImagePicker(state, { status: "generating" }));
    const started = Date.now();

    let result;
    try {
      result = await generateImage(
        {
          model,
          prompt: state.prompt,
          aspectRatio: state.aspectRatio,
          resolution: state.resolution,
          count: state.count,
          references: state.references,
        },
        { googleApiKey, bflApiKey: bflKey }
      );
    } catch (err) {
      this.logger.error({ err, model: model.id }, "image generation failed");
      await bi.editReply(
        renderImagePicker(state, {
          status: "error",
          errorMessage: (err as Error).message,
        })
      );
      return;
    }

    // Save each to <cwd>/.seam-images/<ts>.png and post as Discord attachments.
    const parentId = (msg.channel as { parentId?: string | null } | undefined)?.parentId ?? undefined;
    const record = this.router.ensureSessionRecord({
      platform: "discord",
      channelRef: msg.channelId,
      ...(parentId ? { parentRef: parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const cwd = record.repoPath ?? this.config.REPOS_ROOT;
    const saveDir = path.join(cwd, ".seam-images");
    try {
      await fsp.mkdir(saveDir, { recursive: true });
    } catch { /* best effort */ }
    const ts = Date.now();
    const files: AttachmentBuilder[] = [];
    const savedPaths: string[] = [];
    for (let i = 0; i < result.images.length; i++) {
      const img = result.images[i]!;
      const ext = img.mimeType === "image/jpeg" ? "jpg" : "png";
      const filename = `${model.id}-${ts}-${i + 1}.${ext}`;
      const absPath = path.join(saveDir, filename);
      try {
        await fsp.writeFile(absPath, img.data);
        savedPaths.push(absPath);
      } catch (err) {
        this.logger.warn({ err, absPath }, "failed to save generated image");
      }
      files.push(new AttachmentBuilder(img.data, { name: filename }));
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    await bi.editReply(
      renderImagePicker(state, {
        status: "done",
        elapsedSec: elapsed,
        savedPaths,
      })
    );

    // Post the generated images as a follow-up message so they don't replace
    // the picker (the user may want to iterate).
    try {
      await bi.followUp({
        content:
          `**${model.displayName}** · ${state.aspectRatio} · ${result.images.length} image${result.images.length === 1 ? "" : "s"} · ${elapsed}s` +
          (savedPaths.length > 0 ? `\n\`${savedPaths[0]}\`` : ""),
        files,
      });
    } catch (err) {
      this.logger.error({ err }, "failed to post generated images to thread");
    }
  }

  private async cmdReset(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({
        content: "Use inside a thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Stop the live runtime (if any) so any in-flight turn is killed.
    await this.router.invalidate(record.id);
    // Clear the persisted ACP session id so the next message creates a
    // fresh session (which picks up any new MCP servers / config).
    this.store.upsert({
      ...record,
      acpSessionId: "",
      updatedUtc: new Date().toISOString(),
    });
    await i.reply({
      content:
        "Session reset. Your next message will start a fresh ACP session (history is gone, but config is kept).",
      flags: MessageFlags.Ephemeral,
    });
  }

  /**
   * `/seam agent` — show or change the agent bound to this thread.
   *
   * Changing agents mid-thread is destructive: the old agent's
   * conversation history can't be replayed against a different CLI, so
   * we invalidate the live runtime and clear the stored ACP session id
   * (same as `/seam reset`). The new agent's `defaultModel` is applied
   * to the session config so the first turn uses something sensible.
   */
  private async cmdAgent(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({
        content: "Use inside a thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const id = i.options.getString("id");
    const profiles = this.router.listProfiles();

    if (!id) {
      // Show interactive picker.
      if (!this.adapter.sendChoicePicker || profiles.length === 0) {
        const listing = profiles
          .map((p) => `\`${p.id}\` — ${p.displayName}`)
          .join(", ");
        await i.reply({
          content: `Current agent: \`${record.agentId}\`\nAvailable: ${listing}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await i.reply({
        content: `Current agent: \`${record.agentId}\`. Posting picker…`,
        flags: MessageFlags.Ephemeral,
      });
      const picked = await this.adapter.sendChoicePicker(channel, {
        panel: {
          color: 0x5865f2,
          title: "🤖 Choose an agent",
          fields: [{ name: "Current", value: `\`${record.agentId}\``, inline: true }],
        },
        choices: profiles.map((p) => ({
          value: p.id,
          label: p.displayName,
          description: p.id,
        })),
        authorizedUserIds: this.config.DISCORD_ALLOWED_USER_IDS,
        successPanel: (pickedChoice, username) => ({
          color: 0x57f287,
          title: "✅ Agent changed",
          fields: [
            { name: "Previous", value: `\`${record.agentId}\``, inline: true },
            { name: "New", value: `\`${pickedChoice.value}\``, inline: true },
          ],
          footer: `Changed by ${username}`
        }),
      });
      if (!picked) return;
      await this.applyAgentChange(channel, record, picked.value);
      return;
    }

    const profile = this.router.getProfile(id);
    if (!profile) {
      const listing = profiles
        .map((p) => `\`${p.id}\` — ${p.displayName}`)
        .join(", ");
      await i.reply({
        content: `Unknown agent \`${id}\`. Available: ${listing}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (record.agentId === id) {
      await i.reply({
        content: `Agent is already \`${id}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await this.applyAgentChange(channel, record, id, i);
  }

  private async applyAgentChange(
    channel: ChannelRef,
    record: SessionRecord,
    id: string,
    interaction?: ChatInputCommandInteraction
  ): Promise<void> {
    const profile = this.router.getProfile(id);
    if (!profile) {
      const msg = `Unknown agent \`${id}\`.`;
      if (interaction) await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      else await this.adapter.sendMessage(channel, msg);
      return;
    }
    if (record.agentId === id) {
      const msg = `Agent is already \`${id}\`.`;
      if (interaction) await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      else await this.adapter.sendMessage(channel, msg);
      return;
    }
    // Kill the live runtime (ends any in-flight turn) and wipe the ACP
    // session id so the next message spawns the new agent fresh.
    await this.router.invalidate(record.id);
    const cfg = this.store.readConfig(record);
    cfg.model = profile.defaultModel;
    // Different agent → different context-window characteristics; cached
    // usage no longer applies.
    cfg.lastContextUsage = undefined;
    this.persistConfig(record, cfg);
    this.store.upsert({
      ...record,
      agentId: id,
      acpSessionId: "",
      updatedUtc: new Date().toISOString(),
    });
    await this.updateThreadAbbreviation(channel, record.agentId, id);
    const message = `🤖 Agent switched to \`${id}\` (${profile.displayName}), model \`${profile.defaultModel}\`. Next message will start a fresh session.`;
    if (interaction) {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    } else {
      await this.adapter.sendMessage(channel, message);
    }
  }

  private async cmdConfig(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const cfg =
      this.store.readConfig(record) ?? defaultSessionConfig(this.config.DEFAULT_MODEL);
    await i.reply({
      content: this.renderer.codeBlock(JSON.stringify(cfg, null, 2), "json"),
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdSessions(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }

    const profile = this.router.getProfile(record.agentId);
    if (!profile) {
      await i.reply({ content: `Agent profile "${record.agentId}" not found.`, flags: MessageFlags.Ephemeral });
      return;
    }

    const manager = profile.sessionManager;
    if (!manager) {
      await i.reply({
        content: `Agent profile \`${record.agentId}\` (${profile.displayName}) does not support session management.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await i.deferReply({ flags: MessageFlags.Ephemeral });

    const cwd = record.repoPath ?? this.config.REPOS_ROOT;
    let sessions: SessionSummary[];
    try {
      sessions = await manager.listSessions(cwd);
    } catch (err: any) {
      await i.editReply({
        content: `Failed to list sessions: ${err.message}`,
      });
      return;
    }

    if (sessions.length === 0) {
      // Empty state logic handled inside makeSessionMessageOptions instead of returning early
    }

    // Open on this thread's active session (if it has one and it's in the list),
    // so the first thing shown — and the default compaction target — is the
    // session the user almost always means. Falls back to most-recent.
    let currentIndex = 0;
    if (record.acpSessionId) {
      const activeIdx = sessions.findIndex((s) => s.sessionId === record.acpSessionId);
      if (activeIdx !== -1) currentIndex = activeIdx;
    }

    const formatLine = (line: SessionSummaryLine) => {
      const prefix = line.sender === "human" ? "👤" : "🤖";
      const cleaned = cleanTextForPreview(line.text);
      if (!cleaned) return null;
      const truncatedText = cleaned.length > 80 ? cleaned.substring(0, 77) + "..." : cleaned;
      return `${prefix} ${truncatedText}`;
    };

    const makeSessionMessageOptions = (idx: number, list: SessionSummary[], activeId: string, mgr: ISessionManager) => {
      const isOrphaned = !list.some((s) => s.sessionId === activeId);

      if (list.length === 0) {
        const embed = new EmbedBuilder()
          .setTitle(`Browse & Manage Sessions — ${profile.displayName}`)
          .setDescription(
            `⚠️ **Warning:** The current Discord thread is completely disconnected from any known backend session.\n\n` +
            `*There are no sessions in the database for this workspace.*`
          )
          .setColor(0xe74c3c);

        const rebuildBtn = new ButtonBuilder()
          .setCustomId("sessions:rebuild")
          .setLabel("🏗️ Rebuild from Thread")
          .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(rebuildBtn);

        return {
          content: "",
          embeds: [embed],
          components: [row],
        };
      }

      const session = list[idx];
      if (!session) return { content: "No sessions found.", embeds: [], components: [] };

      const formatted = session.previewLines.map(formatLine).filter(Boolean) as string[];
      const previewText = formatted.length > 0
        ? formatted.join("\n")
        : "*No meaningful messages in this session.*";

      const embed = new EmbedBuilder()
        .setTitle(`Browse & Manage Sessions — ${profile.displayName}`)
        .setDescription(
          (isOrphaned ? `⚠️ **Warning:** The current Discord thread is completely disconnected from any known backend session.\n\n` : "") +
          `**Session ID:** \`${session.sessionId}\`\n` +
          `**Created:** ${session.createdAt ? `<t:${Math.floor(session.createdAt / 1000)}:f>` : "Unknown"}\n` +
          `**Last Activity:** ${session.lastActivityAt ? `<t:${Math.floor(session.lastActivityAt / 1000)}:R>` : "Unknown"}\n` +
          `**Status:** ${activeId === session.sessionId ? "🟢 **Active Session in this channel**" : "⚪ Inactive"}\n\n` +
          `**Preview (Heuristic):**\n` +
          previewText
        )
        .setColor(activeId === session.sessionId ? 0x2ecc71 : (isOrphaned ? 0xe74c3c : 0x3498db));

      let footerText = `Session ${idx + 1} of ${list.length}`;
      if (session.estimatedTokens !== undefined) {
        footerText += session.tokensFromUsage
          ? ` • Context: ${session.estimatedTokens.toLocaleString()} tokens`
          : ` • Context: ~${session.estimatedTokens.toLocaleString()} tokens (estimate, refines after next turn)`;
      }
      embed.setFooter({ text: footerText });

      const prevBtn = new ButtonBuilder()
        .setCustomId("sessions:prev")
        .setLabel("◀ Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(idx === 0);

      const nextBtn = new ButtonBuilder()
        .setCustomId("sessions:next")
        .setLabel("Next ▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(idx === list.length - 1);

      const closeBtn = new ButtonBuilder()
        .setCustomId("sessions:close")
        .setLabel("Close")
        .setStyle(ButtonStyle.Danger);

      const attachBtn = new ButtonBuilder()
        .setCustomId("sessions:attach")
        .setLabel("Attach")
        .setStyle(ButtonStyle.Success)
        .setDisabled(activeId === session.sessionId);

      const cloneBtn = new ButtonBuilder()
        .setCustomId("sessions:clone")
        .setLabel("Clone")
        .setStyle(ButtonStyle.Primary);

      const cloneAttachBtn = new ButtonBuilder()
        .setCustomId("sessions:clone_attach")
        .setLabel("Clone & Attach")
        .setStyle(ButtonStyle.Success);

      const deleteBtn = new ButtonBuilder()
        .setCustomId("sessions:delete")
        .setLabel("Delete")
        .setStyle(ButtonStyle.Danger);

      const summaryBtn = new ButtonBuilder()
        .setCustomId("sessions:summary")
        .setLabel("🪄 AI Summary")
        .setStyle(ButtonStyle.Primary);

      // "Can compact" now means: there's a configured summarizer model for this
      // agent. (The write-back is a seedNewSession turn, which any agent with a
      // runtime supports — no special manager method required.)
      const canCompact = this.compactionModelFor(record.agentId) !== "";
      // Any agent with a session manager can receive a migrated session (the
      // summary is seeded into a fresh session under that agent).
      const targetProfiles = this.router.listProfiles().filter(p =>
        p.id !== record.agentId && !!p.sessionManager
      );

      const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(prevBtn, nextBtn, closeBtn);
      const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(attachBtn, cloneBtn, cloneAttachBtn, deleteBtn);

      const row3Buttons = [summaryBtn];

      if (canCompact) {
        row3Buttons.push(
          new ButtonBuilder()
            .setCustomId("sessions:compact")
            .setLabel("🗳️ Compact")
            .setStyle(ButtonStyle.Success)
        );
      }

      if (typeof mgr.repairSession === "function") {
        row3Buttons.push(
          new ButtonBuilder()
            .setCustomId("sessions:repair")
            .setLabel("Repair")
            .setStyle(ButtonStyle.Danger)
        );
      }

      if (targetProfiles.length > 0) {
        row3Buttons.push(
          new ButtonBuilder()
            .setCustomId("sessions:migrate")
            .setLabel("Migrate Agent")
            .setStyle(ButtonStyle.Primary)
        );
      }

      const rebuildBtn = new ButtonBuilder()
        .setCustomId("sessions:rebuild")
        .setLabel("🏗️ Rebuild from Thread")
        .setStyle(ButtonStyle.Primary);

      row3Buttons.push(rebuildBtn);

      const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(row3Buttons);

      const row4Buttons: ButtonBuilder[] = [];
      if (canCompact) {
        row4Buttons.push(
          new ButtonBuilder()
            .setCustomId("sessions:import_to_cwd")
            .setLabel("📤 Import to Cwd")
            .setStyle(ButtonStyle.Primary)
        );
      }
      // Premium (session JSONL based) — needs a raw-history reader (Claude/agy).
      if (canCompact && typeof mgr.getHistoryPath === "function") {
        row4Buttons.push(
          new ButtonBuilder()
            .setCustomId("sessions:premium")
            .setLabel("✨ Premium Compact (Session)")
            .setStyle(ButtonStyle.Success)
        );
      }
      // Premium (Discord thread based) — works for any compactable agent.
      if (canCompact) {
        row4Buttons.push(
          new ButtonBuilder()
            .setCustomId("sessions:premium_discord")
            .setLabel("✨ Premium Compact (Discord)")
            .setStyle(ButtonStyle.Success)
        );
      }
      const components: ActionRowBuilder<ButtonBuilder>[] = [row1, row2, row3];
      if (row4Buttons.length > 0) {
        components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(row4Buttons));
      }

      return {
        content: "",
        embeds: [embed],
        components,
      };
    };

    // Render first session in the list
    const msg = await i.editReply(makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager));

    const collector = msg.createMessageComponentCollector({
      filter: (btnInteraction) => btnInteraction.user.id === i.user.id,
      time: 600_000, // 10 minutes
    });

    collector.on("collect", async (btnInteraction) => {
      const customId = btnInteraction.customId;

      if (customId === "sessions:prev") {
        await btnInteraction.deferUpdate();
        if (currentIndex > 0) {
          currentIndex--;
          await btnInteraction.editReply(makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager));
        }
      } else if (customId === "sessions:next") {
        await btnInteraction.deferUpdate();
        if (currentIndex < sessions.length - 1) {
          currentIndex++;
          await btnInteraction.editReply(makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager));
        }
      } else if (customId === "sessions:close") {
        await btnInteraction.deferUpdate();
        await btnInteraction.deleteReply().catch(() => {});
        await i.deleteReply().catch(() => {});
        collector.stop("user_closed");
      } else if (customId === "sessions:attach") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          await this.router.invalidate(record.id);
          this.store.upsert({
            ...record,
            acpSessionId: session.sessionId,
            updatedUtc: new Date().toISOString(),
          });
          const fresh = this.store.get(record.id);
          if (fresh) {
            record.acpSessionId = fresh.acpSessionId;
          }
          await btnInteraction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle("Session Attached")
                .setDescription(`🟢 Session \`${session.sessionId}\` has been attached to this channel. Next message will run in this session.`)
                .setColor(0x2ecc71)
            ],
            components: [],
          });
          collector.stop();
        }
      } else if (customId === "sessions:clone") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          const newSessionId = randomUUID();
          try {
            await manager.cloneSession(cwd, session.sessionId, newSessionId);
            sessions = await manager.listSessions(cwd);
            const newIndex = sessions.findIndex(s => s.sessionId === newSessionId);
            if (newIndex !== -1) {
              currentIndex = newIndex;
            }
            const opts = makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager);
            const embed = opts.embeds?.[0];
            if (embed) {
              embed.setDescription(
                `✨ **Cloned successfully as** \`${newSessionId}\`!\n\n` +
                (embed.data.description ?? "")
              );
            }
            await btnInteraction.editReply(opts);
          } catch (err: any) {
            await btnInteraction.followUp({
              content: `❌ Failed to clone session: ${err.message}`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }
      } else if (customId === "sessions:clone_attach") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          const newSessionId = randomUUID();
          try {
            await manager.cloneSession(cwd, session.sessionId, newSessionId);
            sessions = await manager.listSessions(cwd);

            await this.router.invalidate(record.id);
            this.store.upsert({
              ...record,
              acpSessionId: newSessionId,
              updatedUtc: new Date().toISOString(),
            });
            const fresh = this.store.get(record.id);
            if (fresh) {
              record.acpSessionId = fresh.acpSessionId;
            }

            await btnInteraction.editReply({
              embeds: [
                new EmbedBuilder()
                  .setTitle("Session Cloned & Attached")
                  .setDescription(
                    `✨ **Cloned successfully as** \`${newSessionId}\`!\n\n` +
                    `🟢 **This new session has been attached to this channel.** Next message will run in this session.`
                  )
                  .setColor(0x2ecc71)
              ],
              components: [],
            });
            collector.stop();
          } catch (err: any) {
            await btnInteraction.followUp({
              content: `❌ Failed to clone and attach session: ${err.message}`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }
      } else if (customId === "sessions:delete") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          const confirmEmbed = new EmbedBuilder()
            .setTitle("⚠️ Delete Session?")
            .setDescription(`Are you sure you want to permanently delete session \`${session.sessionId}\`? This action cannot be undone.`)
            .setColor(0xe74c3c);

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("sessions:delete_confirm")
              .setLabel("Yes, Delete")
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId("sessions:delete_cancel")
              .setLabel("No, Cancel")
              .setStyle(ButtonStyle.Secondary)
          );

          await btnInteraction.editReply({
            embeds: [confirmEmbed],
            components: [row],
          });
        }
      } else if (customId === "sessions:delete_cancel") {
        await btnInteraction.deferUpdate();
        await btnInteraction.editReply(makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager));
      } else if (customId === "sessions:delete_confirm") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          try {
            await manager.deleteSession(cwd, session.sessionId);
            if (record.acpSessionId === session.sessionId) {
              await this.router.invalidate(record.id, { clearAcpSession: true });
              const fresh = this.store.get(record.id);
              if (fresh) {
                record.acpSessionId = fresh.acpSessionId;
              } else {
                record.acpSessionId = "";
              }
            }
            sessions = await manager.listSessions(cwd);
            if (sessions.length === 0) {
              await btnInteraction.editReply({
                embeds: [
                  new EmbedBuilder()
                    .setTitle("No Sessions")
                    .setDescription("All sessions have been deleted.")
                    .setColor(0x7f8c8d)
                ],
                components: [
                  new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                      .setCustomId("sessions:close")
                      .setLabel("Close")
                      .setStyle(ButtonStyle.Secondary)
                  )
                ],
              });
            } else {
              currentIndex = 0;
              await btnInteraction.editReply(makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager));
            }
          } catch (err: any) {
            await btnInteraction.followUp({
              content: `❌ Failed to delete session: ${err.message}`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }
      } else if (customId === "sessions:repair") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          const confirmEmbed = new EmbedBuilder()
            .setTitle("⚠️ Repair Session?")
            .setDescription(`This will attempt to repair session \`${session.sessionId}\` by rolling back to the last clean user state. Proceed?`)
            .setColor(0xe74c3c);

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("sessions:repair_confirm")
              .setLabel("Yes, Repair")
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId("sessions:repair_cancel")
              .setLabel("No, Cancel")
              .setStyle(ButtonStyle.Secondary)
          );

          await btnInteraction.editReply({
            embeds: [confirmEmbed],
            components: [row],
          });
        }
      } else if (customId === "sessions:repair_cancel") {
        await btnInteraction.deferUpdate();
        await btnInteraction.editReply(makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager));
      } else if (customId === "sessions:repair_confirm") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session && typeof manager.repairSession === "function") {
          try {
            await manager.repairSession(cwd, session.sessionId);
            if (record.acpSessionId === session.sessionId) {
              await this.router.invalidate(record.id);
            }
            sessions = await manager.listSessions(cwd);
            const opts = makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager);
            const embed = opts.embeds?.[0];
            if (embed) {
              embed.setDescription(
                `✨ **Session repaired successfully!**\n\n` +
                (embed.data.description ?? "")
              );
            }
            await btnInteraction.editReply(opts);
          } catch (err: any) {
            await btnInteraction.followUp({
              content: `❌ Failed to repair session: ${err.message}`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }
      } else if (customId === "sessions:rebuild") {
        await btnInteraction.deferUpdate();
        await btnInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle("🏗️ Rebuilding Session...")
              .setDescription(`Fetching historical messages from this Discord thread to reconstruct a premium summary...`)
              .setColor(0xe67e22)
          ],
          components: [],
        });

        void (async () => {
          let tempRuntime: AgentRuntime | undefined;
          try {
            const channelRef = { platform: "discord", id: i.channelId };
            if (typeof this.adapter.fetchThreadMessages !== "function") {
              throw new Error("Chat adapter does not support fetching thread messages.");
            }

            const rawMessages = await this.adapter.fetchThreadMessages(channelRef);
            if (rawMessages.length === 0) {
              throw new Error("No messages found in this Discord thread to reconstruct.");
            }

            const transcript = rawMessages.map(m => `${m.authorIsBot ? "Agent" : "Human"}: ${m.text}`).join("\n");

            let sanitizedTranscript = transcript
              .split("\n")
              .map((line) => {
                if (line.length > 2000) {
                  return line.substring(0, 2000) + " ... [Line truncated]";
                }
                return line;
              })
              .join("\n");

            const compactionModel = this.compactionModelFor(record.agentId);
            if (!compactionModel) {
              throw new Error(`Rebuild is not supported for agent profile \`${record.agentId}\``);
            }
            const promptTemplate = await fsp.readFile("/home/ubuntu/Projects/compact.md", "utf8");
            // Add a rebuild-specific addendum: the compact.md template was designed
            // for mid-session compaction. For full thread reconstruction we need the
            // model to cover the entire conversation — especially the end.
            const rebuildAddendum =
              "\n\nIMPORTANT: This is a full thread reconstruction from Discord history. " +
              "The transcript below contains the ENTIRE conversation. You MUST cover " +
              "the full conversation from start to finish in your summary. Give " +
              "special emphasis to the most RECENT work (the last ~30% of the " +
              "transcript) — that is the current state the user needs to resume from. " +
              "Do NOT spend excessive detail on early/introductory messages at the " +
              "expense of recent ones. If the analysis section is getting very long, " +
              "abbreviate the early parts and expand on the latest work.\n";
            const fullTemplate = promptTemplate + rebuildAddendum;
            const templateOverhead = fullTemplate.length + "\n\nConversation Transcript:\n".length;
            sanitizedTranscript = fitTranscriptToWindow(
              sanitizedTranscript,
              templateOverhead,
              compactionWindowFor(compactionModel)
            );
            this.logger.info(
              { channelId: i.channelId, msgCount: rawMessages.length,
                transcriptChars: sanitizedTranscript.length, model: compactionModel },
              "rebuild: transcript assembled",
            );

            // Write transcript to a temp file rather than inlining it in the
            // prompt. The AGY CLI (Gemini) truncates stdin prompts larger than
            // ~150KB, but the model can read arbitrarily large files via its
            // file-reading tools without any truncation.
            const transcriptFile = path.join(
              cwd, `.rebuild-transcript-${i.channelId}-${Date.now()}.txt`,
            );
            await fsp.writeFile(transcriptFile, sanitizedTranscript, "utf8");

            const compactionPrompt =
              `${fullTemplate}\n\n` +
              `The conversation transcript has been saved to the file: ${transcriptFile}\n` +
              `Read that file NOW and then produce your summary. ` +
              `The file contains ${rawMessages.length} messages (${sanitizedTranscript.length} chars). ` +
              `You MUST read the ENTIRE file before summarizing — do not stop partway through.`;

            tempRuntime = new AgentRuntime({
              profile,
              logger: this.logger.child({ session: `temp-rebuild-${i.channelId}` }),
              mcpServers: [],
            });

            await tempRuntime.start();

            await tempRuntime.newSession({
              cwd,
              model: compactionModel,
              meta: { reasoningEffort: "low" },
            });

            let summaryText = "";
            tempRuntime.onEvent((event) => {
              if (event.kind === "agent-text") {
                summaryText += event.text;
              }
            });

            try {
              const outcome = await tempRuntime.prompt(compactionPrompt);
            } finally {
              // Clean up the temp transcript file
              await fsp.unlink(transcriptFile).catch(() => {});
            }

            if (!summaryText.trim()) {
              throw new Error("Agent completed but returned an empty summary.");
            }

            // Seed a NEW resumable session with the rebuilt summary (instead of a
            // synthetic compactSession overwrite, which won't resume).
            const rbCfg = this.store.readConfig(record);
            const newSessionId = await this.seedNewSession({
              profile, cwd,
              ...(rbCfg.model ? { model: rbCfg.model } : {}),
              ...(rbCfg.reasoningEffort ? { effort: rbCfg.reasoningEffort } : {}),
              summary: summaryText,
            });

            // Update active session record
            await this.router.invalidate(record.id);
            this.store.upsert({
              ...record,
              acpSessionId: newSessionId,
              updatedUtc: new Date().toISOString(),
            });

            // Update thread name
            await this.renameThreadForSetup(channelRef, record);

            // Refresh sessions list
            sessions = await manager.listSessions(cwd);
            const newIndex = sessions.findIndex(s => s.sessionId === newSessionId);
            if (newIndex !== -1) {
              currentIndex = newIndex;
            }

            const successEmbed = new EmbedBuilder()
              .setTitle("🏗️ Session Rebuilt Successfully!")
              .setDescription(`Thread has been reconstructed from Discord history.\n\n**New Session ID:** \`${newSessionId}\`\n\n**Summary:**\n${summaryText.substring(0, 1500)}${summaryText.length > 1500 ? "..." : ""}`)
              .setColor(0x2ecc71);

            await btnInteraction.editReply({
              embeds: [successEmbed],
              components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                  new ButtonBuilder()
                    .setCustomId("sessions:close")
                    .setLabel("Close")
                    .setStyle(ButtonStyle.Secondary)
                ),
              ],
            });
          } catch (err: any) {
            this.logger.error({ err, channelId: i.channelId }, "failed to rebuild session");

            const errorEmbed = new EmbedBuilder()
              .setTitle("❌ Rebuild Failed")
              .setDescription(`An error occurred while reconstructing the session:\n\`\`\`\n${err.message}\n\`\`\``)
              .setColor(0xe74c3c);

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId("sessions:summary_back")
                .setLabel("⬅ Back to Manage")
                .setStyle(ButtonStyle.Secondary)
            );

            await btnInteraction.editReply({
              embeds: [errorEmbed],
              components: [row],
            });
          } finally {
            if (tempRuntime) {
              const tempSessionId = tempRuntime.getSessionInfo()?.sessionId;
              await tempRuntime.dispose().catch(() => {});
              if (tempSessionId) {
                await manager.deleteSession(cwd, tempSessionId).catch((err) => {
                  this.logger.warn({ err, sessionId: tempSessionId }, "failed to clean up temporary summary session");
                });
              }
            }
          }
        })();
      } else if (customId === "sessions:summary") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          await btnInteraction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle("🪄 Generating AI Summary...")
                .setDescription(`Analyzing transcript logs for session \`${session.sessionId}\`...`)
                .setColor(0xe67e22)
            ],
            components: [],
          });

          void (async () => {
            let tempRuntime: AgentRuntime | undefined;
            try {
              const transcript = await manager.getTranscript(cwd, session.sessionId);
              if (!transcript.trim()) {
                throw new Error("The session transcript is empty.");
              }

              let sanitizedTranscript = transcript
                .split("\n")
                .map((line) => {
                  if (line.length > 1000) {
                    return line.substring(0, 1000) + " ... [Line truncated]";
                  }
                  return line;
                })
                .join("\n");

              let maxTranscriptLength = 50000;
              if (record.agentId === "agy") {
                maxTranscriptLength = 8000;
              }
              if (sanitizedTranscript.length > maxTranscriptLength) {
                const keepHead = Math.floor(maxTranscriptLength * 0.3);
                const keepTail = Math.floor(maxTranscriptLength * 0.6);
                sanitizedTranscript =
                  sanitizedTranscript.substring(0, keepHead) +
                  "\n\n... [Transcript truncated due to length limits] ...\n\n" +
                  sanitizedTranscript.substring(sanitizedTranscript.length - keepTail);
              }

              let summaryModel = "";
              if (record.agentId === "copilot" || record.agentId.startsWith("copilot-")) {
                summaryModel = "gpt-5-mini";
              } else if (record.agentId === "remote") {
                summaryModel = "gpt-5-mini";
              } else if (record.agentId === "claude" || record.agentId.startsWith("claude-")) {
                summaryModel = "haiku";
              } else if (record.agentId === "agy") {
                summaryModel = "gemini-3-flash";
              } else {
                throw new Error(`AI Summary is not supported for agent profile \`${record.agentId}\``);
              }

              tempRuntime = new AgentRuntime({
                profile,
                logger: this.logger.child({ session: `temp-summary-${session.sessionId}` }),
                mcpServers: [],
              });

              await tempRuntime.start();

              await tempRuntime.newSession({
                cwd,
                model: summaryModel,
                meta: { reasoningEffort: "low" },
              });

              let summaryText = "";
              tempRuntime.onEvent((event) => {
                if (event.kind === "agent-text") {
                  summaryText += event.text;
                }
              });

              const summaryPrompt =
                `Please summarize the following conversation session. Highlight:\n` +
                `1. The primary goal of the session.\n` +
                `2. What key changes, debugging steps, or features were implemented.\n` +
                `3. The current status or remaining tasks.\n\n` +
                `Conversation Transcript:\n` +
                `${sanitizedTranscript}`;

              const outcome = await tempRuntime.prompt(summaryPrompt);

              if (!summaryText.trim()) {
                throw new Error("Agent completed but returned an empty summary.");
              }

              const displaySummary = summaryText.length > 4000 ? summaryText.substring(0, 3997) + "..." : summaryText;

              const summaryEmbed = new EmbedBuilder()
                .setTitle(`🪄 AI Summary — ${profile.displayName}`)
                .setDescription(
                  `**Session ID:** \`${session.sessionId}\`\n\n` +
                  `${displaySummary}`
                )
                .setColor(0x9b59b6);

              const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId("sessions:summary_back")
                  .setLabel("⬅ Back to Manage")
                  .setStyle(ButtonStyle.Secondary)
              );

              await btnInteraction.editReply({
                embeds: [summaryEmbed],
                components: [row],
              });
            } catch (err: any) {
              this.logger.error({ err, sessionId: session.sessionId }, "failed to generate AI summary");

              const errorEmbed = new EmbedBuilder()
                .setTitle("❌ AI Summary Failed")
                .setDescription(`An error occurred while generating the summary:\n\`\`\`\n${err.message}\n\`\`\``)
                .setColor(0xe74c3c);

              const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId("sessions:summary_back")
                  .setLabel("⬅ Back to Manage")
                  .setStyle(ButtonStyle.Secondary)
              );

              await btnInteraction.editReply({
                embeds: [errorEmbed],
                components: [row],
              });
            } finally {
              if (tempRuntime) {
                const tempSessionId = tempRuntime.getSessionInfo()?.sessionId;
                await tempRuntime.dispose().catch(() => {});
                if (tempSessionId) {
                  await manager.deleteSession(cwd, tempSessionId).catch((err) => {
                    this.logger.warn({ err, sessionId: tempSessionId }, "failed to clean up temporary summary session");
                  });
                }
              }
            }
          })();
        }
      } else if (customId === "sessions:compact") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          await btnInteraction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle("🗳️ Compacting Session...")
                .setDescription(`Generating compaction summary for session \`${session.sessionId}\` (summary + verbatim recent window + pinned facts)...`)
                .setColor(0xe67e22)
            ],
            components: [],
          });

          const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("sessions:summary_back").setLabel("⬅ Back to Manage").setStyle(ButtonStyle.Secondary)
          );

          void (async () => {
            try {
              if (!this.compactionModelFor(record.agentId)) {
                throw new Error(`Compaction is not supported for agent profile \`${record.agentId}\` (no summarizer model).`);
              }
              const built = await this.buildDefaultCompactionSeed({
                profile,
                manager,
                agentId: record.agentId,
                cwd,
                sessionId: session.sessionId,
              });
              if (!built) throw new Error("Nothing to compact (empty transcript or no summarizer model).");

              // Non-destructive: seed a NEW session with the summary (resumable),
              // bind the thread to it if this was its active session, and leave
              // the original intact.
              const cfg = this.store.readConfig(record);
              const newId = await this.seedNewSession({
                profile, cwd,
                ...(cfg.model ? { model: cfg.model } : {}),
                ...(cfg.reasoningEffort ? { effort: cfg.reasoningEffort } : {}),
                summary: built.seed,
              });
              const wasActive = session.sessionId === record.acpSessionId;
              if (wasActive) {
                this.store.upsert({ ...record, acpSessionId: newId, updatedUtc: new Date().toISOString() });
                await this.router.invalidate(record.id, { clearAcpSession: false });
              }

              sessions = await manager.listSessions(cwd);
              const newIndex = sessions.findIndex(s => s.sessionId === newId);
              if (newIndex !== -1) currentIndex = newIndex;

              const successEmbed = new EmbedBuilder()
                .setTitle("🗳️ Session Compacted")
                .setDescription(
                  `Compacted into a **new session** \`${newId}\` (summarized ${built.summarizedTurns} older turn(s), kept ${built.keptTurns} verbatim, pinned ${built.pinnedCount} fact(s)).` +
                  (wasActive ? `\nThis thread is now bound to it.` : ``) +
                  `\n\nThe original \`${session.sessionId}\` is **preserved** — find it in this list to review or delete.`
                )
                .setColor(0x2ecc71);
              await btnInteraction.editReply({ embeds: [successEmbed], components: [backRow] });
            } catch (err: any) {
              this.logger.error({ err, sessionId: session.sessionId }, "failed to compact session");
              const errorEmbed = new EmbedBuilder()
                .setTitle("❌ Compaction Failed")
                .setDescription(`An error occurred during compaction:\n\`\`\`\n${(err?.message ?? String(err)).slice(0, 1500)}\n\`\`\``)
                .setColor(0xe74c3c);
              await btnInteraction.editReply({ embeds: [errorEmbed], components: [backRow] });
            }
          })();
        }
      } else if (customId === "sessions:premium") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          const channelRef = this.channelRefFromInteraction(i);
          const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("sessions:summary_back").setLabel("⬅ Back to Manage").setStyle(ButtonStyle.Secondary)
          );
          const progressEmbed = new EmbedBuilder()
            .setTitle("✨ Premium Compaction")
            .setDescription(`Running multi-agent compaction on \`${session.sessionId}\`…\nThis can take several minutes (fan-out → reduce → deep-dive → synthesize → verify).`)
            .setColor(0x9b59b6);
          await btnInteraction.editReply({ embeds: [progressEmbed], components: [] });

          void (async () => {
            // Throttle progress edits so we don't hit Discord's rate limit.
            let lastEdit = 0;
            let editing = false;
            const lines: string[] = [];
            const pushProgress = (m: string) => {
              lines.push(m);
              const now = Date.now();
              if (editing || now - lastEdit < 2500) return;
              editing = true;
              lastEdit = now;
              const tail = lines.slice(-8).map((l) => `• ${l}`).join("\n");
              btnInteraction.editReply({
                embeds: [EmbedBuilder.from(progressEmbed).setDescription(`Compacting \`${session.sessionId}\`…\n\n${tail}`)],
                components: [],
              }).catch(() => {}).finally(() => { editing = false; });
            };

            try {
              const result = await this.runPremiumCompactionForSession({
                profile,
                manager,
                sessionId: session.sessionId,
                cwd,
                ...(channelRef ? { channel: channelRef } : {}),
                onProgress: pushProgress,
              });

              if (!result.assembledSeed.trim()) throw new Error("Pipeline produced an empty result.");

              // Non-destructive: seed a NEW resumable session with the summary,
              // bind the thread if this was its active session, preserve the original.
              const cfg = this.store.readConfig(record);
              const newId = await this.seedNewSession({
                profile, cwd,
                ...(cfg.model ? { model: cfg.model } : {}),
                ...(cfg.reasoningEffort ? { effort: cfg.reasoningEffort } : {}),
                summary: result.assembledSeed,
              });
              const wasActive = session.sessionId === record.acpSessionId;
              if (wasActive) {
                this.store.upsert({ ...record, acpSessionId: newId, updatedUtc: new Date().toISOString() });
                await this.router.invalidate(record.id, { clearAcpSession: false });
              }
              sessions = await manager.listSessions(cwd);
              const newIndex = sessions.findIndex((s) => s.sessionId === newId);
              if (newIndex !== -1) currentIndex = newIndex;

              const reportPath = path.join(os.tmpdir(), `premium-compaction-${session.sessionId}.md`);
              await fsp.writeFile(reportPath, this.formatPremiumReport(result, session.sessionId), "utf8").catch(() => {});

              const successEmbed = new EmbedBuilder()
                .setTitle("✨ Premium Compaction Complete")
                .setDescription(
                  `Compacted into a **new session** \`${newId}\` with the multi-agent pipeline.` +
                  (wasActive ? ` This thread is now bound to it.` : ``) +
                  `\nOriginal \`${session.sessionId}\` is **preserved** (review or delete it from this list).`
                )
                .addFields(
                  { name: "Chunks", value: String(result.stats.chunks), inline: true },
                )
                .setColor(0x2ecc71);

              await btnInteraction.editReply({
                embeds: [successEmbed],
                components: [backRow],
                files: [new AttachmentBuilder(reportPath, { name: `premium-compaction-${session.sessionId}.md` })],
              }).catch(async () => {
                await btnInteraction.editReply({ embeds: [successEmbed], components: [backRow] }).catch(() => {});
              });
            } catch (err: any) {
              this.logger.error({ err, sessionId: session.sessionId }, "premium compaction failed");
              const errorEmbed = new EmbedBuilder()
                .setTitle("❌ Premium Compaction Failed")
                .setDescription(`\`\`\`\n${(err?.message ?? String(err)).slice(0, 1500)}\n\`\`\``)
                .setColor(0xe74c3c);
              await btnInteraction.editReply({ embeds: [errorEmbed], components: [backRow] }).catch(() => {});
            }
          })();
        }
      } else if (customId === "sessions:premium_discord") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          const channelRef = this.channelRefFromInteraction(i);
          const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("sessions:summary_back").setLabel("⬅ Back to Manage").setStyle(ButtonStyle.Secondary)
          );
          const progressEmbed = new EmbedBuilder()
            .setTitle("✨ Premium Compaction (Discord)")
            .setDescription(`Running multi-agent compaction on full Discord history…\nThis can take several minutes (fan-out → reduce → deep-dive → synthesize → verify).`)
            .setColor(0x9b59b6);
          await btnInteraction.editReply({ embeds: [progressEmbed], components: [] });

          void (async () => {
            let lastEdit = 0;
            let editing = false;
            const lines: string[] = [];
            const pushProgress = (m: string) => {
              lines.push(m);
              const now = Date.now();
              if (editing || now - lastEdit < 2500) return;
              editing = true;
              lastEdit = now;
              const tail = lines.slice(-8).map((l) => `• ${l}`).join("\n");
              btnInteraction.editReply({
                embeds: [EmbedBuilder.from(progressEmbed).setDescription(`Compacting from Discord history…\n\n${tail}`)],
                components: [],
              }).catch(() => {}).finally(() => { editing = false; });
            };

            try {
              const result = await this.runPremiumCompactionForDiscord({
                profile,
                manager,
                sessionId: session.sessionId,
                cwd,
                ...(channelRef ? { channel: channelRef } : {}),
                onProgress: pushProgress,
              });

              if (!result.assembledSeed.trim()) throw new Error("Pipeline produced an empty result.");

              // Non-destructive: seed a NEW resumable session with the summary,
              // bind the thread if this was its active session, preserve the original.
              const cfg = this.store.readConfig(record);
              const newId = await this.seedNewSession({
                profile, cwd,
                ...(cfg.model ? { model: cfg.model } : {}),
                ...(cfg.reasoningEffort ? { effort: cfg.reasoningEffort } : {}),
                summary: result.assembledSeed,
              });
              const wasActive = session.sessionId === record.acpSessionId;
              if (wasActive) {
                this.store.upsert({ ...record, acpSessionId: newId, updatedUtc: new Date().toISOString() });
                await this.router.invalidate(record.id, { clearAcpSession: false });
              }
              sessions = await manager.listSessions(cwd);
              const newIndex = sessions.findIndex((s) => s.sessionId === newId);
              if (newIndex !== -1) currentIndex = newIndex;

              const reportPath = path.join(os.tmpdir(), `premium-compaction-discord-${session.sessionId}.md`);
              await fsp.writeFile(reportPath, this.formatPremiumReport(result, session.sessionId), "utf8").catch(() => {});

              const successEmbed = new EmbedBuilder()
                .setTitle("✨ Premium Compaction (Discord) Complete")
                .setDescription(
                  `Compacted from Discord thread history into a **new session** \`${newId}\` with the multi-agent pipeline.` +
                  (wasActive ? ` This thread is now bound to it.` : ``) +
                  `\nOriginal \`${session.sessionId}\` is **preserved** (review or delete it from this list).`
                )
                .addFields(
                  { name: "Chunks", value: String(result.stats.chunks), inline: true },
                )
                .setColor(0x2ecc71);

              await btnInteraction.editReply({
                embeds: [successEmbed],
                components: [backRow],
                files: [new AttachmentBuilder(reportPath, { name: `premium-compaction-discord-${session.sessionId}.md` })],
              }).catch(async () => {
                await btnInteraction.editReply({ embeds: [successEmbed], components: [backRow] }).catch(() => {});
              });
            } catch (err: any) {
              this.logger.error({ err, sessionId: session.sessionId }, "premium compaction (Discord) failed");
              const errorEmbed = new EmbedBuilder()
                .setTitle("❌ Premium Compaction Failed")
                .setDescription(`\`\`\`\n${(err?.message ?? String(err)).slice(0, 1500)}\n\`\`\``)
                .setColor(0xe74c3c);
              await btnInteraction.editReply({ embeds: [errorEmbed], components: [backRow] }).catch(() => {});
            }
          })();
        }
      } else if (customId === "sessions:import_to_cwd") {
        const session = sessions[currentIndex];
        if (!session) return;
        const compactionModel = this.compactionModelFor(record.agentId);
        if (!compactionModel) {
          await btnInteraction.reply({
            content: `❌ Import is not supported for this agent.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId(`sessions:import_cwd_modal:${session.sessionId}`)
          .setTitle("Import Session to New Cwd")
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("target_cwd")
                .setLabel("Target cwd (absolute or under REPOS_ROOT)")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder("/home/ubuntu/Projects/some-repo")
            )
          );

        await btnInteraction.showModal(modal);

        const submission = await btnInteraction.awaitModalSubmit({
          filter: (mi) =>
            mi.customId === `sessions:import_cwd_modal:${session.sessionId}` &&
            mi.user.id === btnInteraction.user.id,
          time: 120_000,
        }).catch(() => null);

        if (!submission) return;

        const rawCwd = submission.fields.getTextInputValue("target_cwd").trim();
        let targetCwd: string;
        try {
          targetCwd = resolveRepoPath(this.config.REPOS_ROOT, rawCwd);
        } catch (err) {
          await submission.reply({
            content: `❌ Invalid cwd: ${(err as Error).message}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await submission.deferUpdate();
        await submission.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle("📤 Importing Session…")
              .setDescription(
                `Summarizing session \`${session.sessionId}\` and creating a new session under \`${this.repoDisplay(targetCwd)}\`…`
              )
              .setColor(0xe67e22),
          ],
          components: [],
        });

        void (async () => {
          let tempRuntime: AgentRuntime | undefined;
          try {
            const transcript = await manager.getTranscript(cwd, session.sessionId);
            if (!transcript.trim()) {
              throw new Error("The session transcript is empty.");
            }

            let sanitizedTranscript = transcript
              .split("\n")
              .map((line) =>
                line.length > 1000
                  ? line.substring(0, 1000) + " ... [Line truncated]"
                  : line
              )
              .join("\n");

            const promptTemplate = await fsp.readFile("/home/ubuntu/Projects/compact.md", "utf8");
            const templateOverhead = promptTemplate.length + "\n\nConversation Transcript:\n".length;
            sanitizedTranscript = fitTranscriptToWindow(
              sanitizedTranscript,
              templateOverhead,
              compactionWindowFor(compactionModel)
            );
            const compactionPrompt = `${promptTemplate}\n\nConversation Transcript:\n${sanitizedTranscript}`;

            tempRuntime = new AgentRuntime({
              profile,
              logger: this.logger.child({ session: `temp-import-${session.sessionId}` }),
              mcpServers: [],
            });

            await tempRuntime.start();
            await tempRuntime.newSession({
              cwd: targetCwd,
              model: compactionModel,
              meta: { reasoningEffort: "low" },
            });

            let summaryText = "";
            tempRuntime.onEvent((event) => {
              if (event.kind === "agent-text") summaryText += event.text;
            });

            await tempRuntime.prompt(compactionPrompt);

            if (!summaryText.trim()) {
              throw new Error("Agent completed but returned an empty summary.");
            }

            // Seed a NEW resumable session (in the target cwd) with the summary.
            const imCfg = this.store.readConfig(record);
            const newSessionId = await this.seedNewSession({
              profile, cwd: targetCwd,
              ...(imCfg.model ? { model: imCfg.model } : {}),
              ...(imCfg.reasoningEffort ? { effort: imCfg.reasoningEffort } : {}),
              summary: summaryText,
            });

            // Re-anchor the current thread to the new cwd + new session.
            await this.router.invalidate(record.id);
            this.store.upsert({
              ...record,
              repoPath: targetCwd,
              acpSessionId: newSessionId,
              updatedUtc: new Date().toISOString(),
            });

            const successEmbed = new EmbedBuilder()
              .setTitle("📤 Session Imported Successfully!")
              .setDescription(
                `Summary of \`${session.sessionId}\` was seeded into a fresh session.\n\n` +
                `**New Cwd:** \`${this.repoDisplay(targetCwd)}\`\n` +
                `**New Session ID:** \`${newSessionId}\``
              )
              .setColor(0x2ecc71);

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId("sessions:summary_back")
                .setLabel("⬅ Back to Manage")
                .setStyle(ButtonStyle.Secondary)
            );

            await submission.editReply({ embeds: [successEmbed], components: [row] });
          } catch (err: any) {
            this.logger.error({ err, sessionId: session.sessionId }, "failed to import session");
            const errorEmbed = new EmbedBuilder()
              .setTitle("❌ Import Failed")
              .setDescription(`An error occurred during import:\n\`\`\`\n${err.message}\n\`\`\``)
              .setColor(0xe74c3c);
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId("sessions:summary_back")
                .setLabel("⬅ Back to Manage")
                .setStyle(ButtonStyle.Secondary)
            );
            await submission.editReply({ embeds: [errorEmbed], components: [row] });
          } finally {
            if (tempRuntime) {
              const tempSessionId = tempRuntime.getSessionInfo()?.sessionId;
              await tempRuntime.dispose().catch(() => {});
              if (tempSessionId) {
                await manager.deleteSession(targetCwd, tempSessionId).catch((cleanupErr) => {
                  this.logger.warn(
                    { err: cleanupErr, sessionId: tempSessionId },
                    "failed to clean up temporary import session"
                  );
                });
              }
            }
          }
        })();
      } else if (customId === "sessions:migrate") {
        await btnInteraction.deferUpdate();
        const session = sessions[currentIndex];
        if (session) {
          const targetProfiles = this.router.listProfiles().filter(p =>
            p.id !== record.agentId &&
            !!p.sessionManager
          );

          const embed = new EmbedBuilder()
            .setTitle(`Migrate Session — ${profile.displayName}`)
            .setDescription(
              `Migrate session \`${session.sessionId}\` to a different agent.\n\n` +
              `This will generate a premium AI compaction summary of the current session and initialize a brand-new session under the selected target agent.`
            )
            .setColor(0xf1c40f);

          const select = new StringSelectMenuBuilder()
            .setCustomId("sessions:migrate_target")
            .setPlaceholder("Select target agent...")
            .addOptions(
              targetProfiles.map(p => ({
                label: p.displayName,
                value: p.id,
                description: `Migrate to ${p.displayName} agent`
              }))
            );

          const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("sessions:migrate_cancel")
              .setLabel("⬅ Cancel")
              .setStyle(ButtonStyle.Secondary)
          );

          await btnInteraction.editReply({
            embeds: [embed],
            components: [
              new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
              cancelRow
            ],
          });
        }
      } else if (customId === "sessions:migrate_cancel") {
        await btnInteraction.deferUpdate();
        await btnInteraction.editReply(makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager));
      } else if (btnInteraction.isStringSelectMenu() && customId === "sessions:migrate_target") {
        await btnInteraction.deferUpdate();
        const targetAgentId = btnInteraction.values[0];
        const session = sessions[currentIndex];
        if (session && targetAgentId) {
          const targetProfile = this.router.getProfile(targetAgentId);
          const targetManager = targetProfile?.sessionManager;
          if (!targetProfile || !targetManager) {
            await btnInteraction.followUp({
              content: `❌ Target agent \`${targetAgentId}\` is not compatible or does not support session management.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          await btnInteraction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle("🗳️ Migrating Session...")
                .setDescription(`Generating premium AI compaction summary and initializing new session under agent \`${targetProfile.displayName}\`...`)
                .setColor(0xe67e22)
            ],
            components: [],
          });

          void (async () => {
            let tempRuntime: AgentRuntime | undefined;
            try {
              const transcript = await manager.getTranscript(cwd, session.sessionId);
              if (!transcript.trim()) {
                throw new Error("The session transcript is empty.");
              }

              let sanitizedTranscript = transcript
                .split("\n")
                .map((line) => {
                  if (line.length > 1000) {
                    return line.substring(0, 1000) + " ... [Line truncated]";
                  }
                  return line;
                })
                .join("\n");

              const compactionModel = this.compactionModelFor(record.agentId);
              if (!compactionModel) {
                throw new Error(`Migration compaction is not supported for source agent profile \`${record.agentId}\``);
              }
              const promptTemplate = await fsp.readFile("/home/ubuntu/Projects/compact.md", "utf8");
              const templateOverhead = promptTemplate.length + "\n\nConversation Transcript:\n".length;
              sanitizedTranscript = fitTranscriptToWindow(
                sanitizedTranscript,
                templateOverhead,
                compactionWindowFor(compactionModel)
              );
              const compactionPrompt = `${promptTemplate}\n\nConversation Transcript:\n${sanitizedTranscript}`;

              tempRuntime = new AgentRuntime({
                profile,
                logger: this.logger.child({ session: `temp-migrate-${session.sessionId}` }),
                mcpServers: [],
              });

              await tempRuntime.start();

              await tempRuntime.newSession({
                cwd,
                model: compactionModel,
                meta: { reasoningEffort: "low" },
              });

              let summaryText = "";
              tempRuntime.onEvent((event) => {
                if (event.kind === "agent-text") {
                  summaryText += event.text;
                }
              });

              const outcome = await tempRuntime.prompt(compactionPrompt);

              if (!summaryText.trim()) {
                throw new Error("Agent completed but returned an empty summary.");
              }

              // Seed a NEW resumable session under the TARGET agent (its own
              // default model/effort) with the summary.
              const newSessionId = await this.seedNewSession({
                profile: targetProfile,
                cwd,
                summary: summaryText,
              });

              // Update active session record
              await this.router.invalidate(record.id);
              this.store.upsert({
                ...record,
                agentId: targetAgentId,
                acpSessionId: newSessionId,
                updatedUtc: new Date().toISOString(),
              });

              const fresh = this.store.get(record.id);
              if (fresh) {
                record.agentId = fresh.agentId;
                record.acpSessionId = fresh.acpSessionId;
              }

              const channel = {
                platform: record.platform,
                id: record.channelRef,
                parentId: record.parentRef || undefined,
              };
              await this.updateThreadAbbreviation(channel, record.agentId, targetAgentId);

              const successEmbed = new EmbedBuilder()
                .setTitle("🎉 Session Migrated Successfully!")
                .setDescription(
                  `Successfully migrated to agent **${targetProfile.displayName}**.\n\n` +
                  `**New Session ID:** \`${newSessionId}\`\n\n` +
                  `🟢 **This new session is now active and attached to this channel.** Any future messages will run in this session.`
                )
                .setColor(0x2ecc71);

              const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId("sessions:close")
                  .setLabel("Close")
                  .setStyle(ButtonStyle.Secondary)
              );

              await btnInteraction.editReply({
                embeds: [successEmbed],
                components: [row],
              });

              collector.stop();
            } catch (err: any) {
              this.logger.error({ err, sessionId: session.sessionId }, "failed to migrate session");

              const errorEmbed = new EmbedBuilder()
                .setTitle("❌ Migration Failed")
                .setDescription(`An error occurred during migration:\n\`\`\`\n${err.message}\n\`\`\``)
                .setColor(0xe74c3c);

              const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId("sessions:summary_back")
                  .setLabel("⬅ Back to Manage")
                  .setStyle(ButtonStyle.Secondary)
              );

              await btnInteraction.editReply({
                embeds: [errorEmbed],
                components: [row],
              });
            } finally {
              if (tempRuntime) {
                const tempSessionId = tempRuntime.getSessionInfo()?.sessionId;
                await tempRuntime.dispose().catch(() => {});
                if (tempSessionId) {
                  await manager.deleteSession(cwd, tempSessionId).catch((err) => {
                    this.logger.warn({ err, sessionId: tempSessionId }, "failed to clean up temporary summary session");
                  });
                }
              }
            }
          })();
        }
      } else if (customId === "sessions:summary_back") {
        await btnInteraction.deferUpdate();
        await btnInteraction.editReply(makeSessionMessageOptions(currentIndex, sessions, record.acpSessionId, manager));
      }
    });

    collector.on("end", async (collected, reason) => {
      if (reason === "user_closed") {
        return;
      }
      try {
        const fresh = this.store.get(record.id);
        const activeId = fresh ? fresh.acpSessionId : record.acpSessionId;
        const currentSession = sessions[currentIndex];
        if (currentSession) {
          const embed = new EmbedBuilder()
            .setTitle(`Browse Sessions — ${profile.displayName} (Closed)`)
            .setDescription(
              `**Session ID:** \`${currentSession.sessionId}\`\n` +
              `**Created:** ${currentSession.createdAt ? `<t:${Math.floor(currentSession.createdAt / 1000)}:f>` : "Unknown"}\n` +
              `**Last Activity:** ${currentSession.lastActivityAt ? `<t:${Math.floor(currentSession.lastActivityAt / 1000)}:R>` : "Unknown"}\n` +
              `**Status:** ${activeId === currentSession.sessionId ? "🟢 **Active Session in this channel**" : "⚪ Inactive"}\n\n` +
              `**Preview (Heuristic):**\n` +
              (currentSession.previewLines.length > 0
                ? currentSession.previewLines.map(formatLine).filter(Boolean).join("\n") || "*No meaningful messages in this session.*"
                : "*No messages in this session yet.*")
            )
            .setColor(activeId === currentSession.sessionId ? 0x2ecc71 : 0x7f8c8d)
            .setFooter({ text: `Session ${currentIndex + 1} of ${sessions.length} (Menu Timed Out)` });

          await i.editReply({
            embeds: [embed],
            components: [],
          });
        }
      } catch {
        // ignore errors on end
      }
    });
  }

  private async cmdTools(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const action = i.options.getString("action", true);
    const list = parseCsv(i.options.getString("list") ?? "");
    const cfg = this.store.readConfig(record);
    if (action === "allow") cfg.availableTools = list;
    else if (action === "exclude") cfg.excludedTools = list;
    this.persistConfig(record, cfg);
    await this.router.invalidate(record.id);
    await i.reply({
      content: `Tool ${action} list: ${list.length === 0 ? "(cleared)" : "`" + list.join(", ") + "`"}. Next turn starts a fresh runtime.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdConfigSet(
    i: ChatInputCommandInteraction
  ): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const json = i.options.getString("json", true);
    let cfg: SessionConfigState;
    try {
      const parsed = JSON.parse(json) as unknown;
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      cfg = parsed as SessionConfigState;
    } catch (err) {
      await i.reply({
        content: `Invalid JSON: ${(err as Error).message}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!cfg.model) cfg.model = this.config.DEFAULT_MODEL;
    this.persistConfig(record, cfg);
    await this.router.invalidate(record.id);
    await i.reply({
      content: "Config replaced; next turn starts a fresh runtime.",
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdRepos(i: ChatInputCommandInteraction): Promise<void> {
    const dirs = this.listRepoDirs();
    if (!dirs) {
      await i.reply({
        content: `REPOS_ROOT not found: \`${this.config.REPOS_ROOT}\``,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (dirs.length === 0) {
      await i.reply({
        content: `No repos under \`${this.config.REPOS_ROOT}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const lines = dirs.slice(0, 50).map((d) => `- ${path.basename(d)}`);
    await i.reply({
      content: `**Repos**\n${this.renderer.codeBlock(lines.join("\n"))}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdInit(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({
        content: `Use \`/${this.cmd} init\` inside a thread.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    await i.reply({
      content: "Session ready. Pick a repo to begin:",
      flags: MessageFlags.Ephemeral,
    });
    await this.sendRepoPicker(channel);
  }

  private async cmdApprove(i: ChatInputCommandInteraction): Promise<void> {
    const record = this.recordFromInteraction(i);
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const policy = i.options.getString("policy", true) as
      | "always"
      | "ask"
      | "deny";
    const cfg = this.store.readConfig(record);
    cfg.permissionPolicy = policy;
    // Drop the deprecated field so it can never override the new value.
    delete cfg.autoApprovePermissions;
    this.persistConfig(record, cfg);
    const messages: Record<typeof policy, string> = {
      always:
        "Approval policy set to `always`. ⚠️ The agent will auto-approve every permission request (shell exec, file writes, network, etc.).",
      ask:
        "Approval policy set to `ask`. The bot will post a Discord prompt for each permission request and auto-deny after 5 minutes.",
      deny:
        "Approval policy set to `deny`. The agent will be auto-denied every permission request — useful for read-only sessions.",
    };
    await i.reply({ content: messages[policy], flags: MessageFlags.Ephemeral });
  }

  /**
   * Read a file from the host machine and post it to the channel as a
   * Discord attachment. The path must resolve under REPOS_ROOT or one
   * of the configured ATTACH_ROOTS — symlinks are followed and the
   * realpath is re-checked.
   */
  /**
   * Resolve a user/agent-supplied path to an existing file under one of
   * the allowed roots (REPOS_ROOT + ATTACH_ROOTS). Returns null on any
   * failure (not found, not a regular file, escapes roots, etc.).
   * Symlinks are followed and the realpath is re-checked.
   */
  private async resolveAllowedHostFile(
    requested: string,
    opts: { preferredRoot?: string | null } = {}
  ): Promise<{ realPath: string; size: number } | null> {
    const cleaned = requested.trim().replace(/^"|"$/g, "");
    if (!cleaned) return null;

    const allowedRoots = [
      this.config.REPOS_ROOT,
      ...this.config.ATTACH_ROOTS,
    ].map((p) => path.resolve(p));

    // For relative paths, try each candidate base in order until one
    // resolves to an existing regular file inside an allowed root:
    //   1. The session's repoPath (the thread's current repo) if any.
    //   2. Each allowed root in order.
    // For absolute paths, resolve directly.
    const candidates: string[] = [];
    if (path.isAbsolute(cleaned)) {
      candidates.push(path.resolve(cleaned));
    } else {
      const bases: string[] = [];
      if (opts.preferredRoot) bases.push(path.resolve(opts.preferredRoot));
      for (const r of allowedRoots) {
        if (!bases.includes(r)) bases.push(r);
      }
      for (const base of bases) candidates.push(path.resolve(base, cleaned));
    }

    for (const candidate of candidates) {
      let real: string;
      let stat: fs.Stats;
      try {
        real = await fsp.realpath(candidate);
        stat = await fsp.stat(real);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      // Confine to allowed roots unless the operator has opted into any-path
      // attachment (single-user trusted instances). The realpath check above
      // still resolves symlinks, so the gate (when on) can't be tricked.
      if (
        !this.config.ATTACH_ALLOW_ANY_PATH &&
        !allowedRoots.some((r) => isWithinRoot(real, r))
      ) {
        continue;
      }
      return { realPath: real, size: stat.size };
    }
    return null;
  }

  private async cmdAttach(i: ChatInputCommandInteraction): Promise<void> {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.reply({
        content: `Use \`/${this.cmd} attach\` from inside a thread.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!this.adapter.sendFile) {
      await i.reply({
        content: "This platform does not support file uploads.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const requested = i.options.getString("path", true);
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    // Resolve a relative path against THIS thread's current project (repoPath)
    // first, then the allowed roots. Without passing preferredRoot, `/seam
    // attach src/foo.ts` only tried REPOS_ROOT/ATTACH_ROOTS and never the active
    // repo — so project-relative paths failed.
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const resolved = await this.resolveAllowedHostFile(requested, {
      preferredRoot: record.repoPath ?? null,
    });
    if (!resolved) {
      await i.editReply(
        `Could not attach \`${requested}\` — file not found (relative to the thread's repo or an allowed root), not a regular file, or outside REPOS_ROOT / ATTACH_ROOTS.`
      );
      return;
    }

    const MAX = 25 * 1024 * 1024;
    if (resolved.size > MAX) {
      await i.editReply(
        `File too large for Discord: ${resolved.size} B (25 MB limit).`
      );
      return;
    }

    let data: Buffer;
    try {
      data = await fsp.readFile(resolved.realPath);
    } catch (err) {
      await i.editReply(`Read failed: ${(err as Error).message}`);
      return;
    }

    const filename = path.basename(resolved.realPath);
    const mimeType = mimeTypeForFilename(filename);

    try {
      await this.adapter.sendFile(channel, { data, filename, mimeType });
      await i.editReply(`📎 Posted \`${filename}\` (${data.byteLength} B).`);
    } catch (err) {
      this.logger.warn({ err, filename }, "/seam attach upload failed");
      await i.editReply(`Upload failed: ${(err as Error).message}`);
    }
  }

  private async cmdWhoami(i: ChatInputCommandInteraction): Promise<void> {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.editReply({ content: "Use inside a thread." });
      return;
    }
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const profile = this.router.getProfile(record.agentId);
    if (!profile) {
      await i.editReply({
        content: `Agent \`${record.agentId}\` is not registered on this bot.`,
      });
      return;
    }
    if (!profile.whoami) {
      await i.editReply({
        content: `Agent \`${profile.id}\` (${profile.displayName}) does not expose account info.`,
      });
      return;
    }
    const id = await profile.whoami();
    if (!id) {
      await i.editReply({
        content:
          `Agent \`${profile.id}\` (${profile.displayName}) — no logged-in account found. ` +
          `Run \`copilot login\` (set \`COPILOT_HOME\` for non-default profiles) on the host.`,
      });
      return;
    }
    const hostNote = id.host ? ` (${id.host})` : "";
    await i.editReply({
      content: `Agent \`${profile.id}\` (${profile.displayName}) is signed in as **${id.login}**${hostNote}.`,
    });
  }

  private async cmdUsage(i: ChatInputCommandInteraction): Promise<void> {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = this.channelRefFromInteraction(i);
    if (!channel) {
      await i.editReply({ content: "Use inside a thread." });
      return;
    }
    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    const isAgy = record.agentId === "agy";
    const isClaude = record.agentId === "claude" || record.agentId.startsWith("claude-");
    const isCopilot =
      record.agentId === "copilot" ||
      (record.agentId.startsWith("copilot-") && !record.agentId.startsWith("copilot-remote"));
    if (!isAgy && !isClaude && !isCopilot) {
      await i.editReply({
        content: `\`/${this.cmd} usage\` is only available for the \`agy\`, \`claude\`, and \`copilot\` agents. This thread uses \`${record.agentId}\`.`,
      });
      return;
    }
    try {
      const profile = this.router.getProfile(record.agentId);
      const configDir = profile?.configDir;
      if (isAgy) {
        const { fetchAgyUserStatus } = await import("../../agents/profiles/agy.js");
        const data = await fetchAgyUserStatus(this.config.AGY_CLI_PATH);
        await i.editReply({ content: formatAgyUsage(data) });
      } else if (isClaude) {
        const { fetchClaudeUsage } = await import("../../agents/profiles/claude.js");
        const data = await fetchClaudeUsage(configDir);
        await i.editReply({ content: formatClaudeUsage(data) });
      } else {
        const { fetchCopilotUsage } = await import("../../agents/profiles/copilot.js");
        const data = await fetchCopilotUsage(configDir);
        await i.editReply({ content: formatCopilotUsage(data) });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err }, "/seam usage failed");
      await i.editReply({ content: `Couldn't fetch usage: ${msg}` });
    }
  }

  private async cmdAvatar(i: ChatInputCommandInteraction): Promise<void> {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const adapter = this.adapter as unknown as DiscordAdapter;
      const avatarOk = await adapter.pushAvatar();
      let bannerOk = false;
      let bannerErr: string | undefined;
      try {
        bannerOk = await adapter.pushBanner();
      } catch (err: unknown) {
        bannerErr = err instanceof Error ? err.message : String(err);
      }
      const parts: string[] = [];
      parts.push(
        avatarOk
          ? "✅ Bot avatar updated."
          : "⚠️ Avatar file not found (`assets/seam-acp-avatar.png`)."
      );
      if (bannerErr) {
        parts.push(`⚠️ Banner update failed: ${bannerErr}`);
      } else {
        parts.push(
          bannerOk
            ? "✅ Bot banner updated."
            : "⚠️ Banner file not found (`assets/seam-acp-banner.png`)."
        );
      }
      await i.editReply({ content: parts.join("\n") });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await i.editReply({ content: `❌ Failed to update avatar: ${msg}` });
    }
  }

  private async cmdHelp(i: ChatInputCommandInteraction): Promise<void> {
    const c = `/${this.config.DISCORD_COMMAND_NAME}`;
    const lines = [
      "**seam-acp** — control the agent in this thread.",
      "",
      `\`${c} new [name]\` — create a new agent thread`,
      `\`${c} init\` — bind this thread + show repo picker`,
      `\`${c} repo set <path>\` — set working repo (type to search / autocomplete)`,
      `\`${c} repo list\` — list repos under REPOS_ROOT`,
      `\`${c} repo clone <source> [name]\` — clone a remote repo and bind it`,
      `\`${c} repo new <name>\` — create a new empty repo and bind it`,
      `\`${c} model [id]\` — get / set agent model`,
      `\`${c} mode <id>\` — set agent operational mode`,
      `\`${c} effort <low|medium|high>\` — reasoning effort`,
      `\`${c} tools <allow|exclude> [list]\` — tool filters`,
      `\`${c} approve <always|ask|deny>\` — permission policy`,
      `\`${c} abort\` — cancel current turn`,
      `\`${c} config\` — show session config JSON`,
      `\`${c} config-set <json>\` — replace session config`,
      `\`${c} sessions\` — list known sessions`,
      `\`${c} attach <path>\` — upload a host-side file (under REPOS_ROOT or ATTACH_ROOTS) to this channel`,
      `\`${c} whoami\` — show the account this thread's agent is signed in as`,
      `\`${c} usage\` — show usage / credits (agy only)`,
      `\`${c} avatar\` — re-push bot avatar to Discord`,
      "",
      "Free-form messages in a thread are sent to the agent.",
    ];
    await i.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
  }

  // --- agent file uploads (Phase 2) ---

  /**
   * Upload a file produced by the agent (image / audio / embedded resource)
   * to the Discord thread. Falls back to inline text if the adapter doesn't
   * implement sendFile or the file is over Discord's free-tier 25 MB limit.
   */
  private async sendAgentFile(
    channel: ChannelRef,
    event: {
      filename: string;
      mimeType: string;
      data: string;
      base64: boolean;
      uri?: string;
    }
  ): Promise<void> {
    const buf = event.base64
      ? Buffer.from(event.data, "base64")
      : Buffer.from(event.data, "utf8");

    if (!this.adapter.sendFile) {
      await this.adapter.sendMessage(
        channel,
        `_Agent produced \`${event.filename}\` (${event.mimeType}, ${buf.byteLength} B) but this platform doesn't support file uploads._`
      );
      return;
    }

    const MAX_DISCORD_BYTES = 25 * 1024 * 1024;
    if (buf.byteLength > MAX_DISCORD_BYTES) {
      await this.adapter.sendMessage(
        channel,
        `_Agent produced \`${event.filename}\` (${buf.byteLength} B) — too large for Discord (25 MB limit)._${
          event.uri ? ` Source: ${event.uri}` : ""
        }`
      );
      return;
    }

    await this.adapter.sendFile(channel, {
      data: buf,
      filename: event.filename,
      mimeType: event.mimeType,
    });
  }

  /**
   * Render a closed fence to the chat thread. Routes between an inline
   * markdown message and a file attachment based on the rendered inline
   * size; bare-filename fences that resolve to a real host file under
   * the allowed roots are uploaded as the actual file.
   *
   * Failures are logged, never thrown.
   */
  private async emitClosedFence(
    channel: ChannelRef,
    fence: CompletedFence,
    counter: number,
    opts: { notice?: string; preferredRoot?: string | null } = {}
  ): Promise<void> {
    // Explicit file-attach signal: a fence tagged `seam-attach` whose body is a
    // workspace file path. Upload the real file (resolved against the thread's
    // repo) and suppress the block — it's a directive, not content to render.
    // Replaces the old existence-based "bare filename" auto-attach, which would
    // attach ANY fenced path that happened to exist — a footgun when an agent
    // merely references files while narrating its work.
    if (fence.lang === ATTACH_FENCE_LANG) {
      await this.emitAttachFence(channel, fence, opts);
      return;
    }

    // Inline-rendered total size = ```lang\n<content>\n``` plus optional
    // trailing notice on its own paragraph.
    const inlineMessageLen =
      3 + fence.lang.length + 1 + fence.content.length + 1 + 3 +
      (opts.notice ? 2 + opts.notice.length : 0);
    const fitsInline = inlineMessageLen <= ORCH_INLINE_FENCE_MAX;

    if (fitsInline || !this.adapter.sendFile) {
      await this.emitFenceInline(channel, fence, opts);
      return;
    }
    await this.emitFenceAttachment(channel, fence, counter, opts);
  }

  /**
   * Upload a workspace file the agent requested via a `seam-attach` fence. The
   * first non-empty line of the fence body is the path; it is resolved against
   * the thread's repo first, then the allowed roots (the realpath within-root
   * check blocks `..` escapes). On any failure we post a short note rather than
   * silently rendering the directive as a raw code block.
   */
  private async emitAttachFence(
    channel: ChannelRef,
    fence: CompletedFence,
    opts: { notice?: string; preferredRoot?: string | null }
  ): Promise<void> {
    const note = opts.notice ? `\n\n${opts.notice}` : "";
    if (!this.adapter.sendFile) {
      await this.adapter
        .sendMessage(channel, `_(Agent requested a file attachment, but this platform can't upload files.)_${note}`)
        .catch(() => {});
      return;
    }
    const reqPath = (fence.content.split("\n").find((l) => l.trim()) ?? "").trim();
    if (!reqPath) return;
    const resolved = await this.resolveAllowedHostFile(reqPath, {
      preferredRoot: opts.preferredRoot ?? null,
    });
    if (!resolved) {
      await this.adapter
        .sendMessage(channel, `_(Couldn't attach \`${reqPath}\` — not found relative to the repo or an allowed root, or outside REPOS_ROOT / ATTACH_ROOTS.)_${note}`)
        .catch(() => {});
      return;
    }
    const MAX = 25 * 1024 * 1024;
    if (resolved.size > MAX) {
      await this.adapter
        .sendMessage(channel, `_(Can't attach \`${path.basename(resolved.realPath)}\` — ${resolved.size} B exceeds the 25 MB limit.)_${note}`)
        .catch(() => {});
      return;
    }
    try {
      const data = await fsp.readFile(resolved.realPath);
      const filename = path.basename(resolved.realPath);
      await this.adapter.sendFile(channel, {
        data,
        filename,
        mimeType: mimeTypeForFilename(filename),
      });
      if (opts.notice) {
        await this.adapter.sendMessage(channel, opts.notice).catch(() => {});
      }
      this.logger.info(
        { realPath: resolved.realPath, bytes: data.byteLength },
        "seam-attach fence → uploaded workspace file"
      );
    } catch (err) {
      this.logger.warn({ err, realPath: resolved.realPath }, "seam-attach read/upload failed");
      await this.adapter
        .sendMessage(channel, `_(Failed to read \`${reqPath}\` for attachment.)_${note}`)
        .catch(() => {});
    }
  }

  /**
   * Render a fence as an inline ```lang\n...\n``` Discord message,
   * with an optional trailing notice paragraph.
   */
  private async emitFenceInline(
    channel: ChannelRef,
    fence: CompletedFence,
    opts: { notice?: string } = {}
  ): Promise<void> {
    const body = `\`\`\`${fence.lang}\n${fence.content}\n\`\`\``;
    const text = opts.notice ? `${body}\n\n${opts.notice}` : body;
    try {
      await this.adapter.sendMessage(channel, text);
    } catch (err) {
      this.logger.warn({ err }, "fence inline send failed");
    }
  }

  /**
   * Upload a fence as a Discord file attachment. Falls back to inline
   * rendering if the adapter doesn't support file uploads or the
   * content exceeds Discord's 25 MB limit.
   */
  private async emitFenceAttachment(
    channel: ChannelRef,
    fence: CompletedFence,
    counter: number,
    opts: { notice?: string } = {}
  ): Promise<void> {
    if (!this.adapter.sendFile) {
      await this.emitFenceInline(channel, fence, opts);
      return;
    }
    const filename =
      fence.ext === "Dockerfile"
        ? counter === 1
          ? "Dockerfile"
          : `Dockerfile.${counter}`
        : `snippet-${counter}.${fence.ext}`;
    try {
      const buf = Buffer.from(fence.content, "utf8");
      const MAX = 25 * 1024 * 1024;
      if (buf.byteLength > MAX) {
        await this.adapter.sendMessage(
          channel,
          `_Code block too large to upload (${buf.byteLength} B, Discord 25 MB limit)._${
            opts.notice ? `\n\n${opts.notice}` : ""
          }`
        );
        return;
      }
      await this.adapter.sendFile(channel, {
        data: buf,
        filename,
        mimeType: fence.mimeType,
      });
      if (opts.notice) {
        try {
          await this.adapter.sendMessage(channel, opts.notice);
        } catch (err) {
          this.logger.warn({ err }, "fence attachment notice send failed");
        }
      }
    } catch (err) {
      this.logger.warn({ err, filename }, "fence upload failed");
    }
  }

  // --- repo picker ---

  private async sendRepoPicker(channel: ChannelRef): Promise<void> {
    const dirs = this.listRepoDirs();
    if (!dirs) {
      await this.adapter.sendMessage(
        channel,
        `❌ REPOS_ROOT not found: \`${this.config.REPOS_ROOT}\``
      );
      return;
    }
    if (dirs.length === 0) {
      await this.adapter.sendMessage(
        channel,
        `⚠️ No repos under \`${this.config.REPOS_ROOT}\`. Use \`/${this.cmd} repo set <path>\`.`
      );
      return;
    }

    if (!this.adapter.sendChoicePicker) {
      // Adapter without interactive picker: list paths and let the user
      // pick via /seam repo set <path>.
      const lines = dirs
        .slice(0, 20)
        .map((p) => `• ${path.basename(p)}`)
        .join("\n");
      await this.adapter.sendMessage(
        channel,
        `🗂️ **Available repos**\n${this.renderer.codeBlock(lines)}\nUse \`/${this.cmd} repo set <name>\`.`
      );
      return;
    }

    // Discord allows up to 25 select options; cap and warn if needed.
    const top = dirs.slice(0, 25);
    const overflow = dirs.length - top.length;

    const result = await this.adapter.sendChoicePicker(channel, {
      panel: {
        color: 0x5865f2,
        title: "🗂️ Select a project to begin",
        description: overflow > 0 ? `_(Showing first 25 of ${dirs.length} projects. Use \`/${this.cmd} repo set <path>\` to access the rest.)_` : undefined,
        fields: [],
      },
      choices: top.map((p) => ({
        value: p,
        label: path.basename(p),
      })),
      authorizedUserIds: this.config.DISCORD_ALLOWED_USER_IDS,
      successPanel: (pickedChoice, username) => ({
        color: 0x57f287,
        title: "✅ Project selected",
        fields: [
          { name: "Project", value: `\`${pickedChoice.label}\``, inline: true },
        ],
        footer: `Started by ${username}`
      }),
    });

    if (!result) return;

    const picked = result.value;
    let target: string;
    try {
      target = resolveRepoWithinRoot(this.config.REPOS_ROOT, picked);
    } catch (err) {
      await this.adapter.sendMessage(channel, `🛡️ ${(err as Error).message}`);
      return;
    }

    const record = this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
    await this.router.rebindRepo(record.id, target);

    if (this.config.NEW_THREAD_WIZARD === "full") {
      await this.adapter.sendMessage(
        channel,
        `📌 Repo set to \`${this.repoDisplay(picked)}\`.`
      );
      // Re-read the record after repo was set.
      const freshRecord = this.store.get(record.id) ?? record;
      await this.runSetupWizard(channel, freshRecord);
    } else {
      const freshRecord = this.store.get(record.id) ?? record;
      await this.renameThreadForSetup(channel, freshRecord);
      await this.adapter.sendMessage(
        channel,
        `📌 Repo set to \`${this.repoDisplay(picked)}\`. Send a message to begin.`
      );
    }
  }

  private listRepoDirs(): string[] | undefined {
    const root = this.config.REPOS_ROOT;
    if (!fs.existsSync(root)) return undefined;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      this.logger.warn({ err, root }, "readdir failed");
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => path.join(root, e.name))
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * Post-repo-selection setup wizard: presents an agent picker followed by a
   * model picker. Called from `sendRepoPicker` when `NEW_THREAD_WIZARD=full`.
   *
   * Either picker can be skipped (only one option, user timeout, adapter
   * lacks `sendChoicePicker`). A runtime start failure for the model picker
   * is handled gracefully with a fallback notice.
   */
  private async runSetupWizard(
    channel: ChannelRef,
    record: SessionRecord
  ): Promise<void> {
    let currentRecord = record;

    // Step 1: Agent picker (skip when there's only one profile).
    const profiles = this.router.listProfiles();
    if (profiles.length > 1 && this.adapter.sendChoicePicker) {
      const picked = await this.adapter.sendChoicePicker(channel, {
        panel: {
          color: 0x5865f2,
          title: "🤖 Choose an agent",
          fields: [{ name: "Default", value: `\`${currentRecord.agentId}\``, inline: true }],
        },
        choices: profiles.map((p) => ({
          value: p.id,
          label: p.displayName,
          description:
            p.id === currentRecord.agentId ? `${p.id} (current)` : p.id,
        })),
        authorizedUserIds: this.config.DISCORD_ALLOWED_USER_IDS,
        successPanel: (pickedChoice, username) => ({
          color: 0x57f287,
          title: "✅ Agent changed",
          fields: [
            { name: "Default", value: `\`${currentRecord.agentId}\``, inline: true },
            { name: "New", value: `\`${pickedChoice.value}\``, inline: true },
          ],
          footer: `Changed by ${username}`
        }),
      });
      if (!picked) {
        // User timed out / cancelled — rename with default agent and end wizard.
        await this.renameThreadForSetup(channel, currentRecord);
        await this.adapter.sendMessage(
          channel,
          `✅ Setup complete. Send a message to begin.`
        );
        return;
      }
      if (picked.value !== currentRecord.agentId) {
        await this.applyAgentChange(channel, currentRecord, picked.value);
        // Re-read: applyAgentChange updated agent + model in the DB.
        currentRecord = this.store.get(currentRecord.id) ?? currentRecord;
      }
    }

    // Rename the thread now that we know the final agent.
    await this.renameThreadForSetup(channel, currentRecord);

    // Step 2: Model picker
    if (this.adapter.sendChoicePicker) {
      try {
        let models: ReadonlyArray<{ modelId: string; name?: string }> = [];
        const profile = this.router.getProfile(currentRecord.agentId);
        
        if (profile?.staticModels && profile.staticModels.length > 0) {
          models = profile.staticModels;
        } else {
          const rt = await this.router.getOrStartRuntime(currentRecord);
          models = rt.getSessionInfo()?.availableModels ?? [];
        }
        
        this.logger.info({ agentId: currentRecord.agentId, modelsLength: models.length }, "Setup wizard checking models for picker");

        if (models.length > 1) {
          const cfg = this.store.readConfig(currentRecord);
          const current = cfg.model ?? this.config.DEFAULT_MODEL;
          const picked = await this.adapter.sendChoicePicker(channel, {
            panel: {
              color: 0x5865f2,
              title: "🧠 Choose a model",
              fields: [{ name: "Default", value: `\`${current}\``, inline: true }],
            },
            choices: models.slice(0, 25).map((m) => ({
              value: m.modelId,
              label: m.name ?? m.modelId,
              description:
                m.modelId === current ? `${m.modelId} (current)` : m.modelId,
            })),
            authorizedUserIds: this.config.DISCORD_ALLOWED_USER_IDS,
            successPanel: (pickedChoice, username) => ({
              color: 0x57f287,
              title: "✅ Model changed",
              fields: [
                { name: "Default", value: `\`${current}\``, inline: true },
                { name: "New", value: `\`${pickedChoice.value}\``, inline: true },
              ],
              footer: `Changed by ${username}`
            }),
          });
          if (picked && picked.value !== current) {
            await this.applyModelChange(channel, currentRecord, picked.value);
          }
        }
      } catch (err) {
        this.logger.warn(
          { err },
          "wizard: could not start runtime for model picker"
        );
        await this.adapter.sendMessage(
          channel,
          `_Could not list models: ${(err as Error).message}. Use \`/${this.cmd} model\` later._`
        );
      }
    }

    await this.adapter.sendMessage(
      channel,
      `✅ Setup complete. Send a message to begin.`
    );
  }

  /**
   * Rename a thread to "<repo-basename> [<agent-abbr>]" after setup.
   * Best-effort: silently skipped if the adapter, channel, or profile doesn't
   * support it.
   */
  private async renameThreadForSetup(
    channel: ChannelRef,
    record: SessionRecord
  ): Promise<void> {
    if (!this.adapter.renameThread) return;
    if (!channel.parentId) return; // not a thread
    const repoPath = record.repoPath;
    if (!repoPath) return;
    const profile = this.router.getProfile(record.agentId);
    const abbr = profile?.threadAbbr;
    if (!abbr) return;
    // Only rename if the thread still has the default (command-name) name; skip
    // if the user already gave it a custom name when running `/<cmd> new`.
    let current: string | undefined;
    if (this.adapter.getThreadName) {
      current = await this.adapter.getThreadName(channel);
      if (current !== undefined && current !== this.cmd) return;
    }
    const repoDisplayStr = this.repoDisplay(repoPath);
    const newName = `${repoDisplayStr} ${abbr}`;
    this.logger.info({ channelId: channel.id, oldName: current, newName }, "Renaming thread");
    try {
      await this.adapter.renameThread(channel, newName);
    } catch (err) {
      this.logger.warn({ err }, "wizard: renameThread failed");
    }
  }

  /**
   * Update the thread name abbreviation when migrating or switching agents.
   * Replaces any known agent abbreviations in brackets (e.g. [agy]) with the new target agent's abbreviation.
   */
  private async updateThreadAbbreviation(
    channel: ChannelRef,
    oldAgentId: string,
    newAgentId: string
  ): Promise<void> {
    if (!this.adapter.getThreadName || !this.adapter.renameThread || !channel.parentId) {
      return;
    }
    try {
      const currentName = await this.adapter.getThreadName(channel);
      if (!currentName) return;

      const targetProfile = this.router.getProfile(newAgentId);
      const targetAbbr = targetProfile?.threadAbbr;
      if (!targetAbbr) return;

      const allAbbrs = this.router.listProfiles()
        .map((p) => p.threadAbbr)
        .filter((abbr): abbr is string => typeof abbr === "string" && abbr.length > 0)
        .filter((abbr) => abbr.toLowerCase() !== targetAbbr.toLowerCase());

      let newName = currentName;
      let replaced = false;

      for (const abbr of allAbbrs) {
        // Case-insensitive replace so a thread named "… [AGY]" still matches the
        // "agy" abbreviation. Escape the abbr for the RegExp; a single .replace
        // pass also avoids the old indexOf-loop's infinite loop when a target
        // abbreviation contains the one being replaced.
        const re = new RegExp(abbr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        const next = newName.replace(re, targetAbbr);
        if (next !== newName) {
          newName = next;
          replaced = true;
        }
      }

      if (replaced && newName !== currentName) {
        await this.adapter.renameThread(channel, newName);
        this.logger.info(
          { channelId: channel.id, oldName: currentName, newName },
          "Updated thread name abbreviation on agent transition"
        );
      }
    } catch (err) {
      this.logger.warn(
        { err, channelId: channel.id },
        "Failed to update thread name abbreviation"
      );
    }
  }

  // --- helpers ---

  private channelRefFromInteraction(
    i: ChatInputCommandInteraction | MessageComponentInteraction
  ): ChannelRef | undefined {
    if (!i.channelId) return undefined;
    const ch = i.channel;
    const parentId =
      ch && "parentId" in ch && typeof ch.parentId === "string"
        ? ch.parentId
        : undefined;
    return {
      platform: PLATFORM,
      id: i.channelId,
      ...(parentId ? { parentId } : {}),
    };
  }

  private recordFromInteraction(
    i: ChatInputCommandInteraction
  ): ReturnType<SessionRouter["ensureSessionRecord"]> | undefined {
    const channel = this.channelRefFromInteraction(i);
    if (!channel) return undefined;
    return this.router.ensureSessionRecord({
      platform: channel.platform,
      channelRef: channel.id,
      ...(channel.parentId ? { parentRef: channel.parentId } : {}),
      cwd: this.config.REPOS_ROOT,
    });
  }

  private persistConfig(
    record: ReturnType<SessionRouter["ensureSessionRecord"]>,
    cfg: ReturnType<SessionStore["readConfig"]>
  ): void {
    // Narrow write: touch only config_json. Never rewrite repo_path /
    // acp_session_id from the (possibly stale) in-memory record — a concurrent
    // repo rebind or out-of-band ACP-id assignment must not be clobbered.
    this.store.updateConfig(record.id, this.store.writeConfig(cfg));
  }

  private repoDisplay(repoPath: string | null): string {
    if (!repoPath) return "(unset)";
    const root = path.resolve(this.config.REPOS_ROOT);
    const abs = path.resolve(repoPath);
    
    let displayName = abs;
    if (abs === root) {
      displayName = "/";
    } else if (abs.startsWith(root + path.sep)) {
      displayName = abs.slice(root.length + 1);
    }

    if (displayName !== "/" && displayName !== "(unset)" && displayName !== abs) {
      const rootFolder = displayName.split(path.sep)[0] ?? "";
      const emoji = this.config.REPO_EMOJIS.get(rootFolder) || this.config.REPO_EMOJIS.get(displayName);
      if (emoji) {
        return `${emoji} ${displayName}`;
      }
    }

    return displayName;
  }
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseCsv(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function usageBar(pct: number): string {
  const filled = Math.min(20, Math.round(pct / 5));
  return "█".repeat(filled) + "░".repeat(20 - filled);
}

function usageLine(pct: number | null, label: string): string {
  const bar = pct !== null ? usageBar(pct) : "░░░░░░░░░░░░░░░░░░░░";
  const pctStr = pct !== null ? `${Math.round(pct)}%`.padStart(4) : "  — ";
  return `\`${bar}\`  ${pctStr}  ${label}`;
}

function formatContextUsage(used: number, size: number): string {
  const pct = Math.round((used / size) * 100);
  return `${fmtTokens(used)} / ${fmtTokens(size)} (${pct}%)`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}m`;
  return `${Math.round(n / 1_000)}k`;
}

/** Hardcoded context windows for the models we use as compaction summarizers.
 *  Hardcoded rather than discovered because the call sites need the window
 *  BEFORE spawning the temp runtime that would learn it from usage_update. */
const COMPACTION_MODEL_WINDOWS: Record<string, number> = {
  default: 1_000_000, // resolves to latest Opus @ 1M on this account
  "opus[1m]": 1_000_000,
  "gpt-5.5": 400_000,
  "Gemini 3.1 Pro (High)": 1_000_000,
  "Claude Opus 4.6 (Thinking)": 250_000,
  "glm-5.2": 1_000_000,
  "qwen3-coder:480b-cloud": 256_000,
  "glm-5.2:cloud": 976_000,
};

function compactionWindowFor(modelId: string): number {
  return COMPACTION_MODEL_WINDOWS[modelId] ?? 200_000;
}

/** Trim a sanitized transcript so that `template + transcript` fits within
 *  ~80% of the summarizer model's window (leaving headroom for the response).
 *  Drops middle content with a marker; keeps 30% head + 60% tail of the
 *  budget. ~4 chars/token is conservative — real tokenizers pack denser. */
function fitTranscriptToWindow(
  transcript: string,
  templateOverhead: number,
  modelWindowTokens: number
): string {
  const maxChars = Math.floor(modelWindowTokens * 4 * 0.8);
  const targetLen = Math.max(0, maxChars - templateOverhead);
  if (transcript.length <= targetLen) return transcript;
  const keepHead = Math.floor(targetLen * 0.3);
  const keepTail = Math.floor(targetLen * 0.6);
  return (
    transcript.substring(0, keepHead) +
    "\n\n... [Transcript truncated to fit context window] ...\n\n" +
    transcript.substring(transcript.length - keepTail)
  );
}

function formatAgyUsage(d: import("../../agents/profiles/agy.js").AgyUsage): string {
  const lines: string[] = [];
  const who = [d.name, d.email].filter(Boolean).join(" · ");
  lines.push(`**Antigravity usage**${who ? ` — ${who}` : ""}`);
  const fmt = (n?: number): string =>
    typeof n === "number" ? n.toLocaleString("en-US") : "—";
  if (d.monthlyPromptCredits !== undefined || d.availablePromptCredits !== undefined) {
    const avail = d.availablePromptCredits ?? 0;
    const total = d.monthlyPromptCredits ?? 0;
    const pct = total > 0 ? ((total - avail) / total) * 100 : 0;
    lines.push(usageLine(pct, `Prompt credits — ${fmt(avail)} / ${fmt(total)} remaining`));
  }
  if (d.monthlyFlowCredits !== undefined || d.availableFlowCredits !== undefined) {
    const avail = d.availableFlowCredits ?? 0;
    const total = d.monthlyFlowCredits ?? 0;
    const pct = total > 0 ? ((total - avail) / total) * 100 : 0;
    lines.push(usageLine(pct, `Flow credits — ${fmt(avail)} / ${fmt(total)} remaining`));
  }
  const modelsWithQuota = d.models.filter(
    (m) => typeof m.remainingFraction === "number" || m.resetTime,
  );
  if (modelsWithQuota.length > 0) {
    lines.push("", "**Per-model quotas**");
    for (const m of modelsWithQuota) {
      if (typeof m.remainingFraction !== "number") continue;
      const pct = (1 - m.remainingFraction) * 100;
      const reset = m.resetTime ? ` · resets ${formatResetTime(m.resetTime)}` : "";
      lines.push(usageLine(pct, `${m.label}${reset}`));
    }
  }
  return lines.join("\n");
}

function formatCopilotUsage(
  d: import("../../agents/profiles/copilot.js").CopilotUsageData
): string {
  const lines: string[] = [];
  const who = [d.login, d.org ? `(${d.org})` : null].filter(Boolean).join(" ");
  lines.push(`**GitHub Copilot usage**${who ? ` — ${who}` : ""}`);
  if (d.plan) lines.push(`Plan: \`${d.plan}\``);
  const fmtQuota = (
    label: string,
    q: import("../../agents/profiles/copilot.js").CopilotQuotaSnapshot | null
  ): string | null => {
    if (!q) return null;
    if (q.unlimited) return `${label}: unlimited`;
    const used = q.entitlement - q.remaining;
    const pct = q.entitlement > 0 ? (used / q.entitlement) * 100 : 0;
    const over = q.overageCount > 0 ? ` (+${q.overageCount} overage)` : "";
    return usageLine(pct, `${label} — ${used} / ${q.entitlement}${over}`);
  };
  const quotas = [
    fmtQuota("Premium interactions", d.premiumInteractions),
    fmtQuota("Chat", d.chat),
    fmtQuota("Completions", d.completions),
  ].filter((s): s is string => s !== null);
  if (quotas.length > 0) {
    lines.push("", "**Quotas**", ...quotas);
    if (d.quotaResetAt) lines.push(`Resets ${formatResetTime(d.quotaResetAt)}`);
  }
  return lines.join("\n");
}

function formatClaudeUsage(
  d: import("../../agents/profiles/claude.js").ClaudeUsageData
): string {
  const lines: string[] = [];
  lines.push(`**Claude Code usage**${d.login ? ` — ${d.login}` : ""}`);
  if (d.subscriptionType) {
    const tier = d.rateLimitTier ? ` (${d.rateLimitTier})` : "";
    lines.push(`Subscription: \`${d.subscriptionType}${tier}\``);
  }
  const fmtBucket = (
    label: string,
    b: import("../../agents/profiles/claude.js").ClaudeUsageBucket | null
  ): string | null => {
    if (!b) return null;
    const reset = b.resetsAt ? ` · resets ${formatResetTime(b.resetsAt)}` : "";
    return usageLine(b.utilization, `${label}${reset}`);
  };
  const buckets = [
    fmtBucket("Current 5h session", d.fiveHour),
    fmtBucket("Current week (all models)", d.sevenDay),
    fmtBucket("Current week (Sonnet)", d.sevenDaySonnet),
    fmtBucket("Current week (Opus)", d.sevenDayOpus),
  ].filter((s): s is string => s !== null);
  if (buckets.length > 0) {
    lines.push("", "**Rate-limit utilization**", ...buckets);
  }
  if (d.extraUsage && d.extraUsage.enabled) {
    const dollars = (n: number): string => `$${(n / 100).toFixed(2)}`;
    const pct = d.extraUsage.utilization;
    lines.push(
      "",
      "**Usage credits**",
      usageLine(d.extraUsage.utilization, `${dollars(d.extraUsage.used)} / ${dollars(d.extraUsage.limit)}`),
    );
  }
  return lines.join("\n");
}

function formatResetTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const secs = Math.round((d.getTime() - Date.now()) / 1000);
  if (secs <= 0) return "now";
  if (secs < 3600) return `in ${Math.round(secs / 60)}m`;
  if (secs < 86400) return `in ${Math.round(secs / 3600)}h`;
  return `in ${Math.round(secs / 86400)}d`;
}

// Re-export for convenience.
export type { EmbedBuilder };

// -----------------------------------------------------------------------
// /seam image picker — state + render
// -----------------------------------------------------------------------

interface ImagePickerState {
  prompt: string;
  modelId: string;
  aspectRatio: AspectRatio;
  resolution: Resolution;
  count: number;
  references: ReferenceImage[];
  bflKeyAvailable: boolean;
}

interface ImagePickerRenderOpts {
  status?: "idle" | "generating" | "done" | "error";
  elapsedSec?: string;
  errorMessage?: string;
  savedPaths?: string[];
}

function renderImagePicker(
  state: ImagePickerState,
  opts: ImagePickerRenderOpts = {}
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] } {
  const model = getImageModelById(state.modelId) ?? IMAGE_MODELS[0]!;
  const status = opts.status ?? "idle";

  const colorByStatus: Record<string, number> = {
    idle: 0x5865f2,
    generating: 0xfaa61a,
    done: 0x57f287,
    error: 0xed4245,
  };

  let title = "🎨 Image Generator";
  if (status === "generating") title = "🎨 Generating…";
  if (status === "done") title = `✅ Generated in ${opts.elapsedSec ?? "?"}s`;
  if (status === "error") title = "❌ Generation failed";

  const promptPreview =
    state.prompt.length > 1000
      ? state.prompt.slice(0, 997) + "…"
      : state.prompt;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(colorByStatus[status]!)
    .setDescription(`> ${promptPreview.replace(/\n/g, "\n> ")}`);

  embed.addFields(
    { name: "Model", value: `${model.displayName}`, inline: true },
    { name: "Aspect", value: state.aspectRatio, inline: true },
    { name: "Resolution", value: state.resolution, inline: true },
    { name: "Count", value: `${state.count}`, inline: true }
  );
  if (model.maxReferenceImages > 0) {
    embed.addFields({
      name: "Refs",
      value: `${state.references.length} / ${model.maxReferenceImages}`,
      inline: true,
    });
  }
  if (status === "error" && opts.errorMessage) {
    embed.addFields({ name: "Error", value: "```\n" + opts.errorMessage.slice(0, 1000) + "\n```" });
  }
  if (status === "done" && opts.savedPaths && opts.savedPaths.length > 0) {
    embed.addFields({
      name: "Saved",
      value: opts.savedPaths.map((p) => `\`${p}\``).join("\n").slice(0, 1024),
    });
  }

  if (status === "generating") {
    // Keep the picker visible but disable the controls during generation.
    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("img:noop")
            .setLabel("Generating…")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
        ),
      ],
    };
  }

  // Model select
  const visibleModels = IMAGE_MODELS.filter(
    (m) => m.provider !== "bfl" || state.bflKeyAvailable
  );
  const modelSelect = new StringSelectMenuBuilder()
    .setCustomId("img:model")
    .setPlaceholder("Pick model")
    .addOptions(
      visibleModels.map((m) => ({
        label: m.displayName,
        description: m.description.slice(0, 100),
        value: m.id,
        default: m.id === state.modelId,
      }))
    );

  // Aspect: button row when ≤5 ratios, select menu otherwise (Discord caps
  // ActionRow at 5 buttons; FLUX has 6 ratios with 21:9 added).
  const aspectRow =
    model.aspectRatios.length <= 5
      ? new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...model.aspectRatios.map((ar) =>
            new ButtonBuilder()
              .setCustomId(`img:aspect:${ar}`)
              .setLabel(ar)
              .setStyle(ar === state.aspectRatio ? ButtonStyle.Primary : ButtonStyle.Secondary)
          )
        )
      : new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("img:aspect-select")
            .setPlaceholder("Aspect ratio")
            .addOptions(
              model.aspectRatios.map((ar) => ({
                label: ar,
                value: ar,
                default: ar === state.aspectRatio,
              }))
            )
        );

  // Resolution row (1K / 2K / 4K — per-model)
  const resolutionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...model.resolutions.map((r) =>
      new ButtonBuilder()
        .setCustomId(`img:res:${r}`)
        .setLabel(r)
        .setStyle(r === state.resolution ? ButtonStyle.Primary : ButtonStyle.Secondary)
    )
  );

  // Count buttons (1..maxCount, capped at 4 visible)
  const countChoices: number[] = [];
  for (let n = 1; n <= Math.min(model.maxCount, 4); n++) countChoices.push(n);
  const countRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...countChoices.map((n) =>
      new ButtonBuilder()
        .setCustomId(`img:count:${n}`)
        .setLabel(`${n}`)
        .setStyle(n === state.count ? ButtonStyle.Primary : ButtonStyle.Secondary)
    )
  );

  // Action row (refs + edit + generate + cancel)
  const actionButtons: ButtonBuilder[] = [];
  if (model.maxReferenceImages > 0) {
    actionButtons.push(
      new ButtonBuilder()
        .setCustomId("img:refs")
        .setLabel(`📎 ${state.references.length}/${model.maxReferenceImages}`)
        .setStyle(ButtonStyle.Secondary)
    );
    if (state.references.length > 0) {
      actionButtons.push(
        new ButtonBuilder()
          .setCustomId("img:clear-refs")
          .setLabel("🗑️")
          .setStyle(ButtonStyle.Secondary)
      );
    }
  }
  actionButtons.push(
    new ButtonBuilder().setCustomId("img:edit").setLabel("✍️ Edit").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("img:generate").setLabel("✨ Generate").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("img:cancel").setLabel("✖️ Cancel").setStyle(ButtonStyle.Danger)
  );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modelSelect),
      aspectRow,
      resolutionRow,
      countRow,
      new ActionRowBuilder<ButtonBuilder>().addComponents(...actionButtons),
    ],
  };
}
