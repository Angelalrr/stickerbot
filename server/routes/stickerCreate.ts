import type { Response } from 'express';
import { config } from '../config.ts';
import type { AuthenticatedRequest } from '../auth/sessionAuth.ts';
import type { HybridUserStore } from '../storage/userStore.ts';
import type { MultiUserSessionManager } from '../bot/sessionManager.ts';
import {
  parseVideoCropMode,
  resolveTrimWindow,
  validateGroupJid,
  validateMediaBuffer,
} from '../bot/validation.ts';
import {
  extractSynchronizedAudio,
  imageToStickerWebp,
  probeVideoBuffer,
  textToStickerWebp,
  videoToAnimatedStickerWebp,
} from '../bot/mediaProcessors.ts';

export type StickerCreateMode = 'image' | 'video' | 'text';

function readMode(raw: unknown): StickerCreateMode | null {
  if (raw === 'image' || raw === 'video' || raw === 'text') return raw;
  return null;
}

/**
 * POST /api/sticker/create (multipart)
 * Creador de stickers web: recibe la foto/video/texto editado en el navegador,
 * lo convierte a sticker 512x512 y lo envia al grupo autorizado del usuario.
 */
export async function handleStickerCreate(
  req: AuthenticatedRequest,
  res: Response,
  store: HybridUserStore,
  sessionManager: MultiUserSessionManager
): Promise<void> {
  const userId = req.authUserId || '';

  try {
    const mode = readMode(req.body?.mode);
    if (!mode) {
      res.status(400).json({ error: 'Modo de sticker inválido (usa image, video o text).' });
      return;
    }

    // El creador puede elegir cualquier grupo al que pertenece la sesión vinculada.
    let groupJid = '';
    const rawGroup = typeof req.body?.groupJid === 'string' ? req.body.groupJid.trim() : '';
    if (rawGroup) {
      const groupCheck = validateGroupJid(rawGroup);
      if (!groupCheck.valid) {
        res.status(400).json({ error: groupCheck.error });
        return;
      }
      groupJid = groupCheck.normalized;
    } else {
      const user = await store.getUser(userId);
      groupJid = user?.authorizedGroupJid || '';
      if (!groupJid) {
        res.status(400).json({
          error: 'Selecciona el grupo de destino antes de enviar el sticker.',
        });
        return;
      }
    }

    if (mode === 'image') {
      const buffer = req.file?.buffer;
      const check = validateMediaBuffer(buffer, config.maxImageBytes, 'imagen');
      if (!check.valid) {
        res.status(400).json({ error: check.error || 'Imagen inválida.' });
        return;
      }

      const { buffer: webpBuffer, sizeBytes } = await imageToStickerWebp(buffer as Buffer, {
        packName: config.stickerPack,
        authorName: config.stickerAuthor,
        maxBytes: config.maxStickerBytes,
      });
      await sessionManager.sendStickerToGroup(userId, webpBuffer, groupJid);

      res.status(200).json({
        ok: true,
        mode,
        groupJid,
        sizeBytes,
        sound: false,
      });
      return;
    }

    if (mode === 'video') {
      const buffer = req.file?.buffer;
      const check = validateMediaBuffer(buffer, config.maxVideoBytes, 'video');
      if (!check.valid) {
        res.status(400).json({ error: check.error || 'Video inválido.' });
        return;
      }

      const mime = String(req.file?.mimetype || 'video/mp4');
      const extension = mime.includes('gif') ? 'gif' : mime.includes('webm') ? 'webm' : 'mp4';
      const cropMode = parseVideoCropMode(String(req.body?.cropMode || ''));
      const withSound = req.body?.withSound === 'true' || req.body?.withSound === '1';

      const probe = await probeVideoBuffer(buffer as Buffer, { extension });
      const trim = resolveTrimWindow(
        req.body?.trimStart,
        req.body?.trimDuration,
        probe.duration,
        config.maxVideoSeconds
      );
      if (!trim.valid) {
        res.status(400).json({ error: trim.error });
        return;
      }

      if (withSound && !probe.hasAudio) {
        res.status(400).json({
          error:
            'Ese video no tiene pista de audio. Desmarca "Incluir sonido" o elige un video con audio.',
        });
        return;
      }

      const stickerResult = await videoToAnimatedStickerWebp(buffer as Buffer, {
        extension,
        maxSeconds: config.maxVideoSeconds,
        maxBytes: config.maxStickerBytes,
        packName: config.stickerPack,
        authorName: config.stickerAuthor,
        cropMode,
        trimStart: trim.start,
        trimDuration: trim.duration,
      });

      const exactDuration =
        stickerResult.duration > 0
          ? stickerResult.duration
          : Math.min(trim.duration, config.maxVideoSeconds);

      let warning: string | null = null;
      let oggBuffer: Buffer | null = null;
      let waveform: Uint8Array | null = null;

      if (withSound) {
        const audioResult = await extractSynchronizedAudio({
          inputBuffer: buffer as Buffer,
          extension,
          targetDuration: exactDuration,
          kbps: config.audioKbps,
          leadMs: config.audioLeadMs,
          startOffsetMs: trim.start * 1000,
        });
        if (audioResult) {
          oggBuffer = audioResult.buffer;
          waveform = audioResult.waveform;
        } else {
          warning =
            'No se pudo extraer el audio de este video; se envió el sticker animado sin sonido.';
        }
      }

      if (oggBuffer && waveform) {
        await sessionManager.sendSoundStickerToGroup(userId, {
          webpBuffer: stickerResult.buffer,
          oggBuffer,
          waveform,
          seconds: exactDuration,
          groupJid,
        });
      } else {
        await sessionManager.sendStickerToGroup(userId, stickerResult.buffer, groupJid);
      }

      res.status(200).json({
        ok: true,
        mode,
        groupJid,
        sizeBytes: stickerResult.sizeBytes,
        duration: exactDuration,
        frames: stickerResult.frames,
        sound: Boolean(oggBuffer && waveform),
        warning,
      });
      return;
    }

    // mode === 'text'
    const rawText = typeof req.body?.text === 'string' ? req.body.text : '';
    const rawColor = typeof req.body?.color === 'string' ? req.body.color.trim() : '';
    if (!rawText.trim()) {
      res.status(400).json({ error: 'Escribe el texto del sticker.' });
      return;
    }
    const argsText = rawColor ? `${rawColor} ${rawText.trim()}` : rawText.trim();
    const { buffer: webpBuffer, sizeBytes, text } = await textToStickerWebp(argsText, {
      packName: config.stickerPack,
      authorName: config.stickerAuthor,
    });
    await sessionManager.sendStickerToGroup(userId, webpBuffer, groupJid);

    res.status(200).json({
      ok: true,
      mode,
      groupJid,
      sizeBytes,
      text,
      sound: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'No se pudo crear el sticker.';
    console.error(`[StickerBot] Error en creador web (${userId}):`, err);
    res.status(400).json({ error: message });
  }
}
