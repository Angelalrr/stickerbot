import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import webpmux from 'node-webpmux';
import {
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  proto,
} from '@whiskeysockets/baileys';
import { checkFfmpegAvailable, config } from '../config.ts';
import {
  buildVideoScaleFilter,
  escapeXml,
  parseTextStickerArgs,
  type VideoCropMode,
  parseStartTime,
  extractStartTimeFromArgs,
  parseUrlAndStartTime,
  validateUrlAntiSsrf,
} from './validation.ts';
import {
  attachAudioToSticker,
  detachAudioFromSticker,
  getEmbeddedAudioSize,
  installStickerAudioPatch,
} from './stickerAudioPatch.ts';
import {
  createTempJobPath,
  removeTempFiles,
  videoProcessingQueue,
  TEMP_PREFIX,
} from './mediaQueue.ts';

const { Image } = webpmux;
const STICKER_SIZE = 512;
const STATIC_TARGET_BYTES = 100 * 1024;
export const AUDIO_MIMETYPE = 'audio/ogg; codecs=opus';

export async function addStickerExif(
  webpBuffer: Buffer,
  options: { packName?: string; authorName?: string; emojis?: string[] } = {}
): Promise<Buffer> {
  const {
    packName = 'StickerBot Pack',
    authorName = 'StickerBot',
    emojis = ['✨'],
  } = options;

  const img = new Image();
  await img.load(webpBuffer);

  const payload = {
    'sticker-pack-id': crypto.createHash('md5').update(`${packName}:${authorName}`).digest('hex'),
    'sticker-pack-name': String(packName).slice(0, 64),
    'sticker-pack-publisher': String(authorName).slice(0, 64),
    emojis: Array.isArray(emojis) && emojis.length > 0 ? emojis : ['✨'],
  };

  const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf8');
  const exifHeader = Buffer.from([
    0x49, 0x49, 0x2a, 0x00,
    0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00,
    0x00, 0x00,
  ]);
  exifHeader.writeUIntLE(jsonBuffer.length, 14, 4);

  img.exif = Buffer.concat([exifHeader, jsonBuffer]);
  const result = await img.save(null);
  return Buffer.isBuffer(result) ? result : Buffer.from(result);
}

/**
 * Fotos (/sticker y /s): mantiene exactamente el ajuste `contain` transparente sin recortar.
 */
export async function imageToStickerWebp(
  inputBuffer: Buffer,
  options: { packName?: string; authorName?: string; maxBytes?: number } = {}
): Promise<{ buffer: Buffer; width: number; height: number; sizeBytes: number }> {
  const {
    packName = 'StickerBot Pack',
    authorName = 'StickerBot',
    maxBytes = 500 * 1024,
  } = options;

  const targetLimit = Math.min(maxBytes, STATIC_TARGET_BYTES);
  const qualities = [85, 70, 55, 40, 28];
  let bestBuffer: Buffer | null = null;

  for (const quality of qualities) {
    const rawWebp = await sharp(inputBuffer, {
      failOn: 'none',
      limitInputPixels: 268402689,
    })
      .rotate()
      .resize(STICKER_SIZE, STICKER_SIZE, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({
        quality,
        effort: 4,
        alphaQuality: Math.max(quality, 60),
      })
      .toBuffer();

    bestBuffer = rawWebp;
    if (rawWebp.length <= targetLimit) break;
  }

  if (!bestBuffer || bestBuffer.length > maxBytes) {
    bestBuffer = await sharp(inputBuffer, {
      failOn: 'none',
      limitInputPixels: 268402689,
    })
      .rotate()
      .resize(STICKER_SIZE, STICKER_SIZE, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality: 20, effort: 6, alphaQuality: 45 })
      .toBuffer();
  }

  const finalSticker = await addStickerExif(bestBuffer, {
    packName,
    authorName,
    emojis: ['🖼️'],
  });

  return {
    buffer: finalSticker,
    width: STICKER_SIZE,
    height: STICKER_SIZE,
    sizeBytes: finalSticker.length,
  };
}

export function wrapStickerText(text: string, maxCharsPerLine = 13): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (word.length > maxCharsPerLine) {
      if (currentLine) {
        lines.push(currentLine);
        currentLine = '';
      }
      for (let i = 0; i < word.length; i += maxCharsPerLine) {
        lines.push(word.slice(i, i + maxCharsPerLine));
      }
      continue;
    }

    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (candidate.length <= maxCharsPerLine) {
      currentLine = candidate;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines.slice(0, 6);
}

