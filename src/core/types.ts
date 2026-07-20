/** Per-session permission policy. */
export type PermissionPolicyMode = "always" | "ask" | "deny";

/**
 * Per-session, agent-specific settings. Stored as JSON in `sessions.config_json`.
 * Mostly mirrors the C# `SessionConfigState`, generalized for multi-agent use.
 */
export interface SessionConfigState {
  /** ACP model id (e.g. "gpt-5.4", "claude-sonnet-4.5", "auto"). */
  model?: string;
  /** ACP mode id (e.g. agent / plan / autopilot URI). */
  mode?: string;
  /** Reasoning effort for models that support it ("low" | "medium" | "high"). */
  reasoningEffort?: string;
  /** Allowlist of tool names; empty = all allowed. */
  availableTools?: string[];
  /** Blocklist of tool names. */
  excludedTools?: string[];
  /** Vendor-specific MCP server configuration (passed via ACP `_meta`). */
  mcpServers?: unknown;
  /**
   * Per-session permission policy.
   * - "always": auto-approve every request (yolo)
   * - "ask":    prompt the user in Discord; deny on timeout
   * - "deny":   auto-deny every request
   */
  permissionPolicy?: PermissionPolicyMode;
  /**
   * @deprecated Use `permissionPolicy` instead. Kept for read-time backward
   * compatibility: legacy `true` → "always", legacy `false`/missing → fall
   * back to the bot-wide default policy.
   */
  autoApprovePermissions?: boolean;
  /**
   * Last-known context-window usage at end of the previous turn. Used to
   * seed the status panel at turn start so the user sees continuity. Cleared
   * on model change. May go stale after out-of-band session edits — corrected
   * by the post-turn side-channel `getUsage` read in normal operation.
   */
  lastContextUsage?: {
    used: number;
    size: number;
    /** The model id this measurement was taken under. Used to invalidate
     *  on model change without needing a separate field. */
    model: string;
    atUtc: string;
  };
}

export function defaultSessionConfig(
  defaultModel: string,
  defaultPolicy: PermissionPolicyMode = "ask"
): SessionConfigState {
  return { model: defaultModel, permissionPolicy: defaultPolicy };
}

/**
 * Resolve the effective permission mode for a session, honoring (in order):
 *   1. The new `permissionPolicy` field
 *   2. The legacy `autoApprovePermissions` field — but only when it is `true`
 *      (`false` / missing both fall through so the new safer default wins)
 *   3. The bot-wide default
 */
export function resolvePermissionMode(
  cfg: SessionConfigState,
  defaultMode: PermissionPolicyMode
): PermissionPolicyMode {
  if (cfg.permissionPolicy) return cfg.permissionPolicy;
  if (cfg.autoApprovePermissions === true) return "always";
  return defaultMode;
}

/**
 * Persisted record for one chat session (one Discord thread, one Slack thread, etc.).
 * Multi-platform / multi-agent ready: keyed by composite (`platform`, `channel_ref`).
 */
export interface SessionRecord {
  /** Composite primary key: `${platform}:${channel_ref}`. */
  id: string;
  platform: string;
  channelRef: string;
  parentRef: string | null;
  agentId: string;
  acpSessionId: string;
  repoPath: string | null;
  configJson: string;
  createdUtc: string;
  updatedUtc: string;
}

/** Status panel state shown to the user during a turn. */
export type TurnState =
  | "Working"
  | "Done"
  | "Failed"
  | "Timed out"
  | "Waiting"
  // Turn ended but the agent left background/monitor work running that may
  // resume on its own (Claude Monitor tool / run_in_background tasks).
  | "Monitoring";

export interface StatusPanel {
  state: TurnState;
  repoDisplay: string;
  model: string;
  /** Current operational mode label (e.g. "Plan" / "Agent" / "Autopilot"). */
  mode?: string;
  /** Resolved API model id (e.g. "claude-opus-4-8[1m]"), if different from model alias. */
  resolvedModel?: string;
  /** Reasoning effort for this turn, if set (low|medium|high|xhigh|max). */
  effort?: string;
  action: string;
  elapsedSeconds: number;
  /** Optional context-window line shown when token info is known. */
  context?: string;
  /** Recent tool / progress activity (oldest → newest). */
  activity?: string[];
  /** Last few lines of model reasoning (oldest → newest). */
  thinking?: string[];
}

/** Result of one agent turn (reply round-trip). */
export interface TurnOutcome {
  success: boolean;
  timedOut: boolean;
  errorMessage?: string;
}

/**
 * Platform-agnostic rich status card. The renderer produces this structure and
 * the adapter converts it to the platform's native rich format (Discord embed,
 * Slack block-kit, etc.). A text-serialization fallback is provided for
 * adapters that only support plain text.
 */
export interface StructuredPanel {
  /** Sidebar / accent color as a hex number (e.g. 0x57F287 for green). */
  color: number;
  /** Main title line (e.g. "⏳ Working"). */
  title: string;
  /** Optional author line (e.g. agent display name). */
  author?: string;
  /** Optional body text rendered as markdown (activity log, thinking, etc.). */
  description?: string;
  /** Key/value fields for the embed grid. */
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  /** Footer text (e.g. "⏱ 12s elapsed"). */
  footer?: string;
}
