import { Boom } from '@hapi/boom';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { checkFfmpegAvailable, config } from '../config.ts';
import type { HybridUserStore } from '../storage/userStore.ts';
import {
  BoundedIdCache,
  formatBotReply,
  isAllowedGroup,
  maskJid,
  parseCommand,
  parseVideoCropMode,
  sanitizePhoneForPairing,
  validateMediaBuffer,
} from './validation.ts';
import {
  extractSynchronizedAudio,
  imageToStickerWebp,
  probeVideoBuffer,
  sendNativeSoundSticker,
  textToStickerWebp,
  videoToAnimatedStickerWebp,
} from './mediaProcessors.ts';

const silentPino = pino({ level: 'silent' });

export type SessionConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr_ready'
  | 'pairing_ready'
  | 'connected'
  | 'logged_out'
  | 'error';

export interface PublicSessionSnapshot {
  userId: string;
  status: SessionConnectionStatus;
  qrDataUrl: string | null;
  pairingCode: string | null;
  phoneNumber: string | null;
  connectedAccountName: string | null;
  connectedJid: string | null;
  authorizedGroupJid: string;
  lastDetectedGroupJid: string | null;
  lastError: string | null;
  updatedAt: string;
}

interface UserRuntime {
  userId: string;
  sock: WASocket | null;
  status: SessionConnectionStatus;
  qrDataUrl: string | null;
  pairingCode: string | null;
  phoneNumber: string | null;
  connectedAccountName: string | null;
  connectedJid: string | null;
  lastDetectedGroupJid: string | null;
  lastError: string | null;
  updatedAt: string;
  reconnectTimer: NodeJS.Timeout | null;
  manualClose: boolean;
  pairingRequested: boolean;
  sentMessageIds: BoundedIdCache;
  processedMessageIds: BoundedIdCache;
  activeJobs: Map<string, AbortController>;
}

function unwrapMessage(rawMessage: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!rawMessage || typeof rawMessage !== 'object') return null;
  const eph = rawMessage.ephemeralMessage as { message?: Record<string, unknown> } | undefined;
  if (eph?.message) return unwrapMessage(eph.message);
  const vo1 = rawMessage.viewOnceMessage as { message?: Record<string, unknown> } | undefined;
  if (vo1?.message) return unwrapMessage(vo1.message);
  const vo2 = rawMessage.viewOnceMessageV2 as { message?: Record<string, unknown> } | undefined;
  if (vo2?.message) return unwrapMessage(vo2.message);
  return rawMessage;
}

function extractMessageText(messageContent: unknown): string {
  const msg = unwrapMessage(messageContent as Record<string, unknown> | null);
  if (!msg) return '';
  const ext = msg.extendedTextMessage as { text?: string } | undefined;
  const img = msg.imageMessage as { caption?: string } | undefined;
  const vid = msg.videoMessage as { caption?: string } | undefined;
  const doc = msg.documentMessage as { caption?: string } | undefined;
  return String(
    msg.conversation ||
      ext?.text ||
      img?.caption ||
      vid?.caption ||
      doc?.caption ||
      ''
  ).trim();
}

