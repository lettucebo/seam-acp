import type { SessionRecord, StructuredPanel } from "../core/types.js";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

/** Reference to a channel or thread on a chat platform. */
export interface ChannelRef {
  /** Platform id ("discord"). */
  platform: string;
  /** Stable id from the platform (channel or thread snowflake on Discord). */
  id: string;
  /** Optional parent channel id (for threads). */
  parentId?: string;
}

/** Reference to a previously-sent message; used for `editMessage`. */
export interface MessageRef {
  channel: ChannelRef;
  id: string;
}

/** A file attached to an incoming message, normalized across platforms. */
export interface MessageAttachment {
  /** Stable URL the bot can fetch (Discord CDN URL). */
  url: string;
  filename: string;
  /** MIME type if the platform reported one. */
  contentType: string | null;
  /** Size in bytes. */
  size: number;
}

/** Incoming user message, normalized across platforms. */
export interface IncomingMessage {
  channel: ChannelRef;
  authorId: string;
  authorIsBot: boolean;
  text: string;
  /** Files attached to the message, if any. */
  attachments?: MessageAttachment[];
  /** Platform-specific raw object for advanced handlers. */
  raw?: unknown;
}

/**
 * Generic chat adapter contract. Discord today, Slack tomorrow.
 *
 * The adapter is responsible for:
 *  - connecting to the platform
 *  - receiving messages (filtered to "the bot should respond to this")
 *  - sending / editing messages
 *  - creating threads (if supported)
 *
 * Anything platform-specific (slash command schema, mentions, reactions,
 * etc.) lives under each adapter's own folder.
 */
export interface ChatAdapter {
  readonly platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;

  sendMessage(channel: ChannelRef, text: string): Promise<MessageRef>;
  editMessage(message: MessageRef, text: string): Promise<void>;

  /**
   * Optional: upload a file to the channel. Required for the agent → Discord
   * file path. Implementations may also send caption text alongside the file.
   */
  sendFile?(
    channel: ChannelRef,
    file: {
      data: Buffer;
      filename: string;
      mimeType: string;
      caption?: string;
    }
  ): Promise<MessageRef>;

  /** Optional: platforms that support threads should implement this. */
  createThread?(parent: ChannelRef, name: string): Promise<ChannelRef>;

  /** Optional: rename a thread (no-op on platforms that don't support it). */
  renameThread?(channel: ChannelRef, name: string): Promise<void>;

  /** Optional: return the current display name of a thread/channel. */
  getThreadName?(channel: ChannelRef): Promise<string | undefined>;

  /** Optional: fetch historical messages for a thread (chronological order). */
  fetchThreadMessages?(channel: ChannelRef): Promise<Array<{ authorIsBot: boolean; text: string }>>;

  /** Optional: register a handler called when a thread is deleted (channelRef =
   *  the thread id). Used by scheduled prompts for instant cleanup. */
  onThreadDelete?(handler: (channelRef: string) => void | Promise<void>): void;

  /** Optional: live state of a thread. Returns `undefined` only when the thread
   *  is *confirmed gone* (e.g. Discord "Unknown Channel"); throws on transient
   *  errors so callers don't mistake a blip for a deletion. Used by scheduled
   *  prompts to decide run / skip-locked / drop-deleted at fire time. */
  getThreadLiveState?(
    channel: ChannelRef
  ): Promise<{ locked: boolean; archived: boolean } | undefined>;

  /** Optional: fetch historical messages with timestamps (ms epoch), optionally
   *  bounded to [fromTs, toTs]. Used by premium compaction to pull only the
   *  Discord ranges the gap-detector flagged as higher-fidelity than the session
   *  store. Chronological order. */
  fetchThreadMessagesTimed?(
    channel: ChannelRef,
    opts?: { fromTs?: number; toTs?: number }
  ): Promise<Array<{ ts: number; authorIsBot: boolean; text: string }>>;

  /** Optional: send a rich structured panel (embed on Discord). */
  sendPanel?(channel: ChannelRef, panel: StructuredPanel): Promise<MessageRef>;

  /** Optional: edit a previously-sent panel. */
  editPanel?(message: MessageRef, panel: StructuredPanel): Promise<void>;

  /**
   * Optional: present an interactive choice picker (buttons / select menu)
   * and resolve when the user picks one. Returns null on timeout / cancel.
   * Implementations may impose their own choice-count limits (e.g. Discord
   * select menus cap at 25).
   */
  sendChoicePicker?(
    channel: ChannelRef,
    opts: {
      prompt?: string;
      panel?: StructuredPanel;
      choices: ReadonlyArray<{ value: string; label: string; description?: string }>;
      timeoutMs?: number;
      /** Force string-select rendering so option descriptions stay visible. */
      forceSelect?: boolean;
      authorizedUserIds?: ReadonlySet<string>;
      successPanel?: (picked: { value: string; label: string }, username: string) => StructuredPanel;
    }
  ): Promise<{ value: string; userId: string } | null>;

  /** Subscribe to bot-relevant incoming messages. */
  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void;

  /**
   * Optional: trigger a typing indicator in the channel. The indicator
   * lasts ~10 s on Discord; call again before it expires to extend it.
   * Best-effort — implementations should never throw.
   */
  sendTyping?(channel: ChannelRef): Promise<void>;

  /**
   * Optional: ask the user to approve / deny a tool permission request,
   * blocking until they respond or the timeout elapses. Required for the
   * `ask` permission policy. Implementations should default to "cancelled"
   * on timeout.
   */
  requestApproval?(
    channel: ChannelRef,
    req: RequestPermissionRequest,
    opts?: { timeoutMs?: number }
  ): Promise<RequestPermissionResponse>;
}

/**
 * Convenience: the session-router wants to translate channel refs to
 * SessionRecord ids. We expose this as a tiny helper rather than pollute the
 * adapter interface.
 */
export function makeSessionIdFromChannel(channel: ChannelRef): string {
  return `${channel.platform}:${channel.id}`;
}

export type { SessionRecord };