export function buildTextStickerSvg(rawArgs: string): {
  svg: string;
  text: string;
  fillColor: string;
  lines: string[];
} {
  const { text, fillColor, strokeColor } = parseTextStickerArgs(rawArgs);
  const cleanText = text.slice(0, 90).trim();

  if (!cleanText) {
    throw new Error('Debes escribir un texto después de /stickertexto. Ejemplo: /stickertexto Hola mundo');
  }

  const maxChars = cleanText.length <= 14 ? 9 : cleanText.length <= 36 ? 12 : 16;
  const lines = wrapStickerText(cleanText, maxChars);
  const longestLine = Math.max(...lines.map((l) => Array.from(l).length), 1);

  const widthBasedSize = Math.floor(430 / Math.max(longestLine * 0.62, 1));
  const heightBasedSize = Math.floor(420 / Math.max(lines.length * 1.18, 1));
  const fontSize = Math.max(30, Math.min(110, widthBasedSize, heightBasedSize));

  const lineHeight = Math.round(fontSize * 1.16);
  const strokeWidth = Math.max(6, Math.round(fontSize * 0.14));
  const totalHeight = lineHeight * lines.length;
  const firstBaselineY = Math.round((STICKER_SIZE - totalHeight) / 2 + fontSize * 0.84);

  const tspanElements = lines
    .map((line, index) => {
      const y = firstBaselineY + index * lineHeight;
      return `<text x="256" y="${y}" text-anchor="middle" font-family="DejaVu Sans, Segoe UI, Arial, sans-serif" font-weight="800" font-size="${fontSize}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-linejoin="round" paint-order="stroke fill" filter="url(#stickerShadow)">${escapeXml(line)}</text>`;
    })
    .join('\n  ');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${STICKER_SIZE}" height="${STICKER_SIZE}" viewBox="0 0 ${STICKER_SIZE} ${STICKER_SIZE}">
  <defs>
    <filter id="stickerShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="5" stdDeviation="4" flood-color="#000000" flood-opacity="0.55" />
    </filter>
  </defs>
  ${tspanElements}
</svg>`;

  return { svg, text: cleanText, fillColor, lines };
}

export async function textToStickerWebp(
  rawArgs: string,
  options: { packName?: string; authorName?: string } = {}
): Promise<{ buffer: Buffer; text: string; fillColor: string; sizeBytes: number }> {
  const { packName = 'StickerBot Pack', authorName = 'StickerBot' } = options;
  const { svg, text, fillColor } = buildTextStickerSvg(rawArgs);

  const webpBuffer = await sharp(Buffer.from(svg, 'utf8'))
    .resize(STICKER_SIZE, STICKER_SIZE)
    .webp({ quality: 90, effort: 4, alphaQuality: 100 })
    .toBuffer();

  const finalSticker = await addStickerExif(webpBuffer, {
    packName,
    authorName,
    emojis: ['💬'],
  });

  return {
    buffer: finalSticker,
    text,
    fillColor,
    sizeBytes: finalSticker.length,
  };
}

export function runProcess(
  bin: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  const { signal, timeoutMs = 45000 } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('OPERACION_CANCELADA'));
      return;
    }

    const child = spawn(bin, args, { windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error('Tiempo de espera agotado al procesar con FFmpeg.'));
      }
    }, timeoutMs);

    const onAbort = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(new Error('OPERACION_CANCELADA'));
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`FFmpeg finalizó con código ${code}: ${stderr.slice(-300)}`));
      }
    });
  });
}

export function runProcessBuffer(
  bin: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<{ stdout: Buffer; stderr: string }> {
  const { signal, timeoutMs = 30000 } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('OPERACION_CANCELADA'));
      return;
    }

    const child = spawn(bin, args, { windowsHide: true, shell: false });
    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error('Tiempo de espera agotado al procesar con FFmpeg.'));
      }
    }, timeoutMs);

    const onAbort = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(new Error('OPERACION_CANCELADA'));
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdoutChunks), stderr });
      } else {
        reject(new Error(`FFmpeg finalizó con código ${code}: ${stderr.slice(-300)}`));
      }
    });
  });
}

export function parseWebpInfo(buffer: Buffer): {
  width: number | null;
  height: number | null;
  animated: boolean;
  frames: number;
  durationMs: number;
  duration: number;
} | null {
  if (!buffer || buffer.length < 12) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }

  const info = {
    width: null as number | null,
    height: null as number | null,
    animated: false,
    frames: 0,
    durationMs: 0,
    duration: 0,
  };

  let position = 12;
  while (position + 8 <= buffer.length) {
    const type = buffer.toString('ascii', position, position + 4);
    const size = buffer.readUInt32LE(position + 4);
    const data = position + 8;

    if (type === 'VP8X' && data + 10 <= buffer.length) {
      info.animated = Boolean(buffer[data] & 0x02);
      info.width = 1 + buffer.readUIntLE(data + 4, 3);
      info.height = 1 + buffer.readUIntLE(data + 7, 3);
    } else if (type === 'ANMF' && data + 15 <= buffer.length) {
      info.frames += 1;
      info.durationMs += buffer.readUIntLE(data + 12, 3);
    }

    position = data + size + (size & 1);
  }

  info.duration = info.durationMs / 1000;
  return info;
}

export async function probeVideoBuffer(
  inputBuffer: Buffer,
  options: { extension?: string; signal?: AbortSignal } = {}
): Promise<{ duration: number | null; hasAudio: boolean }> {
  const inputPath = createTempJobPath('probe', options.extension || 'mp4');
  try {
    await fs.writeFile(inputPath, inputBuffer);
    const { stdout } = await runProcess(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_type',
        '-of',
        'json',
        inputPath,
      ],
      { signal: options.signal, timeoutMs: 10000 }
    );

    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string }>;
    };
    const duration = Number(parsed?.format?.duration);
    const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
    const hasAudio = streams.some((s) => s.codec_type === 'audio');

    return {
      duration: Number.isFinite(duration) && duration > 0 ? duration : null,
      hasAudio,
    };
  } catch (err) {
    if (err instanceof Error && err.message === 'OPERACION_CANCELADA') {
      throw err;
    }
    return { duration: null, hasAudio: true };
  } finally {
    await removeTempFiles([inputPath]);
  }
}

export async function videoToAnimatedStickerWebp(
  inputBuffer: Buffer,
  options: {
    extension?: string;
    maxSeconds?: number;
    maxBytes?: number;
    packName?: string;
    authorName?: string;
    cropMode?: VideoCropMode;
    trimStart?: number;
    trimDuration?: number;
    signal?: AbortSignal;
  } = {}
): Promise<{
  buffer: Buffer;
  sizeBytes: number;
  fpsUsed: number;
  qualityUsed: number;
  durationMs: number;
  duration: number;
  frames: number;
}> {
  const {
    extension = 'mp4',
    maxSeconds = 10,
    maxBytes = 500 * 1024,
    packName = 'StickerBot Pack',
    authorName = 'StickerBot',
    cropMode = 'crop',
    trimStart = 0,
    trimDuration,
    signal,
  } = options;

  const hasFfmpeg = await checkFfmpegAvailable();
  if (!hasFfmpeg) {
    throw new Error(
      'FFmpeg no está instalado en este servidor. Despliega con el Dockerfile en Render para activar stickers animados.'
    );
  }

  return videoProcessingQueue.run(async () => {
    const inputPath = createTempJobPath('vidin', extension);
    const outputPath = createTempJobPath('vidout', 'webp');

    // Ventana temporal pedida desde el creador web (o el video completo por defecto)
    const baseDuration = Math.max(
      0.5,
      Math.min(trimDuration && trimDuration > 0 ? trimDuration : maxSeconds, maxSeconds)
    );
    const seekSeconds = trimStart > 0.01 ? trimStart.toFixed(3) : null;

    const presets = [
      { fps: 15, quality: 55, duration: baseDuration, size: 512 },
      { fps: 12, quality: 40, duration: Math.min(baseDuration, 6), size: 512 },
      { fps: 10, quality: 28, duration: Math.min(baseDuration, 5), size: 512 },
      { fps: 8, quality: 20, duration: Math.min(baseDuration, 4), size: 384 },
    ];

    try {
      await fs.writeFile(inputPath, inputBuffer);

      for (const preset of presets) {
        if (signal?.aborted) {
          throw new Error('OPERACION_CANCELADA');
        }

        const scaleFilter = buildVideoScaleFilter(preset.fps, preset.size, cropMode);

        await runProcess(
          'ffmpeg',
          [
            '-y',
            ...(seekSeconds ? ['-ss', seekSeconds] : []),
            '-i',
            inputPath,
            '-t',
            String(preset.duration),
            '-vf',
            scaleFilter,
            '-vcodec',
            'libwebp',
            '-lossless',
            '0',
            '-compression_level',
            '4',
            '-q:v',
            String(preset.quality),
            '-loop',
            '0',
            '-preset',
            'default',
            '-an',
            outputPath,
          ],
          { signal, timeoutMs: 45000 }
        );

        const rawWebp = await fs.readFile(outputPath);
        if (rawWebp.length <= maxBytes) {
          const finalSticker = await addStickerExif(rawWebp, {
            packName,
            authorName,
            emojis: ['🎞️'],
          });

          if (finalSticker.length <= maxBytes) {
            const webpInfo = parseWebpInfo(finalSticker);
            return {
              buffer: finalSticker,
              sizeBytes: finalSticker.length,
              fpsUsed: preset.fps,
              qualityUsed: preset.quality,
              durationMs: webpInfo?.durationMs ?? preset.duration * 1000,
              duration: webpInfo?.duration ?? preset.duration,
              frames: webpInfo?.frames ?? 0,
            };
          }
        }
      }

      throw new Error(
        `El video supera el peso máximo de ${Math.round(maxBytes / 1024)} KB incluso tras comprimirlo. Prueba con un clip más corto (3 a 5 segundos).`
      );
    } finally {
      await removeTempFiles([inputPath, outputPath]);
    }
  });
}

export function waveformFromPcm(pcm: Buffer, bars = 64): Uint8Array {
  const samples = Math.floor(pcm.length / 2);
  const levels = new Array<number>(bars).fill(0);
  if (samples === 0) return Uint8Array.from(levels);

  const perBar = Math.max(1, Math.floor(samples / bars));
  for (let bar = 0; bar < bars; bar++) {
    const from = bar * perBar;
    const to = Math.min(samples, from + perBar);
    let sum = 0;
    for (let i = from; i < to; i++) {
      sum += Math.abs(pcm.readInt16LE(i * 2));
    }
    levels[bar] = to > from ? sum / (to - from) : 0;
  }

  const peak = Math.max(...levels) || 1;
  return Uint8Array.from(levels.map((v) => Math.round((v / peak) * 100)));
}

export async function extractSynchronizedAudio(options: {
  inputBuffer: Buffer;
  extension?: string;
  targetDuration: number;
  kbps?: number;
  leadMs?: number;
  startOffsetMs?: number;
  signal?: AbortSignal;
}): Promise<{ buffer: Buffer; waveform: Uint8Array; mimetype: string; sizeBytes: number } | null> {
  const {
    inputBuffer,
    extension = 'mp4',
    targetDuration,
    kbps = 32,
    leadMs = 100,
    startOffsetMs = 0,
    signal,
  } = options;

  const hasFfmpeg = await checkFfmpegAvailable();
  if (!hasFfmpeg) {
    throw new Error('FFmpeg no está disponible en este entorno para extraer el audio.');
  }

  return videoProcessingQueue.run(async () => {
    const inputPath = createTempJobPath('audin', extension);
    const wavPath = createTempJobPath('audwav', 'wav');
    const oggPath = createTempJobPath('audout', 'ogg');
    const durationSec = Math.max(0.5, Number(targetDuration) || 1).toFixed(3);

    try {
      await fs.writeFile(inputPath, inputBuffer);
      // Arranca donde empieza el recorte del creador web (+lead para no cortar la primera silaba)
      const seekMs = Math.max(0, startOffsetMs) + Math.max(0, leadMs);
      const leadArgs = seekMs > 0 ? ['-ss', (seekMs / 1000).toFixed(3)] : [];

      await runProcess(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          ...leadArgs,
          '-i',
          inputPath,
          '-vn',
          '-map',
          '0:a:0',
          '-af',
          `aresample=48000:first_pts=0,apad=whole_dur=${durationSec}`,
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          '-t',
          durationSec,
          wavPath,
        ],
        { signal, timeoutMs: 30000 }
      );

      await runProcess(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          '-i',
          wavPath,
          '-c:a',
          'libopus',
          '-b:a',
          `${kbps}k`,
          '-map_metadata',
          '-1',
          oggPath,
        ],
        { signal, timeoutMs: 30000 }
      );

      const oggBuffer = await fs.readFile(oggPath);
      if (!oggBuffer || oggBuffer.length < 100) return null;

      const { stdout: pcmBuffer } = await runProcessBuffer(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          '-i',
          oggPath,
          '-vn',
          '-f',
          's16le',
          '-ac',
          '1',
          '-ar',
          '8000',
          '-',
        ],
        { signal, timeoutMs: 15000 }
      );

      return {
        buffer: oggBuffer,
        waveform: waveformFromPcm(pcmBuffer, 64),
        mimetype: AUDIO_MIMETYPE,
        sizeBytes: oggBuffer.length,
      };
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('does not contain any stream') ||
          err.message.includes('Stream map') ||
          err.message.includes('Output file is empty'))
      ) {
        return null;
      }
      throw err;
    } finally {
      await removeTempFiles([inputPath, wavPath, oggPath]);
    }
  });
}

export async function sendNativeSoundSticker(params: {
  sock: {
    user?: { id?: string; lid?: string };
    waUploadToServer: unknown;
    relayMessage: (jid: string, message: unknown, options: { messageId?: string }) => Promise<unknown>;
  };
  remoteJid: string;
  webpBuffer: Buffer;
  oggBuffer: Buffer;
  waveform: Uint8Array;
  seconds: number;
  quoted?: unknown;
  sentMessageIds?: { add: (id: string) => void };
}): Promise<{ messageId?: string; embeddedAudioBytes: number; seconds: number }> {
  const { sock, remoteJid, webpBuffer, oggBuffer, waveform, seconds, quoted, sentMessageIds } = params;
  installStickerAudioPatch(proto);

  const uploadOptions = { upload: sock.waUploadToServer as never };
  const safeSeconds = Math.max(1, Math.round(seconds));

  const uploadedAudio = await prepareWAMessageMedia(
    { audio: oggBuffer, mimetype: AUDIO_MIMETYPE, seconds: safeSeconds },
    uploadOptions
  );
  const uploadedSticker = await prepareWAMessageMedia(
    { sticker: webpBuffer, isAnimated: true },
    uploadOptions
  );

  const audio = uploadedAudio.audioMessage;
  if (!audio) {
    throw new Error('WhatsApp no devolvió metadatos del audio subido.');
  }

  const audioMessageBytes = proto.Message.AudioMessage.encode(
    proto.Message.AudioMessage.create({
      url: audio.url,
      mimetype: AUDIO_MIMETYPE,
      fileSha256: audio.fileSha256,
      fileLength: audio.fileLength,
      seconds: safeSeconds,
      ptt: true,
      mediaKey: audio.mediaKey,
      fileEncSha256: audio.fileEncSha256,
      directPath: audio.directPath,
      mediaKeyTimestamp: audio.mediaKeyTimestamp || Math.floor(Date.now() / 1000),
      waveform,
    })
  ).finish();

  const sticker = uploadedSticker.stickerMessage;
  if (!sticker || !sticker.fileSha256) {
    throw new Error('WhatsApp no devolvió metadatos del sticker subido.');
  }

  sticker.isAnimated = true;
  sticker.width = 512;
  sticker.height = 512;

  attachAudioToSticker(sticker.fileSha256, audioMessageBytes);

  try {
    const me = sock.user || {};
    const ownJid = remoteJid.endsWith('@lid') && me.lid ? me.lid : me.id || '';
    const message = generateWAMessageFromContent(
      remoteJid,
      { stickerMessage: sticker },
      {
        quoted: quoted as never,
        userJid: ownJid,
      }
    );

    const encoded = Buffer.from(proto.Message.encode(message.message!).finish());
    const embeddedBytes = getEmbeddedAudioSize(encoded);
    if (embeddedBytes === null) {
      throw new Error('No se pudo verificar el campo 26 (AudioMessage) dentro del StickerMessage.');
    }

    if (message?.key?.id && sentMessageIds) {
      sentMessageIds.add(message.key.id);
    }

    await sock.relayMessage(remoteJid, message.message, {
      messageId: message.key.id || undefined,
    });

    return {
      messageId: message?.key?.id || undefined,
      embeddedAudioBytes: embeddedBytes,
      seconds: safeSeconds,
    };
  } finally {
    detachAudioFromSticker(sticker.fileSha256);
  }
}

export type MediaKind = 'image' | 'animated' | 'video' | 'audio';

export interface ResolvedMedia {
  buffer: Buffer;
  extension: string;
  kind: MediaKind;
  sourceUrl: string;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
};

function extFromUrl(raw: string): string | null {
  try {
    const p = new URL(raw).pathname;
    const m = p.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

function isPinterestHost(host: string): boolean {
  return (
    host === 'pinterest.com' ||
    host.endsWith('.pinterest.com') ||
    host === 'pin.it' ||
    host.endsWith('.pin.it')
  );
}

/** Sitios donde el og:image es solo la miniatura: no sirve como sticker real. */
function isKnownVideoSite(host: string): boolean {
  const roots = [
    'youtube.com',
    'youtu.be',
    'tiktok.com',
    'instagram.com',
    'facebook.com',
    'fb.watch',
    'twitter.com',
    'x.com',
    'vimeo.com',
    'twitch.tv',
    'dailymotion.com',
    'streamable.com',
    'reddit.com',
    'redd.it',
  ];
  return roots.some((root) => host === root || host.endsWith(`.${root}`));
}

/**
 * GET con validación SSRF en cada salto de redirección.
 */
function httpGetBuffer(
  rawUrl: string,
  maxBytes: number,
  signal?: AbortSignal,
  redirects = 0
): Promise<{ buffer: Buffer; contentType: string; finalUrl: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('OPERACION_CANCELADA'));
      return;
    }

    let url: string;
    try {
      url = validateUrlAntiSsrf(rawUrl);
    } catch (err) {
      reject(err);
      return;
    }

    const parsed = new URL(url);
    const protocol = parsed.protocol === 'https:' ? https : http;
    const options: https.RequestOptions | http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: 60000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
        Accept: '*/*',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      },
    };

    const req = protocol.request(options, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;

      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (redirects >= 6) {
          reject(new Error('Demasiadas redirecciones.'));
          return;
        }
        const next = new URL(location, url).toString();
        httpGetBuffer(next, maxBytes, signal, redirects + 1).then(resolve, reject);
        return;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`El servidor respondió HTTP ${status}.`));
        return;
      }

      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      const chunks: Buffer[] = [];
      let size = 0;

      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          reject(new Error(`Archivo demasiado grande (>${Math.round(maxBytes / (1024 * 1024))} MB).`));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        resolve({ buffer: Buffer.concat(chunks), contentType, finalUrl: url });
      });
    });

    const onAbort = () => {
      req.destroy();
      reject(new Error('OPERACION_CANCELADA'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    req.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout al descargar la URL.'));
    });
    req.end();
  });
}

async function findFirstMediaFile(dir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await findFirstMediaFile(full);
        if (nested) return nested;
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase().replace('.', '');
        if (['jpg','jpeg','png','webp','gif','mp4','webm','mov','mkv','m4a','mp3'].includes(ext)) {
          return full;
        }
      }
    }
  } catch {
    // Ignorar
  }
  return null;
}

const binaryCache = new Map<string, boolean>();

async function hasBinary(bin: string): Promise<boolean> {
  const cached = binaryCache.get(bin);
  if (cached !== undefined) return cached;
  return new Promise((resolve) => {
    try {
      const child = spawn(bin, ['--version'], { windowsHide: true });
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignorar
        }
        binaryCache.set(bin, false);
        resolve(false);
      }, 4000);
      child.on('error', () => {
        clearTimeout(timer);
        binaryCache.set(bin, false);
        resolve(false);
      });
      child.on('close', () => {
        clearTimeout(timer);
        binaryCache.set(bin, true);
        resolve(true);
      });
    } catch {
      binaryCache.set(bin, false);
      resolve(false);
    }
  });
}

let cachedCookiesPath: string | null | undefined;

async function resolveCookiesFile(): Promise<string | null> {
  if (cachedCookiesPath !== undefined) return cachedCookiesPath;
  if (config.ytdlpCookiesFile) {
    try {
      await fs.access(config.ytdlpCookiesFile);
      cachedCookiesPath = config.ytdlpCookiesFile;
      return cachedCookiesPath;
    } catch {
      // Si no existe, seguir con el contenido inline si lo hay
    }
  }
  if (config.ytdlpCookies) {
    let content = config.ytdlpCookies;
    // Permitir cookies en base64 (útil en variables de entorno de Render).
    if (!content.includes('\t') && !content.includes('# Netscape')) {
      try {
        const decoded = Buffer.from(content, 'base64').toString('utf8');
        if (decoded.includes('\t') || decoded.includes('# Netscape')) content = decoded;
      } catch {
        // Mantener el valor original
      }
    }
    const cookiePath = path.join(os.tmpdir(), `${TEMP_PREFIX}cookies.txt`);
    try {
      await fs.writeFile(cookiePath, content, { mode: 0o600 });
      cachedCookiesPath = cookiePath;
    } catch {
      cachedCookiesPath = null;
    }
    return cachedCookiesPath;
  }
  cachedCookiesPath = null;
  return null;
}

async function buildYtDlpExtraArgs(): Promise<string[]> {
  const extra: string[] = [];

  // Runtime JS para resolver retos de YouTube (deno).
  const runtime = config.ytdlpJsRuntime;
  if (runtime && (await hasBinary(runtime))) {
    extra.push('--js-runtimes', runtime);
  }

  // Cookies para "Sign in to confirm you're not a bot".
  const cookiePath = await resolveCookiesFile();
  if (cookiePath) {
    extra.push('--cookies', cookiePath);
  }

  // Extractor args opcionales (ej. youtube:player_client=default,web_safari).
  if (config.ytdlpExtractorArgs) {
    extra.push('--extractor-args', config.ytdlpExtractorArgs);
  }

  return extra;
}

async function runExternalDownloader(
  bin: string,
  args: string[],
  outDir: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ media: ResolvedMedia | null; error: string | null }> {
  let error: string | null = null;
  try {
    await runProcess(bin, args, { signal, timeoutMs: 180000 });
  } catch (err) {
    error = err instanceof Error ? err.message : 'Error al ejecutar el descargador';
    return { media: null, error };
  }
  const file = await findFirstMediaFile(outDir);
  if (!file) return { media: null, error: 'No se encontró ningún archivo descargado.' };
  try {
    const stat = await fs.stat(file);
    if (stat.size <= 0) return { media: null, error: 'El archivo descargado está vacío.' };
    if (stat.size > maxBytes) return { media: null, error: 'El archivo supera el tamaño máximo.' };
    const buffer = await fs.readFile(file);
    const extension = path.extname(file).slice(1).toLowerCase() || 'bin';
    const kind: MediaKind =
      ['jpg','jpeg','png','webp'].includes(extension)
        ? 'image'
        : extension === 'gif'
          ? 'animated'
          : ['mp3','m4a'].includes(extension)
            ? 'audio'
            : 'video';
    return { media: { buffer, extension, kind, sourceUrl: '' }, error: null };
  } catch (err) {
    return { media: null, error: err instanceof Error ? err.message : 'Error leyendo el archivo.' };
  }
}

let lastYtDlpError: string | null = null;

async function tryYtDlp(url: string, maxBytes: number, signal?: AbortSignal): Promise<ResolvedMedia | null> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), `${TEMP_PREFIX}yt-`));
  try {
    const template = path.join(outDir, 'media.%(ext)s');
    const extra = await buildYtDlpExtraArgs();
    const baseArgs = [
      ...extra,
      '-o', template,
      '--no-playlist',
      '--no-warnings',
      '--ignore-config',
      '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
      '--merge-output-format', 'mp4',
      '--max-filesize', String(maxBytes),
      '--retries', '5',
      '--fragment-retries', '5',
      '--file-access-retries', '3',
      '--concurrent-fragments', '4',
      '--trim-filenames', '150',
      '--output-na-placeholder', 'unknown',
      url,
    ];
    const first = await runExternalDownloader('yt-dlp', baseArgs, outDir, maxBytes, signal);
    if (first.media) return first.media;
    const second = await runExternalDownloader(
      'python3',
      ['-m', 'yt_dlp', ...baseArgs],
      outDir,
      maxBytes,
      signal
    );
    if (second.media) return second.media;
    lastYtDlpError = first.error || second.error || 'yt-dlp no pudo descargar el video.';
    return null;
  } finally {
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function tryGalleryDl(url: string, maxBytes: number, signal?: AbortSignal): Promise<ResolvedMedia | null> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), `${TEMP_PREFIX}gdl-`));
  try {
    const args = ['--dest', outDir, url];
    const first = await runExternalDownloader('gallery-dl', args, outDir, maxBytes, signal);
    if (first.media) return first.media;
    const second = await runExternalDownloader('python3', ['-m', 'gallery_dl', ...args], outDir, maxBytes, signal);
    return second.media;
  } finally {
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Respaldo opcional: usa un servicio tipo "bench downloader"
 * (POST /download -> files[].url) configurado en BENCH_DOWNLOADER_URL.
 */
async function tryBenchDownloader(url: string, maxBytes: number): Promise<ResolvedMedia | null> {
  const base = config.benchDownloaderUrl.replace(/\/+$/, '');
  if (!base) return null;
  try {
    const response = await fetch(`${base}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format: '720p' }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      files?: Array<{ url?: string; filename?: string }>;
    };
    const first = data.files?.find((f) => f.url);
    if (!first?.url) return null;

    const fileUrl = first.url.startsWith('http') ? first.url : `${base}${first.url}`;
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) return null;
    const arrayBuffer = await fileRes.arrayBuffer();
    if (arrayBuffer.byteLength <= 0 || arrayBuffer.byteLength > maxBytes) return null;

    const buffer = Buffer.from(arrayBuffer);
    const guessedExt = extFromUrl(first.filename || first.url) || 'mp4';
    const kind: MediaKind =
      ['jpg','jpeg','png','webp'].includes(guessedExt)
        ? 'image'
        : guessedExt === 'gif'
          ? 'animated'
          : ['mp3','m4a','ogg'].includes(guessedExt)
            ? 'audio'
            : 'video';
    return { buffer, extension: guessedExt, kind, sourceUrl: url };
  } catch {
    return null;
  }
}

