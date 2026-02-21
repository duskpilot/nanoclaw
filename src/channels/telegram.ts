import { Bot } from 'grammy';

import { TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { transcribeAudioBuffer } from '../transcription.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private assistantName: string;
  private typingIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();
  private knownChats: Set<string> = new Set();

  constructor(botToken: string, assistantName: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.assistantName = assistantName;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${this.assistantName}:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${this.assistantName} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${this.assistantName}:${ctx.chat.id}`;
      this.knownChats.add(chatJid);
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${this.assistantName} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${this.assistantName}:${ctx.chat.id}`;
      this.knownChats.add(chatJid);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${this.assistantName}:${ctx.chat.id}`;
      this.knownChats.add(chatJid);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';

      try {
        // Get the highest resolution photo
        const photos = ctx.message.photo;
        const photo = photos[photos.length - 1];

        // Download the photo
        const file = await ctx.getFile();
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

        // Download the image
        const response = await fetch(fileUrl);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Convert to base64 for Claude
        const base64Image = buffer.toString('base64');
        const mediaType = file.file_path?.endsWith('.png') ? 'image/png' : 'image/jpeg';

        const caption = ctx.message.caption || '';
        const content = caption
          ? `[Image] ${caption}\n\n<image data="${mediaType};base64,${base64Image}" />`
          : `<image data="${mediaType};base64,${base64Image}" />`;

        this.opts.onChatMetadata(chatJid, timestamp);
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });

        logger.info({ chatJid, size: buffer.length }, 'Telegram photo processed');
      } catch (err) {
        logger.error({ err }, 'Failed to process Telegram photo');
        storeNonText(ctx, '[Photo]');
      }
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${this.assistantName}:${ctx.chat.id}`;
      this.knownChats.add(chatJid);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';

      try {
        // Download voice message
        const file = await ctx.getFile();
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

        // Download the audio file
        const response = await fetch(fileUrl);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Transcribe it
        const transcript = await transcribeAudioBuffer(buffer);

        const content = transcript
          ? `[Voice: ${transcript}]`
          : '[Voice message - transcription unavailable]';

        this.opts.onChatMetadata(chatJid, timestamp);
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });

        logger.info({ chatJid, transcriptLength: transcript?.length }, 'Telegram voice message transcribed');
      } catch (err) {
        logger.error({ err }, 'Failed to transcribe Telegram voice message');
        storeNonText(ctx, '[Voice message]');
      }
    });
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id, assistantName: this.assistantName },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username} (${this.assistantName})`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      // Clear typing indicator before sending
      await this.setTyping(jid, false);

      const numericId = jid.replace(/^tg:[^:]+:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      const chunks =
        text.length <= MAX_LENGTH
          ? [text]
          : Array.from({ length: Math.ceil(text.length / MAX_LENGTH) }, (_, i) =>
              text.slice(i * MAX_LENGTH, (i + 1) * MAX_LENGTH),
            );

      for (const chunk of chunks) {
        try {
          await this.bot.api.sendMessage(numericId, chunk, {
            parse_mode: 'Markdown',
          });
        } catch {
          // Markdown parse failed (unbalanced chars etc.) — send as plain text
          await this.bot.api.sendMessage(numericId, chunk);
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(`tg:${this.assistantName}:`);
  }

  async disconnect(): Promise<void> {
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info({ assistantName: this.assistantName }, 'Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot) return;

    if (!isTyping) {
      const existing = this.typingIntervals.get(jid);
      if (existing) {
        clearInterval(existing);
        this.typingIntervals.delete(jid);
      }
      return;
    }

    // Already running for this chat
    if (this.typingIntervals.has(jid)) return;

    const numericId = jid.replace(/^tg:[^:]+:/, '');

    const send = async () => {
      try {
        await this.bot?.api.sendChatAction(numericId, 'typing');
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
      }
    };

    // Send immediately, then repeat every 4s (Telegram shows it for ~5s)
    await send();
    this.typingIntervals.set(jid, setInterval(send, 4000));
  }
}
