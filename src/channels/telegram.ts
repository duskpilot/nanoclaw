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

/**
 * Convert standard Markdown to Telegram-compatible HTML.
 * HTML only requires escaping <, >, & — far more robust than MarkdownV2.
 */
export function markdownToTelegramHtml(md: string): string {
  // 1. Extract fenced code blocks and inline code → placeholders
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // Fenced code blocks first (``` ... ```)
  let text = md.replace(/```(?:\w*)\n?([\s\S]*?)```/g, (_match, code) => {
    const i = codeBlocks.length;
    codeBlocks.push(code.replace(/\n$/, ''));
    return `\x00CODEBLOCK${i}\x00`;
  });

  // Inline code (` ... `)
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    const i = inlineCodes.length;
    inlineCodes.push(code);
    return `\x00INLINE${i}\x00`;
  });

  // 2. HTML-escape remaining text
  text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 3. Convert formatting constructs
  // Bold: **text** (process before italic)
  text = text.replace(/\*\*([^\n*]+)\*\*/g, '<b>$1</b>');
  // Italic: *text* — require non-space after opening * to avoid bullet lists
  text = text.replace(/\*([^\n*]+)\*/g, '<i>$1</i>');
  // Strikethrough: ~~text~~
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');
  // Links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 4. Re-insert code with HTML escaping
  text = text.replace(/\x00INLINE(\d+)\x00/g, (_match, i) => {
    const code = inlineCodes[parseInt(i)]
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<code>${code}</code>`;
  });

  text = text.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, i) => {
    const code = codeBlocks[parseInt(i)]
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<pre>${code}</pre>`;
  });

  return text;
}

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
  private botUserId: number | null = null;
  private botUsername: string | null = null;

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
        `Chat ID: tg:${this.assistantName}:${chatId}\nName: ${chatName}\nType: ${chatType}`,
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

      // RECIPIENT DETECTION: Check if this message is intended for THIS bot
      let isIntendedForThisBot = false;

      // Check if message is a reply to this bot's message
      if (ctx.message.reply_to_message) {
        const replyToUserId = ctx.message.reply_to_message.from?.id;
        if (replyToUserId === this.botUserId) {
          isIntendedForThisBot = true;
          logger.debug(
            { chatJid, botName: this.assistantName },
            'Message is reply to this bot',
          );
        }
      }

      // Check if message mentions this bot specifically
      const botUsername = this.botUsername || ctx.me?.username?.toLowerCase();
      if (!isIntendedForThisBot && botUsername) {
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
        if (isBotMentioned) {
          isIntendedForThisBot = true;
          logger.debug(
            { chatJid, botName: this.assistantName },
            'Message mentions this bot',
          );
          // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${this.assistantName} ${content}`;
          }
        }
      }

      // Check if message contains trigger word (for groups with requiresTrigger)
      if (!isIntendedForThisBot && group.requiresTrigger !== false) {
        // Extract the trigger pattern for this specific bot
        const triggerMatch = content.match(TRIGGER_PATTERN);
        if (triggerMatch) {
          const mentionedName = triggerMatch[1].toLowerCase();
          const thisAssistantName = this.assistantName.toLowerCase();
          if (mentionedName === thisAssistantName) {
            isIntendedForThisBot = true;
            logger.debug(
              { chatJid, botName: this.assistantName, trigger: mentionedName },
              'Message contains this bot\'s trigger',
            );
          }
        }
      }

      // For chats with requiresTrigger: false, check if any specific bot is mentioned
      // If another bot is mentioned, skip processing for this bot
      if (!isIntendedForThisBot && group.requiresTrigger === false) {
        // Check if ANY bot is mentioned via @username
        const entities = ctx.message.entities || [];
        const mentionedBotUsername = entities.find((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            // Check if it's a bot mention (starts with @)
            return mentionText.startsWith('@') && mentionText.includes('bot');
          }
          return false;
        });

        // Check if ANY trigger pattern is present in the message
        const triggerMatch = content.match(TRIGGER_PATTERN);

        if (mentionedBotUsername || triggerMatch) {
          // A specific bot was mentioned - check if it's this one
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
            if (isBotMentioned) {
              isIntendedForThisBot = true;
            }
          }

          if (triggerMatch) {
            const mentionedName = triggerMatch[1].toLowerCase();
            const thisAssistantName = this.assistantName.toLowerCase();
            if (mentionedName === thisAssistantName) {
              isIntendedForThisBot = true;
            }
          }

          // If a specific bot was mentioned but it wasn't this one, skip
          if (!isIntendedForThisBot) {
            logger.debug(
              { chatJid, botName: this.assistantName },
              'Message intended for different bot, skipping',
            );
            return;
          }
        } else {
          // No specific bot mentioned and requiresTrigger is false
          // This is a general message - all bots should process it
          isIntendedForThisBot = true;
          logger.debug(
            { chatJid, botName: this.assistantName },
            'No specific bot mentioned, processing as general message',
          );
        }
      }

      // If not intended for this bot, skip processing
      if (!isIntendedForThisBot) {
        logger.debug(
          { chatJid, botName: this.assistantName },
          'Message not intended for this bot, skipping',
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
        { chatJid, chatName, sender: senderName, botName: this.assistantName },
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
          // Store bot's own user ID and username for recipient detection
          this.botUserId = botInfo.id;
          this.botUsername = botInfo.username?.toLowerCase() || null;

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

      // Chunk plain text at 3800 chars (leaves room for HTML tag overhead within 4096 limit)
      const chunks = this.chunkByParagraph(text, 3800);

      for (const chunk of chunks) {
        const html = markdownToTelegramHtml(chunk);
        try {
          await this.bot.api.sendMessage(numericId, html, { parse_mode: 'HTML' });
        } catch (htmlErr: any) {
          // Fallback: if HTML send fails (400 error), retry as plain text
          if (htmlErr?.error_code === 400) {
            logger.warn({ jid }, 'HTML send failed, falling back to plain text');
            await this.bot.api.sendMessage(numericId, chunk);
          } else {
            throw htmlErr;
          }
        }
      }
      logger.info({ jid, length: text.length, chunks: chunks.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  /**
   * Smart paragraph-aware chunking for better readability
   */
  private chunkByParagraph(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    const paragraphs = text.split(/\n\n+/);

    let currentChunk = '';
    for (const para of paragraphs) {
      if (currentChunk.length + para.length + 2 <= maxLength) {
        currentChunk += (currentChunk ? '\n\n' : '') + para;
      } else {
        if (currentChunk) chunks.push(currentChunk);
        if (para.length > maxLength) {
          // Paragraph too long, split by sentences or just hard-split
          let remaining = para;
          while (remaining.length > 0) {
            chunks.push(remaining.slice(0, maxLength));
            remaining = remaining.slice(maxLength);
          }
          currentChunk = '';
        } else {
          currentChunk = para;
        }
      }
    }
    if (currentChunk) chunks.push(currentChunk);
    return chunks;
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