function findTargetMedia(
  rawMsg: WAMessage,
  allowedMediaTypes: string[]
): {
  targetMsg: WAMessage;
  mediaType: string;
  mediaNode: Record<string, unknown>;
  isQuoted: boolean;
} | null {
  const content = unwrapMessage(rawMsg?.message as Record<string, unknown> | null);
  if (!content) return null;

  const directType = getContentType(content as never);
  if (directType && allowedMediaTypes.includes(directType)) {
    return {
      targetMsg: { ...rawMsg, message: content as never },
      mediaType: directType,
      mediaNode: (content[directType] as Record<string, unknown>) || {},
      isQuoted: false,
    };
  }

  const directObj = directType ? (content[directType] as Record<string, unknown> | undefined) : undefined;
  const extObj = content.extendedTextMessage as Record<string, unknown> | undefined;
  const contextInfo = (extObj?.contextInfo || directObj?.contextInfo) as
    | { quotedMessage?: Record<string, unknown>; stanzaId?: string; participant?: string }
    | undefined;

  const quotedRaw = contextInfo?.quotedMessage;
  if (!quotedRaw) return null;

  const quotedContent = unwrapMessage(quotedRaw);
  if (!quotedContent) return null;
  const quotedType = getContentType(quotedContent as never);

  if (quotedType && allowedMediaTypes.includes(quotedType)) {
    const syntheticMessage: WAMessage = {
      key: {
        remoteJid: rawMsg.key?.remoteJid,
        fromMe: false,
        id: contextInfo?.stanzaId || rawMsg.key?.id,
        participant: contextInfo?.participant,
      },
      message: quotedContent as never,
    };
    return {
      targetMsg: syntheticMessage,
      mediaType: quotedType,
      mediaNode: (quotedContent[quotedType] as Record<string, unknown>) || {},
      isQuoted: true,
    };
  }

  return null;
}

export class MultiUserSessionManager {
  store: HybridUserStore;
  runtimes: Map<string, UserRuntime>;

  constructor(store: HybridUserStore) {
    this.store = store;
    this.runtimes = new Map();
  }

  private getOrCreateRuntime(userId: string): UserRuntime {
    let rt = this.runtimes.get(userId);
    if (!rt) {
      rt = {
        userId,
        sock: null,
        status: 'disconnected',
        qrDataUrl: null,
        pairingCode: null,
        phoneNumber: null,
        connectedAccountName: null,
        connectedJid: null,
        lastDetectedGroupJid: null,
        lastError: null,
        updatedAt: new Date().toISOString(),
        reconnectTimer: null,
        manualClose: false,
        pairingRequested: false,
        sentMessageIds: new BoundedIdCache(1000, 5 * 60 * 1000),
        processedMessageIds: new BoundedIdCache(1000, 5 * 60 * 1000),
        activeJobs: new Map(),
      };
      this.runtimes.set(userId, rt);
    }
    return rt;
  }

  async restoreExistingSessions(): Promise<void> {
    try {
      const users = await this.store.listUsers();
      for (const user of users) {
        const hasCreds = await this.store.hasStoredCreds(user.userId);
        if (hasCreds) {
          void this.startSession(user.userId, { mode: 'qr' }).catch((err) => {
            console.warn(`[StickerBot] No se pudo restaurar sesión de ${user.userId}:`, err);
          });
        }
      }
    } catch (err) {
      console.warn('[StickerBot] Error restaurando sesiones previas:', err);
    }
  }

  async getSnapshot(userId: string): Promise<PublicSessionSnapshot> {
    const user = await this.store.getUser(userId);
    const rt = this.getOrCreateRuntime(userId);
    return {
      userId,
      status: rt.status,
      qrDataUrl: rt.qrDataUrl,
      pairingCode: rt.pairingCode,
      phoneNumber: rt.phoneNumber,
      connectedAccountName: rt.connectedAccountName,
      connectedJid: rt.connectedJid,
      authorizedGroupJid: user?.authorizedGroupJid || '',
      lastDetectedGroupJid: rt.lastDetectedGroupJid,
      lastError: rt.lastError,
      updatedAt: rt.updatedAt,
    };
  }

  async listUserGroups(userId: string): Promise<
    Array<{ jid: string; subject: string; participants: number }>
  > {
    const rt = this.getOrCreateRuntime(userId);
    if (rt.status !== 'connected' || !rt.sock) {
      throw new Error('Tu WhatsApp no está conectado. Vincula tu cuenta en el Panel primero.');
    }
    const groups = await rt.sock.groupFetchAllParticipating();
    return Object.values(groups)
      .map((group) => ({
        jid: group.id,
        subject: group.subject || 'Grupo de WhatsApp',
        participants: Array.isArray(group.participants) ? group.participants.length : 0,
      }))
      .sort((a, b) => a.subject.localeCompare(b.subject));
  }

