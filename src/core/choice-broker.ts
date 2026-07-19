/**
 * ChoiceBroker — bridges a per-session `ask_user` MCP tool call to a human
 * choice presented on a chat platform (Discord).
 *
 * The agent (Copilot over ACP) has no native way to surface an interactive
 * multiple-choice question through ACP — it can only ask in prose. To recreate
 * the interactive picker, we inject a small `ask_user` MCP server into the
 * agent (see src/mcp/ask-user-server.ts). When the model calls that tool, the
 * MCP child POSTs to this broker's loopback HTTP endpoint using a per-runtime
 * bearer token. The broker maps the token to a runtime key, presents the choice
 * to the human (via the injected `presenter`), waits (bounded by a timeout) and
 * returns a structured outcome. All auth / correlation / timeout / cancellation
 * state lives here; the MCP child is a stateless thin proxy.
 *
 * Security: the HTTP server binds to loopback only (127.0.0.1) and every
 * request must carry a valid per-runtime bearer token. The token is generated
 * host-side and injected into the agent's MCP config env — it is never accepted
 * as a tool argument, so the model cannot forge a target session.
 */

import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Logger } from "../lib/logger.js";

export interface ChoiceOption {
  /** Stable id echoed back to the caller when this option is picked. */
  optionId: string;
  /** Human-readable label shown to the user. */
  label: string;
  /** Optional longer description. */
  description?: string;
}

export interface ChoicePrompt {
  question: string;
  options: ChoiceOption[];
  /** Whether the user may type a custom free-text answer. */
  allowFreeText: boolean;
}

export type ChoiceStatus =
  | "selected"
  | "free_text"
  | "timed_out"
  | "cancelled"
  | "error";

export interface ChoiceOutcome {
  status: ChoiceStatus;
  optionId?: string;
  label?: string;
  freeText?: string;
  error?: string;
}

/**
 * Presents a choice to the human for the given runtime key and resolves with
 * their answer. Implemented by the platform layer (Discord). `signal` aborts
 * when the turn is cancelled or the broker times out.
 */
export type ChoicePresenter = (
  key: string,
  prompt: ChoicePrompt,
  signal: AbortSignal
) => Promise<ChoiceOutcome>;

export interface ChoiceBrokerOptions {
  presenter: ChoicePresenter;
  logger: Logger;
  /** Loopback host. Defaults to 127.0.0.1 — never bind on a public interface. */
  host?: string;
  /** Max time to wait for a human answer before returning `timed_out`. */
  timeoutMs?: number;
  /** Max request body size in bytes. */
  maxBodyBytes?: number;
}

interface RuntimeReg {
  key: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_BODY = 64 * 1024;
const MAX_OPTIONS = 25; // Discord select-menu hard limit.

export class ChoiceBroker {
  private server?: http.Server;
  private boundPort = 0;
  private readonly host: string;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly presenter: ChoicePresenter;
  private readonly logger: Logger;
  /** token -> runtime registration */
  private readonly tokens = new Map<string, RuntimeReg>();
  /** one in-flight choice per runtime key */
  private readonly active = new Map<string, AbortController>();

  constructor(opts: ChoiceBrokerOptions) {
    this.presenter = opts.presenter;
    this.logger = opts.logger;
    this.host = opts.host ?? "127.0.0.1";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.logger.error({ err }, "choice-broker handler crashed");
        this.safeJson(res, 500, { status: "error", error: "internal" });
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, this.host, () => {
        const addr = server.address();
        this.boundPort = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
    this.logger.info({ url: this.callbackUrl }, "choice-broker listening (loopback)");
  }

  async stop(): Promise<void> {
    for (const ac of this.active.values()) ac.abort();
    this.active.clear();
    this.tokens.clear();
    const server = this.server;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.server = undefined;
    }
  }

  /** Loopback URL the injected MCP child should POST to. */
  get callbackUrl(): string {
    return `http://${this.host}:${this.boundPort}/choice`;
  }

  get port(): number {
    return this.boundPort;
  }

