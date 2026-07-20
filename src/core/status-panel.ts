import type { Renderer } from "../platforms/renderer.js";
import type { TurnState, StatusPanel, StructuredPanel } from "./types.js";

/**
 * Renders the single editable status panel that the bot keeps for each
 * in-flight turn. State and helpers are pure; no I/O happens here — the
 * caller decides when to send/edit on the chat platform.
 */
export interface StatusPanelInput {
  state: TurnState;
  startedUtc: number;
  repoDisplay: string;
  model: string;
  /** Current operational mode label (e.g. "Plan" / "Agent" / "Autopilot"). */
  mode?: string;
  /** Resolved API model id (e.g. "claude-opus-4-8[1m]"), if different from model alias. */
  resolvedModel?: string;
  /** Reasoning effort for this turn, if set. */
  effort?: string;
  action: string;
  /** Optional context-window line shown when tokens are known. */
  context?: string;
  /** Recent activity (oldest → newest). */
  activity?: string[];
  /** Last few lines of model reasoning (oldest → newest). */
  thinking?: string[];
}

export function renderStatusPanel(
  renderer: Renderer,
  input: StatusPanelInput,
  nowUtc: number
): StructuredPanel {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((nowUtc - input.startedUtc) / 1000)
  );
  const panel: StatusPanel = {
    state: input.state,
    elapsedSeconds,
    repoDisplay: input.repoDisplay,
    model: input.model,
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.resolvedModel ? { resolvedModel: input.resolvedModel } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    action: input.action,
    context: input.context,
    activity: input.activity,
    thinking: input.thinking,
  };
  return renderer.statusPanel(panel);
}

/**
 * Mutable status state for an in-flight turn. The Discord adapter wraps this
 * with a debounced editor so we never edit a message more often than once a
 * second (matching the C# bot's behavior).
 */
export class TurnStatus {
  state: TurnState = "Working";
  action = "Starting…";
  model: string;
  /** Current operational mode label (e.g. "Plan" / "Agent" / "Autopilot"). */
  mode?: string;
  /** Resolved API model id returned by getUsage (e.g. "claude-opus-4-8[1m]").
   *  Set after the turn completes; cleared on each new TurnStatus instance. */
  resolvedModel?: string;
  /** Reasoning effort for this turn (low|medium|high|xhigh|max), or undefined
   *  when unset (the model's built-in default applies). */
  effort?: string;
  repoDisplay: string;
  startedUtc: number;
  context?: string;
  /** Monotonic ceiling on context-window `used` for this turn. Some agents
   *  emit a falling reading mid-turn (e.g. a fresh API call that excludes
   *  cached tokens, or post-compaction); we want the panel to show the
   *  highest watermark seen so it doesn't visibly drop. Reset per turn. */
  contextUsedHighWater = 0;
  /** Last-known context-window size for the active model, learned from
   *  usage-update events. Auto-compact uses this to size the summary prompt
   *  so it fits comfortably in the same window. 0 = unknown. */
  contextWindowSize = 0;
  /** Rolling activity log (oldest → newest). Capped to last N entries. */
  activity: string[] = [];
  private static readonly MAX_ACTIVITY = 20;
  /** Last N complete lines of model reasoning (oldest → newest). */
  private thinkingLines: string[] = [];
  /** Incoming thought chunks may end mid-line — buffer until we see a \n. */
  private thinkingPending = "";
  private static readonly MAX_THINKING = 5;

  constructor(opts: { model: string; repoDisplay: string; effort?: string; mode?: string }) {
    this.model = opts.model;
    this.repoDisplay = opts.repoDisplay;
    if (opts.effort) this.effort = opts.effort;
    if (opts.mode) this.mode = opts.mode;
    this.startedUtc = Date.now();
  }

  setState(state: TurnState): void {
    this.state = state;
  }

  setAction(action: string): void {
    this.action = action;
  }

  setModel(model: string): void {
    this.model = model;
  }

  setMode(mode: string | undefined): void {
    this.mode = mode;
  }

  setRepo(repoDisplay: string): void {
    this.repoDisplay = repoDisplay;
  }

  /** Append a recent-activity line; dedupes consecutive duplicates. */
  pushActivity(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    const last = this.activity[this.activity.length - 1];
    if (last === trimmed) return;
    this.activity.push(trimmed);
    if (this.activity.length > TurnStatus.MAX_ACTIVITY) {
      this.activity.splice(0, this.activity.length - TurnStatus.MAX_ACTIVITY);
    }
  }

  private isSystemInstruction(text: string): boolean {
    const lower = text.toLowerCase();
    return (
      lower.includes("tool specificity") ||
      lower.includes("critical instruction") ||
      lower.includes("avoid cat for file creation") ||
      lower.includes("grepsearch") ||
      lower.includes("refining tool usage") ||
      lower.includes("refining my approach") ||
      lower.includes("specific tool usage") ||
      lower.includes("in tool selection") ||
      lower.includes("precise tool utilization") ||
      lower.includes("focused on adhering") ||
      lower.includes("more specific tool selections") ||
      lower.includes("explicit tool listings")
    );
  }

  /**
   * Append a streamed thought chunk. Thoughts arrive as deltas that may end
   * mid-line; we buffer until we hit a newline, then promote complete lines
   * to a rolling window of the last N. The in-progress tail is shown at the
   * bottom of the window via {@link thinkingWindow} so streaming feels live.
   */
  pushThinkingChunk(text: string): void {
    if (!text) return;
    this.thinkingPending += text;
    const lastNl = this.thinkingPending.lastIndexOf("\n");
    if (lastNl === -1) return;
    const complete = this.thinkingPending.slice(0, lastNl);
    this.thinkingPending = this.thinkingPending.slice(lastNl + 1);
    for (const raw of complete.split("\n")) {
      const t = raw.trim();
      if (!t || this.isSystemInstruction(t)) continue;
      this.thinkingLines.push(t);
      if (this.thinkingLines.length > TurnStatus.MAX_THINKING) {
        this.thinkingLines.shift();
      }
    }
  }

  /** Rolling window of the last N thought lines plus the in-flight tail. */
  thinkingWindow(): string[] | undefined {
    const pending = this.thinkingPending.trim();
    const showPending = pending && !this.isSystemInstruction(pending);
    if (this.thinkingLines.length === 0 && !showPending) return undefined;
    const lines = showPending ? [...this.thinkingLines, pending] : [...this.thinkingLines];
    return lines.length > 0 ? lines.slice(-TurnStatus.MAX_THINKING) : undefined;
  }

  toInput(): StatusPanelInput {
    const thinking = this.thinkingWindow();
    return {
      state: this.state,
      startedUtc: this.startedUtc,
      repoDisplay: this.repoDisplay,
      model: this.model,
      ...(this.mode ? { mode: this.mode } : {}),
      ...(this.resolvedModel ? { resolvedModel: this.resolvedModel } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      action: this.action,
      context: this.context,
      activity: this.activity.length ? [...this.activity] : undefined,
      ...(thinking ? { thinking } : {}),
    };
  }
}
