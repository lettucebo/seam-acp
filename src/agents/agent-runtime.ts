import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  RequestError,
  type Client,
  type McpServer,
  type PromptCapabilities,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentProfile } from "./agent-profile.js";
import type { Logger } from "../lib/logger.js";
import type { MessageAttachment } from "../platforms/chat-adapter.js";
import {
  mapAttachmentsToBlocks,
  type RejectedAttachment,
} from "./attachments.js";
import { blockToFile } from "./agent-content.js";
import { SerialQueue } from "../core/serial-queue.js";

/** Events surfaced from the ACP `session/update` stream. */
export type AgentEvent =
  | { kind: "agent-text"; text: string; messageId?: string }
  | { kind: "agent-thought"; text: string }
  | {
      kind: "tool-start";
      toolCallId: string;
      title?: string;
      kindLabel?: string;
    }
  | {
      kind: "tool-update";
      toolCallId: string;
      status?: string;
      title?: string;
    }
  | {
      kind: "agent-file";
      /** "message" if from agent_message_chunk; "tool" if from a tool call. */
      source: "message" | "tool";
      filename: string;
      mimeType: string;
      /** Base64 for binary (image/audio/blob); plain text for text resources. */
      data: string;
      /** True when `data` is base64-encoded binary; false when it's UTF-8 text. */
      base64: boolean;
      /** Optional: the source URI if the agent referenced one. */
      uri?: string;
    }
  | { kind: "mode-changed"; modeId: string }
  | { kind: "model-changed"; modelId: string }
  | { kind: "config-options"; options: unknown }
  | { kind: "agent-state"; state: string }
  | { kind: "error"; message: string }
  | { kind: "usage-update"; used: number; size: number };

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;
export type PermissionPolicy = (
  req: RequestPermissionRequest
) => Promise<RequestPermissionResponse>;

export interface NewSessionOptions {
  cwd: string;
  /** Optional model override (passed via `_meta`; agent applied via `set_model`). */
  model?: string;
  /** Optional reasoning effort (low|medium|high|xhigh|max). Passed via
   *  `newSessionMeta` into `_meta.claudeCode.options.effort`. */
  effort?: string;
  /** Optional operational mode to (re)apply after the session exists, e.g.
   *  "autopilot" / "plan" / "agent" or a full ACP mode id. Resolved against the
   *  agent's advertised `availableModes`. ACP modes reset on every session/new
   *  and subprocess restart, so callers pass their stored preference each time. */
  mode?: string;
  /** Extra ACP `_meta` to merge into `session/new`. */
  meta?: Record<string, unknown>;
}

export interface SessionInfo {
  sessionId: string;
  /** Available models (if the agent advertised them in `session/new`). */
  availableModels: ReadonlyArray<{ modelId: string; name: string }>;
  /** Current model id, if known. */
  currentModelId?: string;
  /** Available modes. */
  availableModes: ReadonlyArray<{ id: string; name: string }>;
  currentModeId?: string;
}

export interface PromptOutcome {
  stopReason: string;
  cancelled: boolean;
  /** Attachments that couldn't be forwarded (e.g. unsupported audio, oversize). */
  rejectedAttachments?: RejectedAttachment[];
}

interface AvailableModel {
  modelId: string;
  name: string;
}

interface AvailableMode {
  id: string;
  name: string;
}

/** ACP select options may be a flat list of options or a list of groups; this
 *  flattens either shape to the leaf options. */
function flattenConfigSelectOptions(
  options: import("@agentclientprotocol/sdk").SessionConfigSelectOptions
): ReadonlyArray<
  import("@agentclientprotocol/sdk").SessionConfigSelectOption
> {
  return (
    options as ReadonlyArray<
      | import("@agentclientprotocol/sdk").SessionConfigSelectOption
      | import("@agentclientprotocol/sdk").SessionConfigSelectGroup
    >
  ).flatMap((o) => ("options" in o ? o.options : [o]));
}

