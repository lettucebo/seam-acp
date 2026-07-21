import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  REST,
  Routes,
  MessageFlags,
  MessageType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type Message,
  type TextChannel,
  type ThreadChannel,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from "discord.js";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../../lib/logger.js";
import type { Config } from "../../config.js";
import type {
  ChatAdapter,
  ChannelRef,
  IncomingMessage,
  MessageAttachment,
  MessageRef,
} from "../chat-adapter.js";
import { buildSeamCommand } from "./commands.js";

const PLATFORM = "discord";

export type SlashHandler = (
  interaction: ChatInputCommandInteraction
) => Promise<void>;

export type AutocompleteHandler = (
  interaction: AutocompleteInteraction
) => Promise<void>;

/**
 * discord.js v14 chat adapter.
 *
 * Responsibilities:
 *  - connect with Guild + GuildMessages + MessageContent intents
 *  - register `/seam` slash commands (guild-scoped if DEV guild set, global otherwise)
 *  - filter incoming messages: only thread messages, only the configured owner,
 *    only when the bot is in a thread it created (parent channel match optional)
 *  - send/edit messages
 */
export class DiscordAdapter implements ChatAdapter {
  readonly platform = PLATFORM;

  private readonly client: Client;
  private readonly logger: Logger;
  private readonly config: Config;
  private readonly slashHandler: SlashHandler;
  private readonly autocompleteHandler: AutocompleteHandler | undefined;

  private messageHandler?: (msg: IncomingMessage) => void | Promise<void>;
  private threadDeleteHandler?: (channelRef: string) => void | Promise<void>;
  private botUserId?: string;

  constructor(opts: {
    config: Config;
    logger: Logger;
    slashHandler: SlashHandler;
    autocompleteHandler?: AutocompleteHandler;
  }) {
    this.config = opts.config;
    this.logger = opts.logger.child({ adapter: PLATFORM });
    this.slashHandler = opts.slashHandler;
    this.autocompleteHandler = opts.autocompleteHandler;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  onThreadDelete(handler: (channelRef: string) => void | Promise<void>): void {
    this.threadDeleteHandler = handler;
  }

  async start(): Promise<void> {
    this.wire();
    await this.client.login(this.config.DISCORD_BOT_TOKEN);
    await new Promise<void>((resolve) => {
      if (this.client.isReady()) return resolve();
      this.client.once(Events.ClientReady, () => resolve());
    });
    this.botUserId = this.client.user?.id;
    this.logger.info({ botUserId: this.botUserId }, "discord adapter ready");
    await this.registerSlashCommands();
    await this.applyAvatarIfNeeded();
  }

  async stop(): Promise<void> {
    try {
      await this.client.destroy();
    } catch (err) {
      this.logger.warn({ err }, "discord client destroy failed");
    }
  }

  async sendMessage(channel: ChannelRef, text: string): Promise<MessageRef> {
    const ch = await this.fetchSendableChannel(channel.id);
    const sent = await ch.send({
      content: text,
      flags: MessageFlags.SuppressEmbeds,
    });
    return { channel, id: sent.id };
  }

  async editMessage(message: MessageRef, text: string): Promise<void> {
    const ch = await this.fetchSendableChannel(message.channel.id);
    const msg = await ch.messages.fetch(message.id);
    await msg.edit({ content: text, flags: MessageFlags.SuppressEmbeds });
  }

  async sendFile(
    channel: ChannelRef,
    file: { data: Buffer; filename: string; mimeType: string; caption?: string }
  ): Promise<MessageRef> {
    const ch = await this.fetchSendableChannel(channel.id);
    const sent = await ch.send({
      ...(file.caption ? { content: file.caption } : {}),
      files: [{ attachment: file.data, name: file.filename }],
      flags: MessageFlags.SuppressEmbeds,
    });
    return { channel, id: sent.id };
  }

  async sendTyping(channel: ChannelRef): Promise<void> {
    try {
      const ch = await this.fetchSendableChannel(channel.id);
      await ch.sendTyping();
    } catch {
      // Best-effort — typing indicators must never break a turn.
    }
  }

  /**
   * Show an interactive picker. Uses a button row when the choice count
   * fits Discord's 5-button limit; otherwise falls back to a string-select
   * menu (capped at the platform's 25-option limit). Returns null on
   * timeout or unauthorized interaction.
   */
  async sendChoicePicker(
    channel: ChannelRef,
    opts: {
      prompt?: string;
      panel?: import("../../core/types.js").StructuredPanel;
      choices: ReadonlyArray<{ value: string; label: string; description?: string }>;
      timeoutMs?: number;
      authorizedUserIds?: ReadonlySet<string>;
      successPanel?: (picked: { value: string; label: string }, username: string) => import("../../core/types.js").StructuredPanel;
    }
  ): Promise<{ value: string; userId: string } | null> {
    const ch = await this.fetchSendableChannel(channel.id);
    // timeoutMs <= 0 means "never time out" — the picker stays clickable until
    // a choice is made (or the message is removed).
    const noTimeout = opts.timeoutMs !== undefined && opts.timeoutMs <= 0;
    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

    const choices = opts.choices.slice(0, 25);
    if (choices.length === 0) return null;

    // Discord allows 5 buttons per row × 5 rows = 25 buttons total.
    // We cap at 15 (3 rows) so the picker stays visually manageable;
    // anything bigger drops to a single dropdown.
    const BUTTON_LIMIT = 15;
    const BUTTONS_PER_ROW = 5;
    const useButtons = choices.length <= BUTTON_LIMIT;
    const customId = `seam-pick:${Date.now()}`;

    const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
    if (useButtons) {
      const buttons = choices.map((c, idx) =>
        new ButtonBuilder()
          .setCustomId(`${customId}:${idx}`)
          .setLabel(c.label.slice(0, 80))
          .setStyle(ButtonStyle.Secondary)
      );
      for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
        components.push(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            buttons.slice(i, i + BUTTONS_PER_ROW)
          )
        );
      }
    } else {
      const select = new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder("Choose…")
        .addOptions(
          choices.map((c, idx) => ({
            value: String(idx),
            label: c.label.slice(0, 100),
            ...(c.description ? { description: c.description.slice(0, 100) } : {}),
          }))
        );
      components.push(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
      );
    }

