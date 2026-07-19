import { AgentRuntime } from "../agents/agent-runtime.js";
import type { AgentProfile } from "../agents/agent-profile.js";
import type { Logger } from "../lib/logger.js";
import type { SessionStore } from "./session-store.js";
import type { SessionRecord, PermissionPolicyMode } from "./types.js";
import { defaultSessionConfig, resolvePermissionMode } from "./types.js";
import { makeSessionId } from "./session-store.js";
import type {
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

export type AskUserFn = (
  record: SessionRecord,
  req: RequestPermissionRequest
) => Promise<RequestPermissionResponse>;

/**
 * Holds one AgentRuntime per chat session id, with:
 *  - a per-session creation lock so two concurrent messages don't both spawn
 *    new agents
 *  - a 30-second cooldown after a failed start so we don't hammer a broken
 *    agent
 *
 * This is a port of the runtime-management bits of SessionRuntimeManager.cs.
 */
export class SessionRouter {
  private readonly logger: Logger;
  private readonly store: SessionStore;
  private readonly profileById: Map<string, AgentProfile>;
  private readonly defaultAgentId: string;
  private readonly defaultModel: string;
  private readonly defaultPermissionMode: PermissionPolicyMode;
  private readonly mcpServers: McpServer[];
  private askUser?: AskUserFn;

  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly creationLocks = new Map<string, Promise<AgentRuntime>>();
  private readonly lastStartFailure = new Map<string, number>();
  private readonly startFailureCooldownMs = 30_000;

  constructor(opts: {
    logger: Logger;
    store: SessionStore;
    profiles: AgentProfile[];
    defaultAgentId: string;
    defaultModel: string;
    defaultPermissionMode?: PermissionPolicyMode;
    mcpServers?: McpServer[];
  }) {
    this.logger = opts.logger.child({ comp: "session-router" });
    this.store = opts.store;
    this.profileById = new Map(opts.profiles.map((p) => [p.id, p]));
    this.defaultAgentId = opts.defaultAgentId;
    this.defaultModel = opts.defaultModel;
    this.defaultPermissionMode = opts.defaultPermissionMode ?? "ask";
    this.mcpServers = opts.mcpServers ?? [];
  }

  /**
   * Provide the callback that prompts a real user for an approval decision.
   * Used only when a session's permission policy is "ask". If unset, "ask"
   * behaves like "deny".
   */
  setAskUser(fn: AskUserFn): void {
    this.askUser = fn;
  }

  /** List the registered agent profiles. */
  listProfiles(): AgentProfile[] {
    return [...this.profileById.values()];
  }

  /** Look up a registered profile by id, or undefined if not found. */
  getProfile(id: string): AgentProfile | undefined {
    return this.profileById.get(id);
  }

  /** Look up or create the SessionRecord for a given chat channel. */
  ensureSessionRecord(opts: {
    platform: string;
    channelRef: string;
    parentRef?: string;
    cwd: string;
  }): SessionRecord {
    const id = makeSessionId(opts.platform, opts.channelRef);
    const existing = this.store.get(id);
    if (existing) return existing;

    const cfg = defaultSessionConfig(this.defaultModel, this.defaultPermissionMode);
    const now = new Date().toISOString();
    // We don't yet know the ACP session id — it will be filled in by the
    // first runtime start. Store an empty marker for now.
    const record: SessionRecord = {
      id,
      platform: opts.platform,
      channelRef: opts.channelRef,
      parentRef: opts.parentRef ?? null,
      agentId: this.defaultAgentId,
      acpSessionId: "",
      repoPath: opts.cwd,
      configJson: JSON.stringify(cfg),
      createdUtc: now,
      updatedUtc: now,
    };
    this.store.upsert(record);
    return record;
  }

  /**
   * Get (or start) the runtime for a session. Honors the per-session creation
   * lock and the post-failure cooldown.
   */
  async getOrStartRuntime(record: SessionRecord): Promise<AgentRuntime> {
    const cached = this.runtimes.get(record.id);
    if (cached) return cached;

    const inflight = this.creationLocks.get(record.id);
    if (inflight) return inflight;

    const lastFail = this.lastStartFailure.get(record.id);
    if (lastFail && Date.now() - lastFail < this.startFailureCooldownMs) {
      const wait = Math.ceil(
        (this.startFailureCooldownMs - (Date.now() - lastFail)) / 1000
      );
      throw new Error(
        `Agent recently failed to start; waiting ${wait}s before retry.`
      );
    }

    const promise = this.startRuntime(record).then(
      (rt) => {
        this.runtimes.set(record.id, rt);
        this.creationLocks.delete(record.id);
        this.lastStartFailure.delete(record.id);
        return rt;
      },
      (err) => {
        this.creationLocks.delete(record.id);
        this.lastStartFailure.set(record.id, Date.now());
        throw err;
      }
    );
    this.creationLocks.set(record.id, promise);
    return promise;
  }

  /** Drop a runtime from the cache (e.g. on session/not-found). */
  async invalidate(sessionId: string, opts?: { clearAcpSession?: boolean }): Promise<void> {
    const rt = this.runtimes.get(sessionId);
    if (rt) {
      this.runtimes.delete(sessionId);
      try {
        await rt.dispose();
      } catch (err) {
        this.logger.warn({ err, sessionId }, "dispose during invalidate failed");
      }
    }
    if (opts?.clearAcpSession) {
      const record = this.store.get(sessionId);
      if (record?.acpSessionId) {
        // For agy, the stored acp_session_id is the durable key into the
        // agy-sessions.json cascade mapping. Per fix 17670d1, each `agy -p`
        // spawns a fresh language server, so the cascade survives a cancel /
        // session-gone and the agent resumes its full context next turn.
        // Clearing it here would orphan that preserved mapping: the next turn
        // sees an empty acp, calls newSession → a brand-new cascade, and the
        // reply is dropped / the thread goes amnesiac (the 2026-06-23 empty-
        // response bug). So preserve it for agy; only clear for agents whose
        // ACP session genuinely dies on session-gone (claude / copilot).
        if (record.agentId?.startsWith("agy")) {
          this.logger.info(
            { sessionId },
            "preserving agy acp/cascade id across invalidate (durable across agy -p spawns)"
          );
        } else {
          this.store.upsert({ ...record, acpSessionId: "", updatedUtc: new Date().toISOString() });
          this.logger.info({ sessionId }, "cleared stored acp session id");
        }
      }
    }
  }

  /** Cleanly abort the active turn for a session without terminating the agent process. */
  /** Abort the active turn for a session. Graceful by default (ACP cancel only,
   *  which a healthy turn honors). With `force`, escalate: if the turn is still
   *  running shortly after the cancel (a hung turn ignoring it), invalidate the
   *  runtime — which disposes it and force-kills the agent process group.
   *  Returns "idle" | "cancelled" | "killed". */
  async abortTurn(
    sessionId: string,
    opts?: { force?: boolean; graceMs?: number }
  ): Promise<"idle" | "cancelled" | "killed"> {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return "idle";
    const wasBusy = rt.busy;
    await rt.cancel().catch(() => {});
    this.logger.info({ sessionId }, "sent cancel signal to agent runtime");
    if (!wasBusy) return "idle";
    if (!opts?.force) return "cancelled";

    // Escalation: give the graceful cancel a moment to actually end the turn.
    const graceMs = opts.graceMs ?? 3000;
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (!rt.busy) return "cancelled";
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!rt.busy) return "cancelled";
    // Still hung — force-kill by disposing the runtime (keeps the session id so
    // the next message can resume cleanly).
    this.logger.warn({ sessionId }, "turn did not cancel; force-killing runtime");
    await this.invalidate(sessionId, { clearAcpSession: false });
    return "killed";
  }

  /** Force-kill EVERY live runtime (and its agent process group). Returns how
   *  many were killed. Session ids are preserved so threads resume cleanly on
   *  their next message. Used by /seam kill. */
  async killAll(opts?: { exceptId?: string }): Promise<number> {
    const ids = Array.from(this.runtimes.keys()).filter((id) => id !== opts?.exceptId);
    for (const id of ids) {
      await this.invalidate(id, { clearAcpSession: false }).catch((err) =>
        this.logger.warn({ err, id }, "killAll: invalidate failed")
      );
    }
    return ids.length;
  }

  /** Dispose all runtimes (graceful shutdown). */
  async disposeAll(): Promise<void> {
    const all = Array.from(this.runtimes.values());
    this.runtimes.clear();
    await Promise.all(
      all.map((rt) =>
        rt.dispose().catch((err) => {
          this.logger.warn({ err }, "dispose failed during shutdown");
        })
      )
    );
  }

  hasRuntime(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  private async startRuntime(record: SessionRecord): Promise<AgentRuntime> {
    const profile = this.profileById.get(record.agentId);
    if (!profile) {
      throw new Error(
        `Unknown agent profile "${record.agentId}" for session ${record.id}`
      );
    }
    const cfg = this.store.readConfig(record);
    const runtime = new AgentRuntime({
      profile,
      logger: this.logger.child({ session: record.id }),
      mcpServers: this.mcpServers,
      onDead: () => {
        this.logger.info({ sessionId: record.id }, "agent process died; evicting runtime for auto-resume");
        this.runtimes.delete(record.id);
      },
      permissionPolicy: async (req) => {
        // Always re-read: the captured `cfg` would be stale if the user later
        // changes the policy via `/seam approve` while the runtime is alive.
        const fresh = this.store.readConfig(record);
        const mode = resolvePermissionMode(fresh, this.defaultPermissionMode);
        if (mode === "always") {
          const opt =
            req.options.find((o) => o.kind?.startsWith("allow_")) ??
            req.options[0];
          if (opt) {
            return {
              outcome: { outcome: "selected", optionId: opt.optionId },
            };
          }
          return { outcome: { outcome: "cancelled" } };
        }
        if (mode === "ask" && this.askUser) {
          try {
            return await this.askUser(record, req);
          } catch (err) {
            this.logger.warn({ err, sessionId: record.id }, "askUser failed; denying");
            return { outcome: { outcome: "cancelled" } };
          }
        }
        // mode === "deny" (or "ask" with no askUser wired)
        return { outcome: { outcome: "cancelled" } };
      },
    });

    // For non-Anthropic backends (Ollama Cloud, Z.ai), setModel() is rejected
    // by claude-agent-acp. Pass the model at spawn time via env vars instead.
    runtime.modelOverride = cfg.model ?? this.defaultModel;
    await runtime.start();

    const cwd = record.repoPath ?? process.cwd();

    if (record.acpSessionId) {
      // Resume with a couple short retries. Right after a redeploy the agent
      // subprocess can still be spinning up when the first message lands, so
      // the first loadSession can fail transiently — and falling straight
      // through to newSession would overwrite the (good) acpSessionId and
      // detach the thread from its conversation. A brief escalating backoff
      // lets the agent finish starting before we give up.
      const RESUME_ATTEMPTS = 3;
      const RESUME_RETRY_MS = 400;
      for (let attempt = 1; attempt <= RESUME_ATTEMPTS; attempt++) {
        try {
          await runtime.loadSession({
            sessionId: record.acpSessionId,
            cwd,
            model: cfg.model ?? this.defaultModel,
            ...(cfg.reasoningEffort ? { effort: cfg.reasoningEffort } : {}),
            ...(cfg.mode ? { mode: cfg.mode } : {}),
          });
          this.logger.debug(
            { sessionId: record.id, acpSessionId: record.acpSessionId, attempt },
            "resumed acp session"
          );
          return runtime;
        } catch (err) {
          const lastAttempt = attempt === RESUME_ATTEMPTS;
          this.logger.warn(
            { err, sessionId: record.id, attempt, lastAttempt },
            lastAttempt
              ? "session/load failed after retries, creating new session"
              : "session/load failed; retrying after short delay"
          );
          if (!lastAttempt) {
            await new Promise((r) => setTimeout(r, RESUME_RETRY_MS * attempt));
          }
        }
      }
    }

    const info = await runtime.newSession({
      cwd,
      model: cfg.model ?? this.defaultModel,
      ...(cfg.reasoningEffort ? { effort: cfg.reasoningEffort } : {}),
      ...(cfg.mode ? { mode: cfg.mode } : {}),
    });
    // Persist the new ACP session id so we can resume on restart. Also sync the
    // caller's in-memory record: getOrStartRuntime receives the same record the
    // orchestrator reuses for the rest of the turn, and if it kept the empty
    // placeholder, a later config write (persistConfig spreads `...record`)
    // would upsert "" back over this id — silently unbinding the thread so the
    // NEXT restart resumes nothing and the user has to re-attach.
    record.acpSessionId = info.sessionId;
    this.store.upsert({
      ...record,
      updatedUtc: new Date().toISOString(),
    });
    return runtime;
  }
}