/**
 * Owns one ACP child process and (optionally) one ACP session.
 *
 * Lifecycle:
 *   start() → newSession()/loadSession() → prompt()… → cancel()/dispose()
 *
 * One AgentRuntime per chat thread. The chat layer fans events to the user via
 * a single onEvent handler (set with `onEvent`).
 */
/**
 * How long to wait for ACP `initialize` and `session/new` to complete
 * before treating the agent as wedged. Generous (45s) to allow for
 * slow npm-installed adapters to bootstrap on first run, but bounded
 * enough that a wedge surfaces an actionable error instead of a
 * 15-minute Discord deferred-reply timeout.
 */
const START_TIMEOUT_MS = 45_000;
const NEW_SESSION_TIMEOUT_MS = 45_000;

function withTimeout<T = never>(ms: number, message: string): Promise<T> {
  return new Promise((_resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    if (typeof t.unref === "function") t.unref();
  });
}

export class AgentRuntime {
  private readonly profile: AgentProfile;
  private readonly logger: Logger;
  private readonly permissionPolicy: PermissionPolicy;
  private readonly mcpServers: McpServer[];
  private readonly onDead?: () => void;

  private child?: ReturnType<AgentProfile["spawn"]>;
  private connection?: ClientSideConnection;
  private sessionId?: string;
  private sessionInfo?: SessionInfo;
  /** True while a `session/prompt` is awaiting a response — lets the abort path
   *  tell whether a graceful cancel actually ended the turn before escalating. */
  private promptInFlight = false;
  /** Reject fn for the in-flight `conn.prompt()` promise while a turn runs. Lets
   *  us force that await to settle the instant the child exits or the runtime is
   *  disposed — the SDK does not reliably reject pending RPCs on an abnormal
   *  child exit, which otherwise wedges the turn (and the channel queue) forever. */
  private rejectInFlightPrompt?: (err: Error) => void;
  private promptCapabilities?: PromptCapabilities;
  private sessionCwd?: string;
  /** Model override applied at spawn time for non-Anthropic backends where
   *  `setModel()` (ACP config option) is rejected by the adapter. Set by the
   *  session-router before calling `start()`. */
  modelOverride?: string;
  /** Effort override applied at spawn time for agents that accept reasoning
   *  effort via CLI flags (e.g. Grok `--reasoning-effort`). Set by the
   *  session-router before calling `start()`. */
  effortOverride?: string;

  private eventHandler?: AgentEventHandler;

  /**
   * Serializes session-update processing. The ACP SDK's read loop dispatches
   * notifications concurrently (it calls processMessage without awaiting it),
   * so a later chunk's handler can run while an earlier one is parked on an
   * await and mutate shared state (e.g. the orchestrator's streamed-text
   * buffer) out of order. Funnelling every update through this queue restores
   * strict arrival order end-to-end.
   */
  private readonly sessionUpdates = new SerialQueue();

  constructor(opts: {
    profile: AgentProfile;
    logger: Logger;
    permissionPolicy?: PermissionPolicy;
    mcpServers?: McpServer[];
    /** Called when the agent process exits after a successful initialize. */
    onDead?: () => void;
  }) {
    this.profile = opts.profile;
    this.logger = opts.logger.child({ agent: opts.profile.id });
    this.mcpServers = opts.mcpServers ?? [];
    this.onDead = opts.onDead;
    this.permissionPolicy =
      opts.permissionPolicy ??
      (async (req) => {
        // Default: pick the first "allow_..." option, or the first option.
        const allow =
          req.options.find((o) => o.kind?.startsWith("allow_")) ??
          req.options[0];
        if (!allow) {
          return {
            outcome: { outcome: "cancelled" },
          };
        }
        return {
          outcome: { outcome: "selected", optionId: allow.optionId },
        };
      });
  }

  onEvent(handler: AgentEventHandler): void {
    this.eventHandler = handler;
  }