function scrapeOgImage(html: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1].replace(/&amp;/g, '&');
  }
  return null;
}

/** Convierte el stderr de yt-dlp en un mensaje corto y entendible. */
function summarizeExternalError(raw: string | null): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();

  if (lower.includes('sign in to confirm') || lower.includes("you're not a bot") || lower.includes('not a bot')) {
    return 'YouTube pide iniciar sesión (bot-check). Configura YTDLP_COOKIES o YTDLP_COOKIES_FILE.';
  }
  if (lower.includes('no supported javascript runtime') || lower.includes('javascript runtime')) {
    return 'Falta el runtime JS (deno) que YouTube necesita.';
  }
  if (lower.includes('private video')) return 'El video es privado.';
  if (lower.includes('is not available') || lower.includes('video unavailable')) {
    return 'El video no está disponible (bloqueado, regional o eliminado).';
  }
  if (lower.includes('age-restricted') || lower.includes('age restricted')) {
    return 'El video tiene restricción de edad; requiere cookies.';
  }
  if (lower.includes('requested format is not available')) {
    return 'No hay un formato compatible disponible.';
  }

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((line) => /ERROR:/i.test(line));
  const picked = errorLine || lines[lines.length - 1];
  if (!picked) return null;
  const marker = picked.toUpperCase().lastIndexOf('ERROR:');
  const clean = marker >= 0 ? picked.slice(marker + 6).trim() : picked;
  return clean.slice(0, 240);
}

