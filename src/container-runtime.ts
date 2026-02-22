/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

const RUNTIME_MAX_RETRIES = 6;
const RUNTIME_RETRY_INTERVAL_MS = 5000;

/** Ensure the container runtime is running, retrying if it's not ready yet. */
export function ensureContainerRuntimeRunning(): void {
  for (let attempt = 1; attempt <= RUNTIME_MAX_RETRIES; attempt++) {
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} info`, { stdio: 'pipe', timeout: 10000 });
      logger.debug('Container runtime already running');
      return;
    } catch (err) {
      if (attempt < RUNTIME_MAX_RETRIES) {
        logger.warn(
          { attempt, maxRetries: RUNTIME_MAX_RETRIES },
          `Container runtime not ready, retrying in ${RUNTIME_RETRY_INTERVAL_MS / 1000}s...`,
        );
        const waitUntil = Date.now() + RUNTIME_RETRY_INTERVAL_MS;
        while (Date.now() < waitUntil) {
          // Synchronous sleep — acceptable at startup before any channels connect
        }
      } else {
        logger.error({ err }, 'Failed to reach container runtime after retries');
        console.error(
          '\n╔════════════════════════════════════════════════════════════════╗',
        );
        console.error(
          '║  FATAL: Container runtime failed to start                      ║',
        );
        console.error(
          '║                                                                ║',
        );
        console.error(
          '║  Agents cannot run without a container runtime. To fix:        ║',
        );
        console.error(
          '║  1. Ensure Docker is installed and running                     ║',
        );
        console.error(
          '║  2. Run: docker info                                           ║',
        );
        console.error(
          '║  3. Restart NanoClaw                                           ║',
        );
        console.error(
          '╚════════════════════════════════════════════════════════════════╝\n',
        );
        throw new Error('Container runtime is required but failed to start');
      }
    }
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