  private async getSendTarget(
    userId: string,
    requestedGroupJid?: string
  ): Promise<{ rt: UserRuntime; sock: WASocket; groupJid: string }> {
    const rt = this.getOrCreateRuntime(userId);
    if (rt.status !== 'connected' || !rt.sock) {
      throw new Error('Tu WhatsApp no está conectado. Vincula tu cuenta en el Panel primero.');
    }
    const userRecord = await this.store.getUser(userId);
    const groupJid = requestedGroupJid || userRecord?.authorizedGroupJid || '';
    if (!groupJid) {
      throw new Error('No hay grupo de destino. Selecciona un grupo en el Creador de stickers.');
    }
    if (!groupJid.endsWith('@g.us')) {
      throw new Error('El grupo de destino no es válido. Selecciona un grupo de WhatsApp.');
    }
    return { rt, sock: rt.sock, groupJid };
  }

  /**
   * Envia un sticker WebP ya procesado al grupo autorizado del usuario (creador web).
   */
  async sendStickerToGroup(userId: string, webpBuffer: Buffer, groupJid?: string): Promise<{ groupJid: string }> {
    const { rt, sock, groupJid: targetGroupJid } = await this.getSendTarget(userId, groupJid);
    await this.sendTracked(rt, sock, targetGroupJid, { sticker: webpBuffer });
    return { groupJid: targetGroupJid };
  }

  /**
   * Envia un Sound Sticker nativo (WebP + OGG en campo 26) al grupo autorizado del usuario.
   */
  async sendSoundStickerToGroup(
    userId: string,
    params: { webpBuffer: Buffer; oggBuffer: Buffer; waveform: Uint8Array; seconds: number; groupJid?: string }
  ): Promise<{ groupJid: string }> {
    const { rt, sock, groupJid } = await this.getSendTarget(userId, params.groupJid);
    await sendNativeSoundSticker({
      sock: sock as never,
      remoteJid: groupJid,
      webpBuffer: params.webpBuffer,
      oggBuffer: params.oggBuffer,
      waveform: params.waveform,
      seconds: params.seconds,
      sentMessageIds: rt.sentMessageIds,
    });
    return { groupJid };
  }

  async disconnectSession(userId: string, clearAuth = false): Promise<PublicSessionSnapshot> {
    const rt = this.getOrCreateRuntime(userId);
    rt.manualClose = true;
    if (rt.reconnectTimer) {
      clearTimeout(rt.reconnectTimer);
      rt.reconnectTimer = null;
    }

    for (const controller of rt.activeJobs.values()) {
      controller.abort();
    }
    rt.activeJobs.clear();

    if (rt.sock) {
      try {
        if (clearAuth) {
          await rt.sock.logout().catch(() => {});
        }
        rt.sock.end(undefined);
      } catch {
        // Ignorar errores al cerrar socket
      }
      rt.sock = null;
    }

    if (clearAuth) {
      await this.store.clearBaileysAuth(userId);
    }

    rt.status = clearAuth ? 'logged_out' : 'disconnected';
    rt.qrDataUrl = null;
    rt.pairingCode = null;
    rt.pairingRequested = false;
    rt.connectedAccountName = null;
    rt.connectedJid = null;
    rt.lastError = null;
    rt.updatedAt = new Date().toISOString();
    return this.getSnapshot(userId);
  }