  /** Register a runtime and return its per-runtime bearer token. */
  registerRuntime(key: string): string {
    const token = randomBytes(32).toString("hex");
    this.tokens.set(token, { key });
    return token;
  }

  /** Revoke a token and abort any in-flight choice for its runtime key. */
  revoke(token: string): void {
    const reg = this.tokens.get(token);
    this.tokens.delete(token);
    if (reg) {
      const ac = this.active.get(reg.key);
      if (ac) {
        ac.abort();
        this.active.delete(reg.key);
      }
    }
  }

  private lookupToken(header: string | string[] | undefined): RuntimeReg | undefined {
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw) return undefined;
    const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
    if (!m) return undefined;
    const presented = Buffer.from(m[1]!);
    for (const [tok, reg] of this.tokens) {
      const known = Buffer.from(tok);
      if (known.length === presented.length && timingSafeEqual(known, presented)) {
        return reg;
      }
    }
    return undefined;
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    if (req.method !== "POST" || !req.url?.startsWith("/choice")) {
      return this.safeJson(res, 404, { status: "error", error: "not found" });
    }
    const reg = this.lookupToken(req.headers["authorization"]);
    if (!reg) {
      return this.safeJson(res, 401, { status: "error", error: "unauthorized" });
    }

    const body = await this.readBody(req);
    if (body === null) {
      return this.safeJson(res, 413, { status: "error", error: "body too large" });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return this.safeJson(res, 400, { status: "error", error: "bad json" });
    }

    const prompt = normalizePrompt(parsed);
    if (!prompt) {
      return this.safeJson(res, 400, { status: "error", error: "invalid prompt" });
    }

    // One active choice per runtime key. A second concurrent request is
    // rejected rather than racing two Discord panels for one session.
    if (this.active.has(reg.key)) {
      return this.safeJson(res, 409, {
        status: "error",
        error: "a choice is already pending for this session",
      });
    }

    const ac = new AbortController();
    this.active.set(reg.key, ac);
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const outcome = await this.presenter(reg.key, prompt, ac.signal);
      return this.safeJson(res, 200, outcome);
    } catch (err) {
      if (ac.signal.aborted) {
        return this.safeJson(res, 200, { status: "timed_out" });
      }
      this.logger.warn({ err, key: reg.key }, "choice presenter failed");
      return this.safeJson(res, 200, { status: "error", error: "presenter failed" });
    } finally {
      clearTimeout(timer);
      // Only clear the lock if it's still *ours*: a previous runtime generation
      // for the same key could have started a new choice after we were aborted,
      // and we must not delete its lock.
      if (this.active.get(reg.key) === ac) {
        this.active.delete(reg.key);
      }
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > this.maxBodyBytes) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", () => resolve(null));
    });
  }

  private safeJson(
    res: http.ServerResponse,
    code: number,
    body: unknown
  ): void {
    if (res.writableEnded) return;
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }
}

/** Validate + clamp an untrusted MCP payload into a ChoicePrompt. Exported for
 *  unit testing. Returns undefined when the payload is unusable. */
export function normalizePrompt(raw: unknown): ChoicePrompt | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.question !== "string" || !r.question.trim()) return undefined;

  const rawOpts = Array.isArray(r.options) ? r.options : [];
  const options: ChoiceOption[] = [];
  for (let idx = 0; idx < rawOpts.length && options.length < MAX_OPTIONS; idx++) {
    const o = rawOpts[idx];
    if (typeof o === "string") {
      if (!o.trim()) continue;
      options.push({ optionId: String(idx), label: o.slice(0, 300) });
    } else if (o && typeof o === "object" && typeof (o as { label?: unknown }).label === "string") {
      const oo = o as { optionId?: unknown; label: string; description?: unknown };
      options.push({
        optionId: oo.optionId != null ? String(oo.optionId) : String(idx),
        label: oo.label.slice(0, 300),
        ...(typeof oo.description === "string"
          ? { description: oo.description.slice(0, 500) }
          : {}),
      });
    }
  }

  return {
    question: r.question.slice(0, 1500),
    options,
    allowFreeText: r.allowFreeText !== false, // default true
  };
}