/**
 * Resuelve un link en un archivo multimedia real.
 * - Descarga directa rápida para URLs de imagen/video.
 * - gallery-dl para Pinterest.
 * - yt-dlp (<=720p) para páginas de video (YouTube, TikTok, etc.).
 * - Fallback og:image para fotos de páginas web.
 * Toda la descarga corre dentro de la cola global (1 tarea pesada a la vez).
 */
export async function resolveMediaFromUrl(
  rawUrl: string,
  options: { maxBytes: number; signal?: AbortSignal } = { maxBytes: config.maxVideoBytes }
): Promise<ResolvedMedia> {
  const maxBytes = options.maxBytes;

  return videoProcessingQueue.run(async () => {
    let directError: string | null = null;
    lastYtDlpError = null;

    // 1) Descarga directa (imagen/video servido tal cual)
    try {
      const res = await httpGetBuffer(rawUrl, maxBytes, options.signal);
      const ctype = res.contentType.split(';')[0].trim();
      const guessedExt = extFromUrl(res.finalUrl);
      const knownExt = guessedExt
        ? ['jpg','jpeg','png','webp','gif','mp4','webm','mov','mkv','mp3','m4a','ogg'].includes(guessedExt)
        : false;

      if (
        ctype.startsWith('image/') ||
        ctype.startsWith('video/') ||
        ctype.startsWith('audio/') ||
        ((ctype === 'application/octet-stream' || ctype === '' || ctype === 'binary/octet-stream') && knownExt)
      ) {
        const ext = EXT_BY_MIME[ctype] || guessedExt || 'bin';
        const kind: MediaKind =
          ctype === 'image/gif'
            ? 'animated'
            : ctype.startsWith('image/') || ['jpg','jpeg','png','webp'].includes(ext)
              ? 'image'
              : ['gif'].includes(ext)
                ? 'animated'
                : ['mp3','m4a','ogg'].includes(ext)
                  ? 'audio'
                  : 'video';
        return { buffer: res.buffer, extension: ext, kind, sourceUrl: rawUrl };
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'OPERACION_CANCELADA') throw err;
      directError = err instanceof Error ? err.message : 'Error de descarga';
    }

    const host = new URL(validateUrlAntiSsrf(rawUrl)).hostname.toLowerCase();

    // 2) Pinterest: gallery-dl
    if (isPinterestHost(host)) {
      const gdl = await tryGalleryDl(rawUrl, maxBytes, options.signal);
      if (gdl) return { ...gdl, sourceUrl: rawUrl };
    }

    // 3) yt-dlp para páginas de video
    const yt = await tryYtDlp(rawUrl, maxBytes, options.signal);
    if (yt) return { ...yt, sourceUrl: rawUrl };

    // 3b) Respaldo opcional: servicio externo tipo bench downloader
    const bench = await tryBenchDownloader(rawUrl, maxBytes);
    if (bench) return bench;

    // 4) Fallback og:image para fotos de páginas web (no para sitios de video)
    if (!isKnownVideoSite(host)) {
      try {
        const page = await httpGetBuffer(rawUrl, Math.min(maxBytes, 3 * 1024 * 1024), options.signal);
        const html = page.buffer.toString('utf8');
        const imageUrl = scrapeOgImage(html);
        if (imageUrl) {
          const img = await httpGetBuffer(imageUrl, maxBytes, options.signal);
          const ctype = img.contentType.split(';')[0].trim();
          if (ctype.startsWith('image/')) {
            const ext = EXT_BY_MIME[ctype] || extFromUrl(img.finalUrl) || 'jpg';
            return {
              buffer: img.buffer,
              extension: ext,
              kind: ctype === 'image/gif' ? 'animated' : 'image',
              sourceUrl: imageUrl,
            };
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message === 'OPERACION_CANCELADA') throw err;
      }
    }

    const ytError = summarizeExternalError(lastYtDlpError);
    const details = [directError, ytError].filter(Boolean).join(' | ');

    throw new Error(
      details
        ? `No se pudo descargar el link (${details}).`
        : 'No se encontró imagen ni video en ese link.'
    );
  });
}

/** Descarga directa simple (compatibilidad). */
export async function downloadUrl(rawUrl: string, maxBytes: number): Promise<Buffer> {
  const res = await httpGetBuffer(rawUrl, maxBytes);
  return res.buffer;
}
