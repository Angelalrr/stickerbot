import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import sharp from 'sharp';
import webpmux from 'node-webpmux';
import {
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  proto,
} from '@whiskeysockets/baileys';
import { checkFfmpegAvailable } from '../config.ts';
import {
  buildVideoScaleFilter,
  escapeXml,
  parseTextStickerArgs,
  type VideoCropMode,
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
    maxSeconds = 7,
    maxBytes = 500 * 1024,
    packName = 'StickerBot Pack',
    authorName = 'StickerBot',
    cropMode = 'crop',
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

    const presets = [
      { fps: 15, quality: 55, duration: maxSeconds, size: 512 },
      { fps: 12, quality: 40, duration: Math.min(maxSeconds, 6), size: 512 },
      { fps: 10, quality: 28, duration: Math.min(maxSeconds, 5), size: 512 },
      { fps: 8, quality: 20, duration: Math.min(maxSeconds, 4), size: 384 },
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
  signal?: AbortSignal;
}): Promise<{ buffer: Buffer; waveform: Uint8Array; mimetype: string; sizeBytes: number } | null> {
  const {
    inputBuffer,
    extension = 'mp4',
    targetDuration,
    kbps = 32,
    leadMs = 100,
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
      const leadArgs = leadMs > 0 ? ['-ss', (leadMs / 1000).toFixed(3)] : [];

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
