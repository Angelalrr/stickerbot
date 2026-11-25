import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const TEMP_PREFIX = 'stickerbot-';

export class ConcurrencyQueue {
  maxConcurrency: number;
  activeCount: number;
  waiting: Array<() => void>;

  constructor(maxConcurrency = 1) {
    this.maxConcurrency = Math.max(1, maxConcurrency);
    this.activeCount = 0;
    this.waiting = [];
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.maxConcurrency) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }
    this.activeCount += 1;
    try {
      return await task();
    } finally {
      this.activeCount -= 1;
      const next = this.waiting.shift();
      if (next) {
        next();
      }
    }
  }

  stats(): { active: number; queued: number; maxConcurrency: number } {
    return {
      active: this.activeCount,
      queued: this.waiting.length,
      maxConcurrency: this.maxConcurrency,
    };
  }
}

// Cola global con concurrencia 1 para proteger la RAM (512 MB en Render Free) durante FFmpeg
export const videoProcessingQueue = new ConcurrencyQueue(1);

export function createTempJobPath(prefix: string, extension: string): string {
  const safePrefix = prefix.replace(/[^a-z0-9_-]/gi, '') || 'job';
  const safeExt = extension.replace(/[^a-z0-9]/gi, '') || 'bin';
  const filename = `${TEMP_PREFIX}${safePrefix}-${crypto.randomUUID()}.${safeExt}`;
  return path.join(os.tmpdir(), filename);
}

export async function removeTempFiles(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {}))
  );
}

/**
 * Elimina archivos temporales huerfanos de StickerBot en os.tmpdir() mas antiguos que maxAgeMs.
 */
export async function sweepOrphanedTempFiles(
  maxAgeMs = 10 * 60 * 1000,
  targetDir = os.tmpdir()
): Promise<number> {
  let deleted = 0;
  const now = Date.now();
  try {
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(TEMP_PREFIX)) continue;
      const fullPath = path.join(targetDir, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        if (now - stat.mtimeMs >= maxAgeMs) {
          await fs.rm(fullPath, { force: true });
          deleted += 1;
        }
      } catch {
        // Ignorar archivos eliminados concurrentemente
      }
    }
  } catch {
    // Ignorar errores de lectura de tmpdir
  }
  return deleted;
}

export function startTempCleanupScheduler(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void sweepOrphanedTempFiles();
  }, 10 * 60 * 1000);
  timer.unref();
  return timer;
}