  /** Start the agent process and complete ACP `initialize`. */
  async start(): Promise<void> {
    if (this.connection) return;
    const child = this.profile.spawn(this.modelOverride, this.effortOverride);
    this.child = child;

    // Capture spawn errors (ENOENT, EACCES, etc.) so they surface as a
    // rejected start() promise instead of letting the ACP handshake hang
    // indefinitely on a stdout that will never produce data.
    // Ring buffer of the agent's recent stderr so an abnormal exit can report
    // WHY it died (agent stderr is otherwise debug-only, dropped at info level).
    // Bounded to the last ~100 lines.
    const stderrRing: string[] = [];

    let spawnError: Error | undefined;
    const errorWaiter = new Promise<never>((_resolve, reject) => {
      child.once("error", (err: NodeJS.ErrnoException) => {
        spawnError = err;
        const hint =
          err.code === "ENOENT"
            ? ` (binary not found on PATH; did you 'npm i -g' the agent's CLI?)`
            : "";
        reject(new Error(`agent spawn failed: ${err.message}${hint}`));
      });
      child.once("exit", (code, signal) => {
        if (!spawnError && this.connection === undefined) {
          // Process died before initialize completed.
          reject(
            new Error(
              `agent process exited before initialize (code=${code}, signal=${signal})`
            )
          );
        }
      });
    });

    child.on("exit", (code, signal) => {
      // 130 = SIGINT, 143 = SIGTERM, etc. Surface the agent's own stderr tail on
      // any abnormal exit so we can tell a self-interrupt/timeout from a crash.
      const abnormal = (code !== 0 && code !== null) || signal != null;
      const stderrTail = stderrRing.slice(-40).join("\n").slice(-4000);
      this.logger.warn(
        { code, signal, ...(abnormal && stderrTail ? { stderrTail } : {}) },
        abnormal ? "agent process exited abnormally" : "agent process exited"
      );
      // Reject any in-flight prompt FIRST so a turn awaiting it unblocks
      // immediately. Without this, an abnormal child exit leaves the
      // orchestrator's `await prompt()` pending forever (the SDK doesn't
      // reliably reject pending RPCs on a hard exit): the runtime gets evicted
      // but the channel queue wedges — card stuck "working", activeTurns never
      // decrements, no new turn starts, and `/seam abort` reports "no active
      // turn" (the runtime is already gone). Previously only a restart cleared it.
      this.rejectInFlightPrompt?.(
        new Error(`agent process exited mid-turn (code=${code}, signal=${signal})`)
      );
      // If initialize already completed, notify the router so it can evict
      // this runtime and attempt session/load on the next incoming message.
      if (this.connection !== undefined) {
        this.onDead?.();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const line = chunk.trimEnd();
      if (line) {
        this.logger.debug({ stderr: line }, "agent stderr");
        stderrRing.push(line);
        if (stderrRing.length > 100) stderrRing.splice(0, stderrRing.length - 100);
      }
    });

    const writable = Writable.toWeb(
      child.stdin
    ) as unknown as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(
      child.stdout
    ) as unknown as ReadableStream<Uint8Array>;

    const stream = ndJsonStream(writable, readable);

    const client = this.makeClient();
    this.connection = new ClientSideConnection(() => client, stream);

    const initResult = await Promise.race([
      this.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
      }),
      errorWaiter,
      withTimeout(
        START_TIMEOUT_MS,
        `ACP initialize timed out after ${START_TIMEOUT_MS / 1000}s ` +
          `(agent never responded; check that '${this.profile.id}' is installed and authenticated)`
      ),
    ]);
    this.promptCapabilities =
      initResult.agentCapabilities?.promptCapabilities ?? undefined;
    this.logger.debug(
      { promptCapabilities: this.promptCapabilities },
      "acp initialized"
    );
  }

  /** Capabilities advertised by the agent during `initialize`. */
  getPromptCapabilities(): PromptCapabilities | undefined {
    return this.promptCapabilities;
  }

  /** Create a new ACP session in `cwd`. */
  async newSession(opts: NewSessionOptions): Promise<SessionInfo> {
    const conn = this.requireConnection();
    const meta: Record<string, unknown> = {
      ...(this.profile.newSessionMeta?.(opts.model, opts.effort) ?? {}),
      ...(opts.meta ?? {}),
    };

    const result = await Promise.race([
      conn.newSession({
        cwd: opts.cwd,
        mcpServers: this.mcpServers,
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
      }),
      withTimeout<never>(
        NEW_SESSION_TIMEOUT_MS,
        `ACP session/new timed out after ${NEW_SESSION_TIMEOUT_MS / 1000}s ` +
          `(agent '${this.profile.id}' did not create a session — check auth and cwd)`
      ),
    ]);

    this.sessionCwd = opts.cwd;
    this.sessionId = result.sessionId;
    this.sessionInfo = this.buildSessionInfo(result);

    // Apply model override after session creation if requested and supported.
    const wantedModel = opts.model ?? this.profile.defaultModel;
    // Do NOT require `currentModelId` here: opencode's session/new (and loadSession)
    // returns no `models`, so currentModelId is undefined — gating on it skipped
    // set_model entirely and left opencode on its built-in default (`big-pickle`,
    // no vision). `wantedModel !== undefined` is true, so we (re)apply; if it
    // already matches the reported current model we still skip the redundant call.
    if (wantedModel && wantedModel !== this.sessionInfo.currentModelId) {
      const isExplicit = opts.model !== undefined;
      const isAvailable = this.sessionInfo.availableModels.some((m) => m.modelId === wantedModel);
      if (isExplicit || isAvailable) {
        try {
          await this.setModel(wantedModel);
          this.sessionInfo = { ...this.sessionInfo, currentModelId: wantedModel };
        } catch (err) {
          this.logger.warn({ err, wantedModel }, "failed to set initial model");
        }
      }
    }

    // Apply reasoning effort for agents that take it as a config option (Copilot).
    await this.applyConfigOptionEffort(opts.effort);

    // Apply persisted operational mode (e.g. autopilot). ACP session modes are
    // not carried by session/new, so re-apply the stored choice every time.
    await this.applyMode(opts.mode);

    return this.sessionInfo;
  }

  /** Resume an existing ACP session. */
  async loadSession(opts: {
    sessionId: string;
    cwd: string;
    model?: string;
    effort?: string;
    mode?: string;
  }): Promise<SessionInfo> {
    const conn = this.requireConnection();
    const meta: Record<string, unknown> = {
      ...(this.profile.newSessionMeta?.(opts.model, opts.effort) ?? {}),
    };
    const result = await conn.loadSession({
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      mcpServers: this.mcpServers,
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    });
    this.sessionCwd = opts.cwd;
    this.sessionId = opts.sessionId;
    this.sessionInfo = {
      sessionId: opts.sessionId,
      availableModels: this.toAvailableModels(result.configOptions),
      currentModelId: this.toCurrentModelId(result.configOptions),
      availableModes: this.toAvailableModes(result.modes),
      currentModeId: this.toCurrentModeId(result.modes),
    };

    // Re-apply model preference on resume — Claude Code sessions don't persist
    // the model choice across subprocess restarts, so it would otherwise revert
    // to whatever is in settings.json (typically the default model, not the
    // per-session override the user selected).
    const wantedModel = opts.model ?? this.profile.defaultModel;
    // Do NOT require `currentModelId` here: opencode's session/new (and loadSession)
    // returns no `models`, so currentModelId is undefined — gating on it skipped
    // set_model entirely and left opencode on its built-in default (`big-pickle`,
    // no vision). `wantedModel !== undefined` is true, so we (re)apply; if it
    // already matches the reported current model we still skip the redundant call.
    if (wantedModel && wantedModel !== this.sessionInfo.currentModelId) {
      const isExplicit = opts.model !== undefined;
      const isAvailable = this.sessionInfo.availableModels.some((m) => m.modelId === wantedModel);
      if (isExplicit || isAvailable) {
        try {
          await this.setModel(wantedModel);
          this.sessionInfo = { ...this.sessionInfo, currentModelId: wantedModel };
        } catch (err) {
          this.logger.warn({ err, wantedModel }, "failed to re-apply model on session load");
        }
      }
    }

    // Re-apply reasoning effort on resume (config options don't persist across
    // a subprocess restart any more than the model does).
    await this.applyConfigOptionEffort(opts.effort);

    // Re-apply persisted operational mode on resume — ACP modes reset to the
    // agent default across a subprocess restart just like the model does.
    await this.applyMode(opts.mode);

    return this.sessionInfo;
  }

  getSessionInfo(): SessionInfo | undefined {
    return this.sessionInfo;
  }

  async prompt(
    text: string,
    attachments?: ReadonlyArray<MessageAttachment>
  ): Promise<PromptOutcome> {
    const conn = this.requireConnection();
    const sid = this.requireSessionId();

    const prompt: Array<import("@agentclientprotocol/sdk").ContentBlock> = [];
    if (text) prompt.push({ type: "text", text });

    let rejected: RejectedAttachment[] | undefined;
    if (attachments && attachments.length > 0) {
      const mapped = await mapAttachmentsToBlocks(attachments, {
        capabilities: this.promptCapabilities,
        logger: this.logger,
      });
      prompt.push(...mapped.blocks);
      if (mapped.rejected.length > 0) rejected = mapped.rejected;
    }

    if (prompt.length === 0) {
      // Caller passed empty text and no usable attachments.
      return {
        stopReason: "end_turn",
        cancelled: false,
        ...(rejected ? { rejectedAttachments: rejected } : {}),
      };
    }

    this.promptInFlight = true;
    try {
      // Race the ACP prompt RPC against a death/dispose rejection. Storing the
      // reject lets the child-exit handler (and dispose) force this await to
      // settle instead of hanging when the connection dies without a clean
      // close. On normal completion the RPC resolves first.
      const res = await new Promise<{ stopReason: string }>((resolve, reject) => {
        this.rejectInFlightPrompt = reject;
        conn.prompt({ sessionId: sid, prompt }).then(resolve, reject);
      });
      return {
        stopReason: res.stopReason,
        cancelled: res.stopReason === "cancelled",
        ...(rejected ? { rejectedAttachments: rejected } : {}),
      };
    } finally {
      this.promptInFlight = false;
      this.rejectInFlightPrompt = undefined;
    }
  }

  /** Whether a prompt is currently in flight (turn running). */
  get busy(): boolean {
    return this.promptInFlight;
  }

  /** Wait for all asynchronous session updates to be processed. */
  async idle(): Promise<void> {
    await this.sessionUpdates.idle();
  }

  async setModel(modelId: string): Promise<void> {
    // ACP 1.x: model selection is a session config option (configId "model");
    // the old `unstable_setSessionModel` RPC is gone. Full canonical IDs
    // exact-match the agent's advertised option values and bypass the fuzzy
    // resolver; aliases (e.g. "default") fall through to it agent-side.
    await this.setConfigOption("model", modelId);
    if (this.sessionInfo) {
      this.sessionInfo = { ...this.sessionInfo, currentModelId: modelId };
    }
  }

  async setMode(modeId: string): Promise<void> {
    const conn = this.requireConnection();
    const sid = this.requireSessionId();
    await conn.setSessionMode({ sessionId: sid, modeId });
    if (this.sessionInfo) {
      this.sessionInfo = { ...this.sessionInfo, currentModeId: modeId };
    }
  }

  async setConfigOption(
    configId: string,
    value: string | boolean
  ): Promise<void> {
    const conn = this.requireConnection();
    const sid = this.requireSessionId();
    if (typeof value === "boolean") {
      await conn.setSessionConfigOption({
        sessionId: sid,
        configId,
        type: "boolean",
        value,
      });
    } else {
      await conn.setSessionConfigOption({
        sessionId: sid,
        configId,
        value,
      });
    }
  }

  /** Apply reasoning effort for agents that take it as an ACP config option
   *  (e.g. Copilot's "reasoning_effort"). Claude folds effort into `_meta` via
   *  newSessionMeta instead; modelBaked/none agents have nothing to set. Must
   *  run after the session exists — config options require a live session. */
  private async applyConfigOptionEffort(effort?: string): Promise<void> {
    const eff = this.profile.effort;
    if (!eff || eff.mechanism !== "configOption" || !eff.configId) return;
    if (!effort || effort === "default" || !eff.levels.includes(effort)) return;
    try {
      await this.setConfigOption(eff.configId, effort);
    } catch (err) {
      this.logger.warn(
        { err, effort, configId: eff.configId },
        "failed to apply reasoning-effort config option"
      );
    }
  }

  /** Resolve a user-supplied mode string — a full ACP mode id, a mode name, or
   *  a short suffix like "autopilot" — to an advertised mode id for the current
   *  session, or undefined when the agent advertises no matching mode. */
  resolveModeId(input: string): string | undefined {
    const modes = this.sessionInfo?.availableModes ?? [];
    const lower = input.trim().toLowerCase();
    return (
      modes.find((m) => m.id === input)?.id ??
      modes.find((m) => m.id.toLowerCase() === lower)?.id ??
      modes.find((m) => m.id.toLowerCase().endsWith("#" + lower))?.id ??
      modes.find((m) => m.name.toLowerCase() === lower)?.id
    );
  }

  /** (Re)apply an operational mode to the live session. Resolves friendly names
   *  to advertised ids, skips when already current, and returns the applied id
   *  (or undefined when it couldn't be resolved/applied). ACP session modes do
   *  not persist across session/new or a subprocess restart, so this runs on
   *  every new/load using the caller's stored preference. */
  async applyMode(input?: string): Promise<string | undefined> {
    if (!input) return undefined;
    const resolved = this.resolveModeId(input);
    if (!resolved) {
      this.logger.warn(
        { input, availableModes: this.sessionInfo?.availableModes },
        "requested mode not advertised by agent; leaving current mode"
      );
      return undefined;
    }
    if (this.sessionInfo?.currentModeId === resolved) return resolved;
    try {
      await this.setMode(resolved);
      return resolved;
    } catch (err) {
      this.logger.warn({ err, input, resolved }, "failed to apply mode");
      return undefined;
    }
  }

  async cancel(): Promise<void> {
    if (!this.connection || !this.sessionId) return;
    try {
      await this.connection.cancel({ sessionId: this.sessionId });
    } catch (err) {
      this.logger.warn({ err }, "cancel failed");
    }
  }

  async dispose(): Promise<void> {
    if (this.sessionId) {
      try {
        await Promise.race([
          this.cancel(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("cancel timeout")), 2000))
        ]);
      } catch (err) {
        this.logger.warn({ err }, "cancel during dispose timed out or failed");
      }
    }
    const child = this.child;
    if (child && !child.killed) {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      const exitPromise = new Promise((resolve) => {
        child.once("exit", resolve);
        child.once("error", resolve);
      });

      if (child.pid && (child as any).detached) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          try {
            child.kill("SIGTERM");
          } catch {
            /* ignore */
          }
        }
      } else {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }

      // Wait up to 3 seconds for graceful exit
      await Promise.race([
        exitPromise,
        new Promise((resolve) => setTimeout(resolve, 3000))
      ]);

      // Force kill if still alive
      if (child.exitCode === null && child.signalCode === null) {
        if (child.pid && (child as any).detached) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch { /* ignore */ }
        } else {
          try {
            child.kill("SIGKILL");
          } catch { /* ignore */ }
        }
      }
    }
    this.connection = undefined;
    this.sessionId = undefined;
    this.sessionInfo = undefined;
    this.child = undefined;
  }

  // --- internals ---

  private requireConnection(): ClientSideConnection {
    if (!this.connection) throw new Error("AgentRuntime not started");
    return this.connection;
  }

  private requireSessionId(): string {
    if (!this.sessionId) throw new Error("No active session");
    return this.sessionId;
  }

  private async emit(event: AgentEvent): Promise<void> {
    if (!this.eventHandler) return;
    try {
      await this.eventHandler(event);
    } catch (err) {
      this.logger.error({ err, event }, "event handler failed");
    }
  }

  private makeClient(): Client {
    const runtime = this;
    return {
      async requestPermission(
        params: RequestPermissionRequest
      ): Promise<RequestPermissionResponse> {
        return runtime.permissionPolicy(params);
      },

      async sessionUpdate(params: SessionNotification): Promise<void> {
        await runtime.handleSessionUpdate(params.update);
      },
    };
  }

  private handleSessionUpdate(update: SessionUpdate): Promise<void> {
    // Process updates one at a time, in arrival order. See `sessionUpdates`.
    return this.sessionUpdates.run(() => this.handleSessionUpdateInner(update));
  }

  private async handleSessionUpdateInner(update: SessionUpdate): Promise<void> {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        await this.handleContentBlock(update.content, "message", {
          messageId: update.messageId ?? undefined,
        });
        return;
      }
      case "agent_thought_chunk": {
        const text = textFromContent(update.content);
        if (text) await this.emit({ kind: "agent-thought", text });
        return;
      }
      case "tool_call": {
        await this.emit({
          kind: "tool-start",
          toolCallId: update.toolCallId,
          title: update.title,
          kindLabel: update.kind,
        });
        if (Array.isArray(update.content)) {
          for (const tc of update.content) await this.handleToolCallContent(tc);
        }
        return;
      }
      case "tool_call_update": {
        await this.emit({
          kind: "tool-update",
          toolCallId: update.toolCallId,
          status: update.status ?? undefined,
          title: update.title ?? undefined,
        });
        if (Array.isArray(update.content)) {
          for (const tc of update.content) await this.handleToolCallContent(tc);
        }
        return;
      }
      case "current_mode_update": {
        await this.emit({ kind: "mode-changed", modeId: update.currentModeId });
        return;
      }
      case "config_option_update": {
        // Track current model if present in the new options.
        const opts = (update as unknown as { configOptions?: unknown })
          .configOptions;
        const currentModel = extractCurrentModel(opts);
        if (currentModel && this.sessionInfo) {
          this.sessionInfo = {
            ...this.sessionInfo,
            currentModelId: currentModel,
          };
          await this.emit({ kind: "model-changed", modelId: currentModel });
        }
        await this.emit({ kind: "config-options", options: opts });
        return;
      }
      case "usage_update": {
        const u = update as unknown as { used?: number; size?: number };
        if (typeof u.used === "number" && typeof u.size === "number" && u.size > 0) {
          await this.emit({ kind: "usage-update", used: u.used, size: u.size });
        }
        return;
      }
      default:
        // user_message_chunk, plan, available_commands_update,
        // session_info_update — currently ignored.
        return;
    }
  }

  /**
   * Inspect a single ContentBlock from an `agent_message_chunk` and emit the
   * right downstream event (text or file). Logs every non-text block at debug
   * level so we can observe what real agents actually send.
   */
  private async handleContentBlock(
    content: unknown,
    source: "message" | "tool",
    extra: { messageId?: string } = {}
  ): Promise<void> {
    if (!content || typeof content !== "object") return;
    const block = content as { type?: string };

    if (block.type === "text") {
      const text = (block as { text?: string }).text;
      if (typeof text === "string" && text.length > 0) {
        if (text === "Compacting...") {
          await this.emit({ kind: "agent-state", state: "Compacting memory…" });
          return;
        }
        if (source === "tool") {
          // Tool stdout/stderr (curl progress, file dumps, exit codes) is
          // NOT a model reply — never post it to chat, and don't scan it
          // for file paths either: that would upload every doc the agent
          // reads. Files the agent *produces* are caught by scanning the
          // assistant's message text below.
          return;
        }
        await this.emit({
          kind: "agent-text",
          text,
          ...(extra.messageId ? { messageId: extra.messageId } : {}),
        });
      }
      return;
    }

    this.logger.info(
      { source, blockType: block.type },
      "non-text content block from agent"
    );

    const file = blockToFile(block);
    if (file) {
      await this.emit({ kind: "agent-file", source, ...file });
      return;
    }

    if (block.type === "resource_link") {
      // Surface as inline text so users see it in the chat. Easier than
      // building a separate UI for it.
      const link = block as {
        name?: string;
        uri?: string;
        mimeType?: string | null;
      };
      const label = link.name ?? link.uri ?? "resource";
      await this.emit({
        kind: "agent-text",
        text: `🔗 [${label}](${link.uri ?? ""})`,
        ...(extra.messageId ? { messageId: extra.messageId } : {}),
      });
    }
  }

  /** Inspect a ToolCallContent entry; only the "content" variant interests us. */
  private async handleToolCallContent(tc: unknown): Promise<void> {
    if (!tc || typeof tc !== "object") return;
    const t = tc as { type?: string; content?: unknown };
    // Trace what shape arrives from each tool — invaluable for figuring out
    // why an MCP server's image / file output isn't surfacing as an upload.
    const inner = (t.content as { type?: string } | undefined)?.type;
    this.logger.debug(
      { tcType: t.type, contentType: inner },
      "tool_call content entry"
    );
    if (t.type !== "content") {
      // diff / terminal — handled elsewhere or ignored for now.
      return;
    }
    await this.handleContentBlock(t.content, "tool");
  }

  private buildSessionInfo(
    result: import("@agentclientprotocol/sdk").NewSessionResponse
  ): SessionInfo {
    return {
      sessionId: result.sessionId,
      availableModels: this.toAvailableModels(result.configOptions),
      currentModelId: this.toCurrentModelId(result.configOptions),
      availableModes: this.toAvailableModes(result.modes),
      currentModeId: this.toCurrentModeId(result.modes),
    };
  }

  /** Locate the model selector among the agent's session config options
   *  (ACP 1.x: models moved from a dedicated `models` field into
   *  `configOptions` with category/id "model"). */
  private findModelOption(
    configOptions:
      | ReadonlyArray<import("@agentclientprotocol/sdk").SessionConfigOption>
      | null
      | undefined
  ): import("@agentclientprotocol/sdk").SessionConfigOption | undefined {
    if (!configOptions) return undefined;
    return configOptions.find((o) => o.category === "model" || o.id === "model");
  }

  private toAvailableModels(
    configOptions:
      | ReadonlyArray<import("@agentclientprotocol/sdk").SessionConfigOption>
      | null
      | undefined
  ): ReadonlyArray<AvailableModel> {
    // Profile-declared static models win: they carry the picker labels and
    // contextLimit the agent doesn't advertise (Claude/Copilot pickers,
    // opencode discovery).
    if (this.profile.staticModels && this.profile.staticModels.length > 0) {
      return this.profile.staticModels;
    }
    const opt = this.findModelOption(configOptions);
    if (!opt || opt.type !== "select") return [];
    return flattenConfigSelectOptions(opt.options).map((o) => ({
      modelId: o.value,
      name: o.name,
    }));
  }

  private toCurrentModelId(
    configOptions:
      | ReadonlyArray<import("@agentclientprotocol/sdk").SessionConfigOption>
      | null
      | undefined
  ): string | undefined {
    const opt = this.findModelOption(configOptions);
    if (!opt || opt.type !== "select") return undefined;
    return typeof opt.currentValue === "string" ? opt.currentValue : undefined;
  }

  private toAvailableModes(
    modes: import("@agentclientprotocol/sdk").NewSessionResponse["modes"]
  ): ReadonlyArray<AvailableMode> {
    if (!modes) return [];
    const list = (modes as { availableModes?: Array<AvailableMode> })
      .availableModes;
    return Array.isArray(list) ? list : [];
  }

  private toCurrentModeId(
    modes: import("@agentclientprotocol/sdk").NewSessionResponse["modes"]
  ): string | undefined {
    if (!modes) return undefined;
    return (modes as { currentModeId?: string }).currentModeId;
  }
}

function textFromContent(content: unknown): string | undefined {
  if (!content || typeof content !== "object") return undefined;
  const c = content as { type?: string; text?: string };
  if (c.type === "text" && typeof c.text === "string") return c.text;
  return undefined;
}

function extractCurrentModel(options: unknown): string | undefined {
  if (!Array.isArray(options)) return undefined;
  const modelOpt = options.find(
    (o): o is { id?: string; currentValue?: string } =>
      typeof o === "object" &&
      o !== null &&
      (o as { id?: string }).id === "model"
  );
  return modelOpt?.currentValue;
}

export { RequestError };