    const embeds = opts.panel ? [DiscordAdapter.buildEmbed(opts.panel)] : [];
    const msg = await ch.send({
      content: opts.prompt,
      embeds,
      components,
    });

    try {
      const interaction = await msg.awaitMessageComponent({
        filter: (i) => {
          if (
            opts.authorizedUserIds &&
            !opts.authorizedUserIds.has(i.user.id)
          ) {
            i.reply({
              content: "This bot is not available to you.",
              flags: MessageFlags.Ephemeral,
            }).catch(() => {});
            return false;
          }
          return true;
        },
        // Omit `time` to wait indefinitely when no timeout was requested.
        ...(noTimeout ? {} : { time: timeoutMs }),
      });

      let pickedIdx: number;
      if (interaction.componentType === ComponentType.Button) {
        pickedIdx = Number.parseInt(
          interaction.customId.split(":").pop() ?? "",
          10
        );
      } else if (interaction.componentType === ComponentType.StringSelect) {
        pickedIdx = Number.parseInt(interaction.values[0] ?? "", 10);
      } else {
        return null;
      }

      const chosen = choices[pickedIdx];
      if (!chosen) {
        if (opts.panel) {
          const errEmbed = DiscordAdapter.buildEmbed(opts.panel).setColor(0xed4245);
          errEmbed.setDescription("_Invalid choice._");
          await msg.edit({ content: opts.prompt, embeds: [errEmbed], components: [] });
        } else {
          await msg.edit({ content: `${opts.prompt ?? ""}\n_Invalid choice._`, components: [] });
        }
        return null;
      }

      if (opts.successPanel) {
        const successPanel = opts.successPanel(
          { value: chosen.value, label: chosen.label },
          interaction.user.username
        );
        const successEmbed = DiscordAdapter.buildEmbed(successPanel);
        await msg.edit({
          content: opts.prompt,
          embeds: [successEmbed],
          components: [],
        });
      } else if (opts.panel) {
        const successEmbed = DiscordAdapter.buildEmbed(opts.panel).setColor(0x57f287);
        const newDesc = opts.panel.description 
          ? `${opts.panel.description}\n\n✅ **${chosen.label}** (${interaction.user.username})`
          : `✅ **${chosen.label}** (${interaction.user.username})`;
        successEmbed.setDescription(newDesc.slice(0, 4096));
        await msg.edit({
          content: opts.prompt,
          embeds: [successEmbed],
          components: [],
        });
      } else {
        await msg.edit({
          content: `${opts.prompt ?? ""}\n✅ **${chosen.label}** (${interaction.user.username})`,
          components: [],
        });
      }
      try {
        await interaction.deferUpdate();
      } catch {
        /* ignore */
      }
      return { value: chosen.value, userId: interaction.user.id };
    } catch {
      try {
        await msg.edit({
          content: `${opts.prompt}\n⏱️ _Timed out._`,
          components: [],
        });
      } catch {
        /* ignore */
      }
      return null;
    }
  }

  async createThread(parent: ChannelRef, name: string): Promise<ChannelRef> {
    let ch = await this.client.channels.fetch(parent.id);
    if (!ch) throw new Error(`Channel ${parent.id} not found`);

    // If invoked from inside a thread, walk up to its parent.
    if (ch.isThread()) {
      const parentId = ch.parentId;
      if (!parentId) {
        throw new Error(`Thread ${parent.id} has no parent channel`);
      }
      const parentCh = await this.client.channels.fetch(parentId);
      if (!parentCh) {
        throw new Error(`Parent channel ${parentId} not found`);
      }
      ch = parentCh;
    }

    if (
      ch.type !== ChannelType.GuildText &&
      ch.type !== ChannelType.GuildAnnouncement
    ) {
      throw new Error(
        `Channel ${ch.id} (type ${ch.type}) does not support threads`
      );
    }

    const thread = await (ch as TextChannel).threads.create({
      name,
      autoArchiveDuration: 1440,
      type: ChannelType.PublicThread,
    });
    return {
      platform: PLATFORM,
      id: thread.id,
      parentId: ch.id,
    };
  }

  async renameThread(channel: ChannelRef, name: string): Promise<void> {
    try {
      const ch = await this.client.channels.fetch(channel.id);
      if (!ch?.isThread()) return;
      await (ch as ThreadChannel).edit({ name: name.slice(0, 100) });
    } catch (err) {
      this.logger.warn({ err, channelId: channel.id }, "renameThread failed");
    }
  }

  async getThreadName(channel: ChannelRef): Promise<string | undefined> {
    try {
      const ch = await this.client.channels.fetch(channel.id);
      if (!ch?.isThread()) return undefined;
      return (ch as ThreadChannel).name ?? undefined;
    } catch {
      return undefined;
    }
  }

  async fetchThreadMessages(channel: ChannelRef): Promise<Array<{ authorIsBot: boolean; text: string }>> {
    const ch = await this.fetchSendableChannel(channel.id);
    if (!ch.isThread()) throw new Error("Channel is not a thread.");
    
    const messages = [];
    let lastId: string | undefined;
    
    while (true) {
      const options: { limit: number; before?: string } = { limit: 100 };
      if (lastId) options.before = lastId;
      
      const chunk = await ch.messages.fetch(options);
      if (chunk.size === 0) break;
      
      for (const msg of chunk.values()) {
        if (msg.type !== MessageType.Default && msg.type !== MessageType.Reply) continue;
        if (!msg.content?.trim() && msg.attachments.size === 0) continue;

        // Skip bot messages that are status cards / panels. These are embed-
        // only messages (or embed + minimal content) that show operational info
        // (model, context usage, timing) — useless noise for rebuild summaries.
        if (msg.author.bot && msg.embeds.length > 0 && !msg.content?.trim()) continue;
        
        let text = msg.content ?? "";
        if (msg.attachments.size > 0) {
          const names = msg.attachments.map((a: any) => a.name).join(", ");
          text += ` [Attachments: ${names}]`;
        }
        
        messages.push({
          authorIsBot: msg.author.bot,
          text: text.trim(),
        });
      }
      
      lastId = chunk.last()?.id;
    }
    
    return messages.reverse();
  }

  async getThreadLiveState(
    channel: ChannelRef
  ): Promise<{ locked: boolean; archived: boolean } | undefined> {
    try {
      const ch = await this.client.channels.fetch(channel.id);
      if (!ch) return undefined; // gone
      if (ch.isThread()) return { locked: ch.locked ?? false, archived: ch.archived ?? false };
      if (ch.isTextBased()) return { locked: false, archived: false }; // plain channel — always postable
      return undefined; // not a postable channel
    } catch (err) {
      // 10003 = Unknown Channel → confirmed deleted. Anything else is transient;
      // rethrow so the caller skips this run rather than dropping the schedule.
      if ((err as { code?: number })?.code === 10003) return undefined;
      throw err;
    }
  }

  async fetchThreadMessagesTimed(
    channel: ChannelRef,
    opts?: { fromTs?: number; toTs?: number }
  ): Promise<Array<{ ts: number; authorIsBot: boolean; text: string }>> {
    const ch = await this.fetchSendableChannel(channel.id);
    if (!ch.isThread()) throw new Error("Channel is not a thread.");
    const from = opts?.fromTs ?? -Infinity;
    const to = opts?.toTs ?? Infinity;

    const messages: Array<{ ts: number; authorIsBot: boolean; text: string }> = [];
    let lastId: string | undefined;

    while (true) {
      const options: { limit: number; before?: string } = { limit: 100 };
      if (lastId) options.before = lastId;

      const chunk = await ch.messages.fetch(options);
      if (chunk.size === 0) break;

      let allOlderThanFrom = true;
      for (const msg of chunk.values()) {
        const ts = msg.createdTimestamp;
        if (ts >= from) allOlderThanFrom = false;
        if (msg.type !== MessageType.Default && msg.type !== MessageType.Reply) continue;
        if (!msg.content?.trim() && msg.attachments.size === 0) continue;
        if (ts < from || ts > to) continue;

        let text = msg.content ?? "";
        if (msg.attachments.size > 0) {
          const names = msg.attachments.map((a: any) => a.name).join(", ");
          text += ` [Attachments: ${names}]`;
        }
        messages.push({ ts, authorIsBot: msg.author.bot, text: text.trim() });
      }

      // We page backwards (newest→oldest). Once an entire page is older than the
      // lower bound, everything further back is too — stop paginating.
      if (allOlderThanFrom) break;
      lastId = chunk.last()?.id;
    }

    return messages.sort((a, b) => a.ts - b.ts);
  }

  async sendPanel(
    channel: ChannelRef,
    panel: import("../../core/types.js").StructuredPanel
  ): Promise<MessageRef> {
    const ch = await this.fetchSendableChannel(channel.id);
    const embed = DiscordAdapter.buildEmbed(panel);
    const sent = await ch.send({ embeds: [embed] });
    return { channel, id: sent.id };
  }

  async editPanel(
    message: MessageRef,
    panel: import("../../core/types.js").StructuredPanel
  ): Promise<void> {
    const ch = await this.fetchSendableChannel(message.channel.id);
    const msg = await ch.messages.fetch(message.id);
    const embed = DiscordAdapter.buildEmbed(panel);
    await msg.edit({ content: "", embeds: [embed] });
  }

  private static buildEmbed(
    panel: import("../../core/types.js").StructuredPanel
  ): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setColor(panel.color)
      .setTitle(panel.title);
    if (panel.author) {
      embed.setAuthor({ name: panel.author });
    }
    if (panel.description) {
      embed.setDescription(panel.description.slice(0, 4096));
    }
    for (const f of panel.fields) {
      embed.addFields({
        name: f.name.slice(0, 256),
        value: f.value.slice(0, 1024) || "\u200B",
        inline: f.inline ?? false,
      });
    }
    if (panel.footer) {
      embed.setFooter({ text: panel.footer.slice(0, 2048) });
    }
    return embed;
  }

  // --- internals ---

  private wire(): void {
    this.client.on(Events.MessageCreate, (msg) => {
      this.handleMessage(msg).catch((err) => {
        this.logger.error({ err }, "message handler crashed");
      });
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isAutocomplete()) {
        if (interaction.commandName !== "seam") return;
        this.handleAutocomplete(interaction).catch((err) => {
          this.logger.error({ err }, "autocomplete handler crashed");
        });
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== "seam") return;
      this.handleSlash(interaction).catch((err) => {
        this.logger.error({ err }, "slash handler crashed");
      });
    });
    this.client.on(Events.ThreadDelete, (thread) => {
      void Promise.resolve(this.threadDeleteHandler?.(thread.id)).catch((err) => {
        this.logger.error({ err }, "thread-delete handler crashed");
      });
    });
  }

  private async handleMessage(msg: Message): Promise<void> {
    if (!this.messageHandler) return;
    if (msg.author.bot) return;
    if (msg.type !== MessageType.Default && msg.type !== MessageType.Reply) return;
    if (!this.config.DISCORD_ALLOWED_USER_IDS.has(msg.author.id)) return;
    if (!msg.channel.isThread()) return;

    const thread = msg.channel as ThreadChannel;

    // If parent isn't accessible / not text, ignore.
    const parentId = thread.parentId ?? undefined;

    const allowedChannels = this.config.DISCORD_ALLOWED_CHANNEL_IDS;
    if (allowedChannels && (!parentId || !allowedChannels.has(parentId))) return;

    const text = (msg.content ?? "").trim();
    const attachments: MessageAttachment[] = msg.attachments.map((a) => ({
      url: a.url,
      filename: a.name ?? "attachment",
      contentType: a.contentType ?? null,
      size: a.size ?? 0,
    }));
    if (!text && attachments.length === 0) return;

    const channel: ChannelRef = {
      platform: PLATFORM,
      id: thread.id,
      ...(parentId ? { parentId } : {}),
    };

    const incoming: IncomingMessage = {
      channel,
      authorId: msg.author.id,
      authorIsBot: false,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      raw: msg,
    };

    await this.messageHandler(incoming);
  }

  private async handleSlash(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    if (!this.config.DISCORD_ALLOWED_USER_IDS.has(interaction.user.id)) {
      await interaction.reply({
        content: "This bot is not available to you.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Mirror handleMessage: enforce the channel allowlist here. Unset = all allowed.
    const allowedChannels = this.config.DISCORD_ALLOWED_CHANNEL_IDS;
    if (allowedChannels) {
      const effectiveId = this.allowlistChannelId(interaction);
      if (!effectiveId || !allowedChannels.has(effectiveId)) {
        await interaction.reply({
          content: "This channel isn't enabled for seam.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
    await this.slashHandler(interaction);
  }

  /**
   * The channel id to check against DISCORD_ALLOWED_CHANNEL_IDS:
   *  - in a thread → its PARENT channel (the allowlist lists parent channels);
   *  - in a normal channel → the channel itself.
   * A text channel's `parentId` is its CATEGORY, which must NOT be used here —
   * using it was why `/seam repo set` autocomplete returned nothing when run
   * directly in an allowed channel that happens to sit under a category.
   */
  private allowlistChannelId(
    interaction: ChatInputCommandInteraction | AutocompleteInteraction
  ): string | undefined {
    const ch = interaction.channel;
    if (ch && "isThread" in ch && typeof ch.isThread === "function" && ch.isThread()) {
      return ch.parentId ?? undefined;
    }
    return interaction.channelId ?? undefined;
  }

  private async handleAutocomplete(
    interaction: AutocompleteInteraction
  ): Promise<void> {
    // Autocomplete can only reply with suggestions, so an unauthorized caller
    // gets an empty list (same gate as handleSlash: user + channel allowlist).
    if (!this.autocompleteHandler) {
      await interaction.respond([]);
      return;
    }
    if (!this.config.DISCORD_ALLOWED_USER_IDS.has(interaction.user.id)) {
      await interaction.respond([]);
      return;
    }
    const allowedChannels = this.config.DISCORD_ALLOWED_CHANNEL_IDS;
    if (allowedChannels) {
      const effectiveId = this.allowlistChannelId(interaction);
      if (!effectiveId || !allowedChannels.has(effectiveId)) {
        await interaction.respond([]);
        return;
      }
    }
    await this.autocompleteHandler(interaction);
  }

  /** Push the PNG avatar. Resolves with true on success, false if file not found. */
  async pushAvatar(): Promise<boolean> {
    const avatarPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../assets/seam-acp-avatar.png"
    );
    if (!fs.existsSync(avatarPath)) {
      this.logger.warn({ avatarPath }, "avatar file not found; skipping");
      return false;
    }
    await this.client.user!.setAvatar(avatarPath);
    this.logger.info("bot avatar updated");
    return true;
  }

  /** Push the PNG banner. Resolves with true on success, false if file not found. */
  async pushBanner(): Promise<boolean> {
    const bannerPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../assets/seam-acp-banner.png"
    );
    if (!fs.existsSync(bannerPath)) {
      this.logger.warn({ bannerPath }, "banner file not found; skipping");
      return false;
    }
    await this.client.user!.setBanner(bannerPath);
    this.logger.info("bot banner updated");
    return true;
  }

  private async applyAvatarIfNeeded(): Promise<void> {
    if (this.client.user?.avatar) return; // already has one
    try {
      await this.pushAvatar();
      await this.pushBanner();
    } catch (err) {
      this.logger.warn({ err }, "failed to set bot avatar/banner (rate-limited or missing file)");
    }
  }

  /**
   * Post an approval prompt with one button per ACP option and wait for a
   * click. Defaults to "cancelled" on timeout. Only an allowed user can
   * answer.
   */
  async requestApproval(
    channel: ChannelRef,
    req: RequestPermissionRequest,
    opts: { timeoutMs?: number } = {}
  ): Promise<RequestPermissionResponse> {
    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    const ch = await this.fetchSendableChannel(channel.id);

    const tool = req.toolCall;
    const title = tool?.title ?? `Tool: ${tool?.kind ?? tool?.toolCallId ?? "unknown"}`;
    const embed = new EmbedBuilder()
      .setTitle("🔐 Permission requested")
      .setDescription(`The agent wants to run **${title}**.`)
      .setColor(0xfaa61a)
      .setFooter({
        text: `Auto-denies in ${Math.round(timeoutMs / 1000)}s.`,
      });

    if (tool?.kind) embed.addFields({ name: "Tool kind", value: tool.kind, inline: true });
    if (tool?.toolCallId)
      embed.addFields({ name: "Call ID", value: `\`${tool.toolCallId}\``, inline: true });

    // Discord allows up to 5 buttons per row. Most agents send 2–4 options.
    const buttons = req.options.slice(0, 5).map((opt, idx) =>
      new ButtonBuilder()
        .setCustomId(`seam-perm:${idx}:${opt.optionId.slice(0, 80)}`)
        .setLabel(opt.name.slice(0, 80))
        .setStyle(buttonStyleForKind(opt.kind))
        .setEmoji(buttonEmojiForKind(opt.kind))
    );
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

    const msg = await ch.send({ embeds: [embed], components: [row] });

    try {
      const interaction = await msg.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => {
          if (!this.config.DISCORD_ALLOWED_USER_IDS.has(i.user.id)) {
            i.reply({
              content: "This bot is not available to you.",
              flags: MessageFlags.Ephemeral,
            }).catch(() => {});
            return false;
          }
          return true;
        },
        time: timeoutMs,
      });

      const idxStr = interaction.customId.split(":")[1] ?? "";
      const idx = Number.parseInt(idxStr, 10);
      const chosen = req.options[idx];
      if (!chosen) {
        await msg.edit({ embeds: [embed.setFooter({ text: "❓ Invalid choice." })], components: [] });
        return { outcome: { outcome: "cancelled" } };
      }

      await msg.edit({
        embeds: [
          embed.setFooter({
            text: `${decisionEmoji(chosen.kind)} ${interaction.user.username} chose: ${chosen.name}`,
          }),
        ],
        components: [],
      });
      try {
        await interaction.deferUpdate();
      } catch {
        /* ignore */
      }
      return { outcome: { outcome: "selected", optionId: chosen.optionId } };
    } catch {
      // timeout / collector ended
      try {
        await msg.edit({
          embeds: [embed.setFooter({ text: "⏱️ Timed out — auto-denied." })],
          components: [],
        });
      } catch {
        /* ignore */
      }
      return { outcome: { outcome: "cancelled" } };
    }
  }

  private async fetchSendableChannel(
    channelId: string
  ): Promise<TextChannel | ThreadChannel> {
    const ch = await this.client.channels.fetch(channelId);
    if (!ch) throw new Error(`Channel ${channelId} not found`);
    if (
      ch.type === ChannelType.GuildText ||
      ch.type === ChannelType.GuildAnnouncement ||
      ch.type === ChannelType.PublicThread ||
      ch.type === ChannelType.PrivateThread ||
      ch.type === ChannelType.AnnouncementThread
    ) {
      return ch as TextChannel | ThreadChannel;
    }
    throw new Error(`Channel ${channelId} is not text/thread (${ch.type})`);
  }

  private async registerSlashCommands(): Promise<void> {
    const appId = this.client.user?.id;
    if (!appId) {
      this.logger.warn("no client user id; skipping slash registration");
      return;
    }
    const rest = new REST({ version: "10" }).setToken(
      this.config.DISCORD_BOT_TOKEN
    );
    const body = [buildSeamCommand(this.config.REPOS_ROOT).toJSON()];
    const guildIds = this.config.DISCORD_DEV_GUILD_ID;
    if (guildIds.length > 0) {
      // Register to each listed guild — instant, and scoped to servers we
      // explicitly opt in (vs global, which exposes /seam in every server the
      // bot is in and takes ~1h to propagate).
      for (const guildId of guildIds) {
        // Per-guild try/catch: a guild the bot hasn't been invited to (or lost
        // access to) returns Missing Access / Unknown Guild. Skip it with a
        // clear warning so it can't abort registration for the other guilds or
        // disrupt boot — important now that the list is multi-guild.
        try {
          await rest.put(
            Routes.applicationGuildCommands(appId, guildId),
            { body }
          );
          this.logger.info({ guildId }, "registered guild slash commands");
        } catch (err) {
          this.logger.warn(
            { err, guildId },
            "failed to register guild slash commands — is the bot a member of this guild? skipping; other guilds unaffected"
          );
        }
      }
    } else {
      await rest.put(Routes.applicationCommands(appId), { body });
      this.logger.info("registered global slash commands");
    }
  }
}

function buttonStyleForKind(kind: string): ButtonStyle {
  switch (kind) {
    case "allow_always":
      return ButtonStyle.Success;
    case "allow_once":
      return ButtonStyle.Primary;
    case "reject_always":
      return ButtonStyle.Danger;
    case "reject_once":
    default:
      return ButtonStyle.Secondary;
  }
}

function buttonEmojiForKind(kind: string): string {
  switch (kind) {
    case "allow_always":
      return "✅";
    case "allow_once":
      return "👍";
    case "reject_always":
      return "🛑";
    case "reject_once":
    default:
      return "✋";
  }
}

function decisionEmoji(kind: string): string {
  return kind.startsWith("allow_") ? "✅" : "🚫";
}
