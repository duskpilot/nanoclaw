import path from 'path';

import { readEnvByPrefix, readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ONLY',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Telegram configuration
export const TELEGRAM_ONLY =
  (process.env.TELEGRAM_ONLY || envConfig.TELEGRAM_ONLY) === 'true';

// Multi-bot: scan for TELEGRAM_BOT_<Name>=<token> in .env
// Falls back to single TELEGRAM_BOT_TOKEN + ASSISTANT_NAME
export interface TelegramBotConfig {
  name: string;
  token: string;
}

function parseTelegramBots(): TelegramBotConfig[] {
  const bots: TelegramBotConfig[] = [];

  // Scan for TELEGRAM_BOT_<Name> keys (exclude TELEGRAM_BOT_TOKEN for backward compat)
  const botEntries = readEnvByPrefix('TELEGRAM_BOT_');
  for (const [key, token] of Object.entries(botEntries)) {
    if (key === 'TELEGRAM_BOT_TOKEN') continue;
    const name = key.replace('TELEGRAM_BOT_', '');
    if (name && token) bots.push({ name, token });
  }

  if (bots.length > 0) return bots;

  // Fallback: single bot via TELEGRAM_BOT_TOKEN
  const singleToken =
    process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';
  if (singleToken) {
    bots.push({ name: ASSISTANT_NAME, token: singleToken });
  }

  return bots;
}

export const TELEGRAM_BOTS = parseTelegramBots();

// Legacy single-token export for backward compat
export const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';

// Trigger pattern matches any configured bot name
const allNames = new Set([ASSISTANT_NAME, ...TELEGRAM_BOTS.map((b) => b.name)]);
const namePattern = [...allNames].map(escapeRegex).join('|');

export const TRIGGER_PATTERN = new RegExp(
  `^@(${namePattern})\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
