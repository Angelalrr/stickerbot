import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, '..');

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveSessionSecret(): string {
  const fromEnv = (process.env.SESSION_SECRET || '').trim();
  if (fromEnv.length >= 16) return fromEnv;
  return crypto.randomBytes(32).toString('hex');
}

export const config = Object.freeze({
  port: parsePositiveNumber(process.env.PORT, 3000),
  mongodbUri: (process.env.MONGODB_URI || '').trim(),
  sessionSecret: resolveSessionSecret(),

  botName: (process.env.BOT_NAME || 'StickerBot').trim() || 'StickerBot',
  botVersion: '2.0.0',
  commandPrefix: '/',
  stickerPack: (process.env.STICKER_PACK || 'StickerBot Pack').trim() || 'StickerBot Pack',
  stickerAuthor: (process.env.STICKER_AUTHOR || 'StickerBot').trim() || 'StickerBot',

  maxImageBytes: parsePositiveNumber(process.env.MAX_IMAGE_MB, 10) * 1024 * 1024,
  maxVideoBytes: parsePositiveNumber(process.env.MAX_VIDEO_MB, 20) * 1024 * 1024,
  // WhatsApp permite stickers animados de hasta 10 segundos
  maxVideoSeconds: parsePositiveNumber(process.env.MAX_VIDEO_SECONDS, 10),
  maxStickerBytes: parsePositiveNumber(process.env.MAX_STICKER_KB, 500) * 1024,
  audioKbps: parsePositiveNumber(process.env.AUDIO_KBPS, 32),
  audioLeadMs: Number.isFinite(Number(process.env.AUDIO_LEAD_MS))
    ? Math.max(0, Math.min(2000, Number(process.env.AUDIO_LEAD_MS)))
    : 100,

  logLevel: (process.env.LOG_LEVEL || 'info').trim().toLowerCase(),
  benchDownloaderUrl: (process.env.BENCH_DOWNLOADER_URL || '').trim(),
  dataDir: path.join(ROOT_DIR, 'data'),
});

export interface SystemCapabilities {
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  mongodbConfigured: boolean;
  dbMode: 'mongodb' | 'local';
}

function probeBinary(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(bin, args, { windowsHide: true, shell: false });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(false);
      }, 4000);
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  });
}

let cachedBinaryProbe: { ffmpeg: boolean; ffprobe: boolean; checkedAt: number } | null = null;

export async function checkFfmpegAvailable(): Promise<boolean> {
  if (cachedBinaryProbe && Date.now() - cachedBinaryProbe.checkedAt < 60_000) {
    return cachedBinaryProbe.ffmpeg;
  }
  const [ffmpeg, ffprobe] = await Promise.all([
    probeBinary('ffmpeg', ['-version']),
    probeBinary('ffprobe', ['-version']),
  ]);
  cachedBinaryProbe = { ffmpeg, ffprobe, checkedAt: Date.now() };
  return ffmpeg;
}

export async function getSystemCapabilities(dbMode: 'mongodb' | 'local'): Promise<SystemCapabilities> {
  const [ffmpegAvailable, ffprobeAvailable] = await Promise.all([
    probeBinary('ffmpeg', ['-version']),
    probeBinary('ffprobe', ['-version']),
  ]);
  cachedBinaryProbe = { ffmpeg: ffmpegAvailable, ffprobe: ffprobeAvailable, checkedAt: Date.now() };
  return {
    ffmpegAvailable,
    ffprobeAvailable,
    mongodbConfigured: Boolean(config.mongodbUri),
    dbMode,
  };
}