  async startSession(
    userId: string,
    options: { mode: 'qr' | 'pairing'; phoneNumber?: string }
  ): Promise<PublicSessionSnapshot> {
    const rt = this.getOrCreateRuntime(userId);

    if (options.mode === 'pairing') {
      const check = sanitizePhoneForPairing(options.phoneNumber || '');
      if (!check.valid) {
        throw new Error(check.error || 'Número inválido.');
      }
      rt.phoneNumber = check.digits;
    } else {
      rt.phoneNumber = null;
    }

    // Cerrar socket previo si existe sin borrar credenciales
    if (rt.reconnectTimer) {
      clearTimeout(rt.reconnectTimer);
      rt.reconnectTimer = null;
    }
    if (rt.sock) {
      rt.manualClose = true;
      try {
        rt.sock.end(undefined);
      } catch {
        // Ignorar
      }
      rt.sock = null;
    }

    rt.manualClose = false;
    rt.pairingRequested = false;
    rt.qrDataUrl = null;
    rt.pairingCode = null;
    rt.lastError = null;
    rt.status = 'connecting';
    rt.updatedAt = new Date().toISOString();

    await this.bootSocket(userId, options.mode);
    return this.getSnapshot(userId);
  }

  private async bootSocket(userId: string, mode: 'qr' | 'pairing'): Promise<void> {
    const rt = this.getOrCreateRuntime(userId);
    const { state, saveCreds } = await this.store.getBaileysAuthState(userId);

    let version: [number, number, number] | undefined;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch {
      version = undefined;
    }

    const sock = makeWASocket({
      version,
      auth: state,
      logger: silentPino,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    rt.sock = sock;
    sock.ev.on('creds.update', () => {
      void saveCreds().catch((err) => {
        console.warn(`[StickerBot] Error guardando creds de ${userId}:`, err);
      });
    });

    sock.ev.on('connection.update', async (update) => {
      if (rt.sock !== sock) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (mode === 'pairing' && rt.phoneNumber && !state.creds.registered && !rt.pairingRequested) {
          rt.pairingRequested = true;
          try {
            const rawCode = await sock.requestPairingCode(rt.phoneNumber);
            const clean = String(rawCode || '').trim();
            rt.pairingCode = clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
            rt.status = 'pairing_ready';
            rt.qrDataUrl = null;
            rt.lastError = null;
            rt.updatedAt = new Date().toISOString();
          } catch (err) {
            rt.status = 'error';
            rt.lastError =
              err instanceof Error
                ? `No se pudo generar el código de 8 dígitos: ${err.message}`
                : 'No se pudo generar el código de 8 dígitos.';
            rt.updatedAt = new Date().toISOString();
          }
        } else if (mode === 'qr') {
          try {
            rt.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
            rt.pairingCode = null;
            rt.status = 'qr_ready';
            rt.lastError = null;
            rt.updatedAt = new Date().toISOString();
          } catch (err) {
            rt.lastError = err instanceof Error ? err.message : 'Error generando QR';
          }
        }
      }

      if (connection === 'open') {
        rt.status = 'connected';
        rt.qrDataUrl = null;
        rt.pairingCode = null;
        rt.lastError = null;
        rt.connectedAccountName = sock.user?.name || 'Cuenta WhatsApp vinculada';
        rt.connectedJid = sock.user?.id || null;
        rt.updatedAt = new Date().toISOString();
        console.log(`[StickerBot] Usuario ${userId} conectado a WhatsApp (${maskJid(rt.connectedJid)})`);
      }

      if (connection === 'close') {
        const boomErr = lastDisconnect?.error as Boom | undefined;
        const statusCode = boomErr?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        if (rt.manualClose) {
          rt.status = 'disconnected';
          rt.updatedAt = new Date().toISOString();
          return;
        }

        if (isLoggedOut) {
          await this.store.clearBaileysAuth(userId);
          rt.sock = null;
          rt.status = 'logged_out';
          rt.qrDataUrl = null;
          rt.pairingCode = null;
          rt.connectedAccountName = null;
          rt.connectedJid = null;
          rt.lastError = 'La sesión fue cerrada desde WhatsApp. Vincula nuevamente.';
          rt.updatedAt = new Date().toISOString();
          return;
        }

        rt.status = 'connecting';
        rt.lastError = boomErr?.message || 'Reconectando con WhatsApp...';
        rt.updatedAt = new Date().toISOString();
        rt.reconnectTimer = setTimeout(() => {
          rt.reconnectTimer = null;
          void this.bootSocket(userId, mode).catch((err) => {
            rt.status = 'error';
            rt.lastError = err instanceof Error ? err.message : 'Error al reconectar.';
            rt.updatedAt = new Date().toISOString();
          });
        }, 4000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' || !Array.isArray(messages)) return;

      for (const msg of messages) {
        try {
          const messageId = msg?.key?.id;
          const remoteJid = msg?.key?.remoteJid;
          if (!messageId || !remoteJid || !msg.message) continue;

          if (rt.sentMessageIds.has(messageId)) continue;
          if (rt.processedMessageIds.has(messageId)) continue;
          rt.processedMessageIds.add(messageId);

          const text = extractMessageText(msg.message);
          const parsed = parseCommand(text, config.commandPrefix);
          if (!parsed) continue;

          // Comando especial //pingdiag (o /pingdiag) funciona en cualquier grupo para descubrir su JID
          if (parsed.command === 'pingdiag') {
            if (!remoteJid.endsWith('@g.us')) continue;
            rt.lastDetectedGroupJid = remoteJid;
            rt.updatedAt = new Date().toISOString();

            const sent = await sock.sendMessage(
              remoteJid,
              {
                text: formatBotReply(
                  `ID de este grupo detectado:\n${remoteJid}\n\nCopia este ID o pulsa "Usar este grupo" en tu panel web de StickerBot.`,
                  config.botName
                ),
              },
              { quoted: msg }
            );
            if (sent?.key?.id) rt.sentMessageIds.add(sent.key.id);
            continue;
          }

          const userRecord = await this.store.getUser(userId);
          const authorizedGroupJid = userRecord?.authorizedGroupJid || '';
          const groupCheck = isAllowedGroup(remoteJid, authorizedGroupJid);
          if (!groupCheck.allowed) {
            continue;
          }

          await this.dispatchCommand(rt, sock, msg, remoteJid, parsed);
        } catch (err) {
          console.error(`[StickerBot] Error procesando mensaje (${userId}):`, err);
        }
      }
    });
  }

  private async sendTracked(
    rt: UserRuntime,
    sock: WASocket,
    remoteJid: string,
    content: Parameters<WASocket['sendMessage']>[1],
    options: Parameters<WASocket['sendMessage']>[2] = {}
  ): Promise<void> {
    const sent = await sock.sendMessage(remoteJid, content, options);
    if (sent?.key?.id) {
      rt.sentMessageIds.add(sent.key.id);
    }
  }

  private async replyText(
    rt: UserRuntime,
    sock: WASocket,
    remoteJid: string,
    body: string,
    quotedMsg: WAMessage
  ): Promise<void> {
    await this.sendTracked(
      rt,
      sock,
      remoteJid,
      { text: formatBotReply(body, config.botName) },
      { quoted: quotedMsg }
    );
  }

  private async dispatchCommand(
    rt: UserRuntime,
    sock: WASocket,
    msg: WAMessage,
    remoteJid: string,
    parsed: { command: string; argsText: string; args: string[] }
  ): Promise<void> {
    const { command, argsText } = parsed;

    if (command === 'cancelar') {
      const controller = rt.activeJobs.get(remoteJid);
      if (!controller) {
        await this.replyText(rt, sock, remoteJid, 'No hay ninguna operación en curso para cancelar.', msg);
        return;
      }
      controller.abort();
      rt.activeJobs.delete(remoteJid);
      await this.replyText(rt, sock, remoteJid, 'Cancelando la operación actual...', msg);
      return;
    }

    const heavyCommands = new Set([
      'sticker',
      's',
      'stickertexto',
      'gif',
      'stickeranimado',
      'stickeraudio',
    ]);

    if (heavyCommands.has(command) && rt.activeJobs.has(remoteJid)) {
      await this.replyText(
        rt,
        sock,
        remoteJid,
        'Ya estoy procesando otro sticker en este grupo. Espera un momento o escribe "/cancelar".',
        msg
      );
      return;
    }

    const controller = new AbortController();
    if (heavyCommands.has(command)) {
      rt.activeJobs.set(remoteJid, controller);
    }

    try {
      switch (command) {
        case 'menu': {
          await this.replyText(
            rt,
            sock,
            remoteJid,
            [
              '*General:*',
              '• */menu* — Muestra esta lista de comandos.',
              '• */ayuda* — Guía rápida paso a paso.',
              '• */ping* — Comprueba si el bot responde.',
              '• *//pingdiag* — Muestra el ID de este grupo para configurarlo en el panel.',
              '• */info* — Configuración, límites y estado de FFmpeg.',
              '• */version* — Versión del proyecto y librerías.',
              '• */cancelar* — Cancela un sticker en proceso.',
              '',
              '*Stickers:*',
              '• */sticker* o */s* — Convierte una foto en sticker 512x512.',
              '• */stickertexto <texto>* — Sticker transparente con texto.',
              '• */gif* o */stickeranimado* — Sticker animado (recorte cuadrado centrado por defecto; usa *completo* o *-full* para ver todo el encuadre).',
              '• */stickeraudio* — Sound Sticker nativo sincronizado (admite *completo* o *-full*).',
            ].join('\n'),
            msg
          );
          break;
        }
        case 'ayuda': {
          await this.replyText(
            rt,
            sock,
            remoteJid,
            [
              `¡Hola! Soy *${config.botName}*.`,
              '',
              '*1. Fotos:* Responde a una imagen con */sticker* o */s*.',
              '*2. Texto:* Escribe */stickertexto rojo ¡Hola!*',
              `*3. Videos y GIFs (máx. ${config.maxVideoSeconds}s):* Responde con */gif*, */stickeranimado* o */stickeraudio*.`,
              'Por defecto recorto el video al centro en formato cuadrado 1:1. Si quieres conservar bordes sin recortar, escribe */stickeranimado completo* o */stickeraudio -full*.',
              '*4. Cambiar grupo:* Envía *//pingdiag* en otro grupo para ver su ID.',
            ].join('\n'),
            msg
          );
          break;
        }
        case 'ping': {
          await this.replyText(
            rt,
            sock,
            remoteJid,
            '¡Hola! Estoy funcionando correctamente.\n\nUsa "/menu" para ver mis comandos.',
            msg
          );
          break;
        }
        case 'info': {
          const ffmpegOk = await checkFfmpegAvailable();
          const maxVideoMb = Math.round(config.maxVideoBytes / (1024 * 1024));
          const maxImageMb = Math.round(config.maxImageBytes / (1024 * 1024));
          const maxStickerKb = Math.round(config.maxStickerBytes / 1024);
          await this.replyText(
            rt,
            sock,
            remoteJid,
            [
              `*Nombre:* ${config.botName}`,
              `*Paquete:* ${config.stickerPack}`,
              `*Autor:* ${config.stickerAuthor}`,
              `*FFmpeg disponible:* ${ffmpegOk ? 'Sí' : 'No detectado'}`,
              `*Sound Stickers nativos:* Activados (campo 26)`,
              `*Límites:* Foto ${maxImageMb} MB · Video ${maxVideoMb} MB / ${config.maxVideoSeconds}s · Sticker ${maxStickerKb} KB`,
            ].join('\n'),
            msg
          );
          break;
        }
        case 'version': {
          await this.replyText(
            rt,
            sock,
            remoteJid,
            [
              `*${config.botName}* v${config.botVersion}`,
              `*Node.js:* ${process.version}`,
              `*Plataforma:* ${process.platform}`,
              '*Motor WhatsApp:* @whiskeysockets/baileys v7 (ESM)',
            ].join('\n'),
            msg
          );
          break;
        }
        case 'sticker':
        case 's': {
          const mediaMatch = findTargetMedia(msg, ['imageMessage', 'documentMessage']);
          if (!mediaMatch) {
            await this.replyText(
              rt,
              sock,
              remoteJid,
              'Por favor, responde a una imagen (PNG/JPG/WebP) con */sticker* o */s*.',
              msg
            );
            return;
          }
          if (mediaMatch.mediaType === 'documentMessage') {
            const mime = String(mediaMatch.mediaNode?.mimetype || '');
            if (!mime.startsWith('image/')) {
              await this.replyText(rt, sock, remoteJid, 'Ese documento no es una imagen compatible.', msg);
              return;
            }
          }
          const downloaded = await downloadMediaMessage(mediaMatch.targetMsg, 'buffer', {}, {
            logger: silentPino,
            reuploadRequest: sock.updateMediaMessage,
          });
          const buffer = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded);
          const check = validateMediaBuffer(buffer, config.maxImageBytes, 'imagen');
          if (!check.valid) {
            await this.replyText(rt, sock, remoteJid, check.error || 'Imagen inválida.', msg);
            return;
          }
          const { buffer: webpBuffer } = await imageToStickerWebp(buffer, {
            packName: config.stickerPack,
            authorName: config.stickerAuthor,
            maxBytes: config.maxStickerBytes,
          });
          await this.sendTracked(rt, sock, remoteJid, { sticker: webpBuffer }, { quoted: msg });
          break;
        }
        case 'stickertexto': {
          const { buffer } = await textToStickerWebp(argsText, {
            packName: config.stickerPack,
            authorName: config.stickerAuthor,
          });
          await this.sendTracked(rt, sock, remoteJid, { sticker: buffer }, { quoted: msg });
          break;
        }
        case 'gif':
        case 'stickeranimado': {
          const mediaMatch = findTargetMedia(msg, ['videoMessage', 'documentMessage']);
          if (!mediaMatch) {
            await this.replyText(
              rt,
              sock,
              remoteJid,
              'Responde a un GIF o video corto con */gif* o */stickeranimado* (añade *completo* o *-full* si no quieres recorte cuadrado).',
              msg
            );
            return;
          }
          if (mediaMatch.mediaType === 'documentMessage') {
            const mime = String(mediaMatch.mediaNode?.mimetype || '');
            if (!mime.startsWith('video/') && mime !== 'image/gif') {
              await this.replyText(rt, sock, remoteJid, 'Ese documento no es un GIF ni un video.', msg);
              return;
            }
          }
          const seconds = Number(mediaMatch.mediaNode?.seconds || 0);
          if (seconds > config.maxVideoSeconds + 8) {
            await this.replyText(
              rt,
              sock,
              remoteJid,
              `El video dura ${seconds} segundos. Usa clips de hasta ${config.maxVideoSeconds} segundos.`,
              msg
            );
            return;
          }
          const downloaded = await downloadMediaMessage(mediaMatch.targetMsg, 'buffer', {}, {
            logger: silentPino,
            reuploadRequest: sock.updateMediaMessage,
          });
          const buffer = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded);
          const check = validateMediaBuffer(buffer, config.maxVideoBytes, 'video o GIF');
          if (!check.valid) {
            await this.replyText(rt, sock, remoteJid, check.error || 'Video inválido.', msg);
            return;
          }

          const mime = String(mediaMatch.mediaNode?.mimetype || 'video/mp4');
          const ext = mime.includes('gif') ? 'gif' : mime.includes('webm') ? 'webm' : 'mp4';
          const cropMode = parseVideoCropMode(argsText);

          await this.replyText(rt, sock, remoteJid, 'Procesando sticker animado, espera unos segundos...', msg);
          const { buffer: webpBuffer } = await videoToAnimatedStickerWebp(buffer, {
            extension: ext,
            maxSeconds: config.maxVideoSeconds,
            maxBytes: config.maxStickerBytes,
            packName: config.stickerPack,
            authorName: config.stickerAuthor,
            cropMode,
            signal: controller.signal,
          });
          await this.sendTracked(rt, sock, remoteJid, { sticker: webpBuffer }, { quoted: msg });
          break;
        }
        case 'stickeraudio': {
          const mediaMatch = findTargetMedia(msg, ['videoMessage']);
          if (!mediaMatch) {
            await this.replyText(
              rt,
              sock,
              remoteJid,
              'Responde a un video con sonido usando */stickeraudio* (añade *completo* o *-full* si quieres conservar la proporción original).',
              msg
            );
            return;
          }
          const downloaded = await downloadMediaMessage(mediaMatch.targetMsg, 'buffer', {}, {
            logger: silentPino,
            reuploadRequest: sock.updateMediaMessage,
          });
          const buffer = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded);
          if (controller.signal.aborted) throw new Error('OPERACION_CANCELADA');

          const check = validateMediaBuffer(buffer, config.maxVideoBytes, 'video');
          if (!check.valid) {
            await this.replyText(rt, sock, remoteJid, check.error || 'Video inválido.', msg);
            return;
          }

          const probe = await probeVideoBuffer(buffer, { extension: 'mp4', signal: controller.signal });
          if (!probe.hasAudio) {
            await this.replyText(
              rt,
              sock,
              remoteJid,
              'Ese video no tiene pista de audio. Usa */gif* para crear un sticker animado sin sonido.',
              msg
            );
            return;
          }

          const cropMode = parseVideoCropMode(argsText);
          await this.replyText(rt, sock, remoteJid, 'Creando Sound Sticker sincronizado, espera unos segundos...', msg);

          const stickerResult = await videoToAnimatedStickerWebp(buffer, {
            extension: 'mp4',
            maxSeconds: config.maxVideoSeconds,
            maxBytes: config.maxStickerBytes,
            packName: config.stickerPack,
            authorName: config.stickerAuthor,
            cropMode,
            signal: controller.signal,
          });

          if (controller.signal.aborted) throw new Error('OPERACION_CANCELADA');

          const exactDuration =
            stickerResult.duration > 0
              ? stickerResult.duration
              : Math.min(probe.duration || config.maxVideoSeconds, config.maxVideoSeconds);

          const audioResult = await extractSynchronizedAudio({
            inputBuffer: buffer,
            extension: 'mp4',
            targetDuration: exactDuration,
            kbps: config.audioKbps,
            leadMs: config.audioLeadMs,
            signal: controller.signal,
          });

          if (!audioResult) {
            await this.replyText(rt, sock, remoteJid, 'No se pudo extraer una pista de audio válida de este video.', msg);
            return;
          }

          await sendNativeSoundSticker({
            sock: sock as never,
            remoteJid,
            webpBuffer: stickerResult.buffer,
            oggBuffer: audioResult.buffer,
            waveform: audioResult.waveform,
            seconds: exactDuration,
            quoted: msg,
            sentMessageIds: rt.sentMessageIds,
          });
          break;
        }
        default: {
          await this.replyText(
            rt,
            sock,
            remoteJid,
            `No reconozco el comando "/${command}".\nEscribe "/menu" para ver los comandos disponibles.`,
            msg
          );
          break;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'OPERACION_CANCELADA') {
        await this.replyText(rt, sock, remoteJid, 'Operación cancelada correctamente.', msg);
        return;
      }
      const detail = err instanceof Error ? err.message : 'Error inesperado.';
      await this.replyText(rt, sock, remoteJid, `No pude completar la acción:\n${detail}`, msg);
    } finally {
      if (heavyCommands.has(command)) {
        rt.activeJobs.delete(remoteJid);
      }
    }
  }
}
