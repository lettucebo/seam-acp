import type { ChildProcessByStdio } from "node:child_process";
import type { Readable as NodeReadable, Writable as NodeWritable } from "node:stream";
import type { ISessionManager } from "./session-manager.js";

/**
 * Describes how to spawn and configure an ACP-compatible coding agent.
 * Adding a new agent (Claude Code, Gemini, etc.) is a matter of writing one
 * of these and adding it to the registry.
 */
export interface AgentProfile {
  /** Stable id used in commands and DB rows ("copilot", "claude-code", …). */
  readonly id: string;

  /** Human-readable name. */
  readonly displayName: string;

  /** Default model id this agent should use unless the session overrides it. */
  readonly defaultModel: string;

  /**
   * Optional static list of models to use for this profile. When provided,
   * these override any models advertised dynamically by the agent via ACP.
   */
  readonly staticModels?: ReadonlyArray<{
    modelId: string;
    name: string;
    /** Context window size in tokens. Used to compute usage percentages when
     *  the agent doesn't surface a `size` via ACP `usage_update`. */
    contextLimit?: number;
  }>;

  /**
   * Optional short abbreviation displayed in thread names when the new-thread
   * wizard renames the thread after setup (e.g. "cp-fhr", "agy").
   */
  readonly threadAbbr?: string;

  /**
   * If true, the agent's host has network restrictions that block Discord
   * (CDN URLs, etc.). When true, attachments are downloaded server-side and
   * written to the agent's filesystem via `sessionManager.writeAttachment`;
   * the LLM gets a local file path in the prompt instead of a Discord URL.
   */
  readonly restrictDiscordAccess?: boolean;

  /**
   * Optional config/data directory used by this profile. Profiles that
   * support multi-account isolation (Claude, Copilot) expose this so other
   * subsystems (e.g. usage fetching) can locate the right credentials file.
   */
  readonly configDir?: string;

  /** Spawn the agent as an ACP server over stdio.
   *  @param modelOverride — when set, the spawned process should use this model
   *  instead of the profile default. Used for non-Anthropic backends where
   *  `setModel()` (ACP config option) is rejected by the adapter.
   *  @param effortOverride — when set, agents that take reasoning effort via a
   *  CLI flag (e.g. Grok `--reasoning-effort`) should apply it at spawn time.
   *  Profiles that apply effort via ACP config options or `_meta` ignore this. */
  spawn(
    modelOverride?: string,
    effortOverride?: string
  ): ChildProcessByStdio<NodeWritable, NodeReadable, NodeReadable>;

  /**
   * How this agent exposes reasoning effort, if at all. Drives both the
   * `/seam effort` picker (which levels to offer, or whether to show it) and
   * the application path in AgentRuntime:
   *   - "meta"        → folded into `session/new` `_meta` via `newSessionMeta`
   *                     (Claude: `_meta.claudeCode.options.effort`).
   *   - "configOption"→ applied after session creation via ACP
   *                     `setSessionConfigOption` (Copilot: `reasoning_effort`).
   *   - "modelBaked"  → effort is part of the model choice; no separate control
   *                     (agy ships high/med/low model variants).
   *   - "none"        → the agent has no reasoning-effort concept.
   * Omit entirely to mean "not settable" (treated like "none").
   */
  readonly effort?: {
    readonly mechanism: "meta" | "configOption" | "modelBaked" | "none";
    /** ACP config option id for mechanism "configOption" (e.g. "reasoning_effort"). */
    readonly configId?: string;
    /** Levels the picker should offer. Empty ⇒ effort is not separately settable. */
    readonly levels: ReadonlyArray<string>;
  };

  /**
   * Optional `_meta` payload to attach to `session/new`. Lets a vendor
   * pass extra hints (compaction threshold, reasoning effort) without
   * polluting the generic API. `effort` is one of low|medium|high|xhigh|max;
   * undefined leaves the model's built-in default in place.
   */
  newSessionMeta?(
    modelId?: string,
    effort?: string
  ): Record<string, unknown> | undefined;

  /**
   * Best-effort identity probe: which account is this profile authenticated
   * as. Read from local CLI config files — no network call. Returns `null`
   * when unknown (CLI never logged in, file missing, parse error, profile
   * doesn't support the concept).
   */
  whoami?(): Promise<AgentIdentity | null>;
  sessionManager?: ISessionManager;
}

/** Identity of the account a profile is authenticated as. */
export interface AgentIdentity {
  /** Username / login (e.g. GitHub login). */
  login: string;
  /** Optional host (e.g. `https://github.com` or a GHE URL). */
  host?: string;
}
