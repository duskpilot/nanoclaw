import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { WAMessage, WASocket } from '@whiskeysockets/baileys';

import { readEnvFile } from './env.js';

interface TranscriptionConfig {
  model: string;
  enabled: boolean;
  fallbackMessage: string;
}

const DEFAULT_CONFIG: TranscriptionConfig = {
  model: process.env.WHISPER_MODEL || 'whisper-large-v3-turbo',
  enabled: true,
  fallbackMessage: '[Voice Message - transcription unavailable]',
};

// Lazy singleton — initialized once on first use
let clientCache: { client: any; toFile: any } | null = null;

async function getClient(): Promise<{ client: any; toFile: any } | null> {
  if (clientCache) return clientCache;

  const env = readEnvFile(['GROQ_API_KEY', 'OPENAI_API_KEY']);
  const apiKey = env.GROQ_API_KEY || env.OPENAI_API_KEY;

  if (!apiKey) {
    console.warn('GROQ_API_KEY or OPENAI_API_KEY not set in .env');
    return null;
  }

  const baseURL = env.GROQ_API_KEY
    ? 'https://api.groq.com/openai/v1'
    : undefined;

  const openaiModule = await import('openai');
  const OpenAI = openaiModule.default;

  clientCache = {
    client: new OpenAI({ apiKey, baseURL }),
    toFile: openaiModule.toFile,
  };

  return clientCache;
}

async function transcribeWithOpenAI(
  audioBuffer: Buffer,
  config: TranscriptionConfig,
): Promise<string | null> {
  const cached = await getClient();
  if (!cached) return null;

  try {
    const file = await cached.toFile(audioBuffer, 'voice.ogg', {
      type: 'audio/ogg',
    });

    const transcription = await cached.client.audio.transcriptions.create({
      file,
      model: config.model,
      response_format: 'text',
    });

    // When response_format is 'text', the API returns a plain string
    return transcription as unknown as string;
  } catch (err) {
    console.error('OpenAI transcription failed:', err);
    return null;
  }
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  const config = DEFAULT_CONFIG;

  if (!config.enabled) {
    return config.fallbackMessage;
  }

  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      console.error('Failed to download audio message');
      return config.fallbackMessage;
    }

    console.log(`Downloaded audio message: ${buffer.length} bytes`);

    const transcript = await transcribeWithOpenAI(buffer, config);

    if (!transcript) {
      return config.fallbackMessage;
    }

    return transcript.trim();
  } catch (err) {
    console.error('Transcription error:', err);
    return config.fallbackMessage;
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}

export async function transcribeAudioBuffer(
  audioBuffer: Buffer,
): Promise<string | null> {
  const config = DEFAULT_CONFIG;

  if (!config.enabled) {
    return null;
  }

  try {
    if (!audioBuffer || audioBuffer.length === 0) {
      console.error('Invalid audio buffer');
      return null;
    }

    console.log(`Transcribing audio buffer: ${audioBuffer.length} bytes`);

    const transcript = await transcribeWithOpenAI(audioBuffer, config);

    if (!transcript) {
      return null;
    }

    return transcript.trim();
  } catch (err) {
    console.error('Transcription error:', err);
    return null;
  }
}
