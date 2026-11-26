/**
 * Funciones puras de validacion, parseo de comandos y formato de mensajes.
 * Compatibles con ejecucion nativa Node 22 strip-types y tsx --test.
 */

import net from 'node:net';

export type VideoCropMode = 'crop' | 'full';

export interface ParsedCommand {
  command: string;
  argsText: string;
  args: string[];
  rawPrefix: string;
}

const COLOR_MAP: Record<string, string> = Object.freeze({
  blanco: '#FFFFFF',
  white: '#FFFFFF',
  negro: '#111827',
  black: '#111827',
  rojo: '#EF4444',
  red: '#EF4444',
  azul: '#3B82F6',
  blue: '#3B82F6',
  verde: '#22C55E',
  green: '#22C55E',
  amarillo: '#FACC15',
  yellow: '#FACC15',
  naranja: '#F97316',
  orange: '#F97316',
  morado: '#A855F7',
  purple: '#A855F7',
  rosa: '#EC4899',
  pink: '#EC4899',
  celeste: '#06B6D4',
  cyan: '#06B6D4',
});

export function validateUserId(userId: string): { valid: boolean; normalized: string; error?: string } {
  if (typeof userId !== 'string') {
    return { valid: false, normalized: '', error: 'El usuario debe ser un texto.' };
  }
  const normalized = userId.trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,32}$/.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'El usuario debe tener entre 3 y 32 caracteres (solo letras, números, guiones o guion bajo).',
    };
  }
  return { valid: true, normalized };
}

export function validatePin(pin: string): { valid: boolean; error?: string } {
  if (typeof pin !== 'string' || pin.trim().length < 4 || pin.length > 32) {
    return { valid: false, error: 'El PIN debe tener entre 4 y 32 caracteres.' };
  }
  return { valid: true };
}

export function sanitizePhoneForPairing(rawPhone: string): { valid: boolean; digits: string; error?: string } {
  if (typeof rawPhone !== 'string') {
    return { valid: false, digits: '', error: 'Ingresa un número de teléfono válido.' };
  }
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    return {
      valid: false,
      digits,
      error: 'Ingresa tu número completo con código de país (ej. 51999888777, entre 8 y 15 dígitos).',
    };
  }
  return { valid: true, digits };
}

export function validateGroupJid(jid: string): { valid: boolean; normalized: string; error?: string } {
  if (typeof jid !== 'string') {
    return { valid: false, normalized: '', error: 'El ID de grupo debe ser un texto.' };
  }
  const normalized = jid.trim();
  if (!/^[a-zA-Z0-9._-]+@g\.us$/.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'El ID de grupo debe terminar en @g.us (por ejemplo: 120363012345678901@g.us).',
    };
  }
  return { valid: true, normalized };
}

export function formatBotReply(body: string, botName = 'StickerBot'): string {
  const header = [
    '┌──────────────────────┐',
    ` ${botName.toUpperCase()}`,
    ' Tu creador de stickers',
    '└──────────────────────┘',
  ].join('\n');
  return `${header}\n\n${body.trim()}`;
}

/**
 * Extrae comando y argumentos.
 * Reconoce comandos con `/` (ej. /sticker, /pingdiag) y tambien `//pingdiag` para diagnostico.
 */
export function parseCommand(text: string, prefix = '/'): ParsedCommand | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith(prefix)) return null;

  let rawPrefix = prefix;
  let withoutPrefix = trimmed.slice(prefix.length);

  if (withoutPrefix.startsWith('/pingdiag')) {
    rawPrefix = '//';
    withoutPrefix = withoutPrefix.slice(1);
  }

  withoutPrefix = withoutPrefix.trim();
  if (!withoutPrefix) return null;

  const firstSpaceIdx = withoutPrefix.search(/\s/);
  const rawCommand = firstSpaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, firstSpaceIdx);

  const command = rawCommand.toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(command)) return null;

  const argsText = firstSpaceIdx === -1 ? '' : withoutPrefix.slice(firstSpaceIdx + 1).trim();
  const args = argsText ? argsText.split(/\s+/) : [];
  return { command, argsText, args, rawPrefix };
}

export interface TrimWindow {
  start: number;
  duration: number;
}

/**
 * Resuelve y valida la ventana temporal que el usuario recorto en el creador web.
 * El limite superior es la duracion maxima de stickers animados de WhatsApp (maxSeconds).
 */
export function resolveTrimWindow(
  rawStart: unknown,
  rawDuration: unknown,
  videoDurationSeconds: number | null,
  maxSeconds: number
): { valid: boolean; start: number; duration: number; error?: string } {
  const start = Number(rawStart);
  const duration = Number(rawDuration);

  if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0) {
    return {
      valid: false,
      start: 0,
      duration: 0,
      error: 'El recorte del video es inválido. Vuelve a seleccionar el fragmento.',
    };
  }

  if (duration < 0.5) {
    return {
      valid: false,
      start,
      duration,
      error: 'Selecciona al menos 0.5 segundos de video.',
    };
  }

  if (duration > maxSeconds + 0.25) {
    return {
      valid: false,
      start,
      duration,
      error: `Los stickers animados de WhatsApp duran máximo ${maxSeconds} segundos. Acorta el recorte.`,
    };
  }

  if (
    videoDurationSeconds !== null &&
    Number.isFinite(videoDurationSeconds) &&
    videoDurationSeconds > 0 &&
    start + duration > videoDurationSeconds + 0.5
  ) {
    return {
      valid: false,
      start,
      duration,
      error: 'El recorte termina después del final del video. Ajusta el fragmento.',
    };
  }

  return {
    valid: true,
    start: Math.round(start * 1000) / 1000,
    duration: Math.round(duration * 1000) / 1000,
  };
}

/**
 * Detecta si un comando de video (/gif, /stickeranimado, /stickeraudio) pidio mantener
 * la proporción completa (`completo` o `-full`) o usar el recorte cuadrado centrado por defecto.
 */
export function parseVideoCropMode(argsText: string): VideoCropMode {
  const tokens = (argsText || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.includes('completo') || tokens.includes('-full')) {
    return 'full';
  }
  return 'crop';
}

/**
 * Parsea un tiempo de inicio en segundos aceptando formatos: número, número+s, mm:ss, hh:mm:ss.
 * Devuelve el tiempo en segundos o null si es inválido.
 */
export function parseStartTime(raw: string): number | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();

  // Formato hh:mm:ss
  const hhmmss = s.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (hhmmss) {
    const h = parseInt(hhmmss[1], 10);
    const m = parseInt(hhmmss[2], 10);
    const sec = parseInt(hhmmss[3], 10);
    if (h >= 0 && m >= 0 && sec >= 0) return h * 3600 + m * 60 + sec;
    return null;
  }

  // Formato mm:ss o ss puros
  const mmss = s.match(/^(\d{1,2}):(\d{2})$/);
  if (mmss) {
    const min = parseInt(mmss[1], 10);
    const sec = parseInt(mmss[2], 10);
    if (min >= 0 && sec >= 0) return min * 60 + sec;
    return null;
  }

  // Número puro con sufijo opcional 's'
  const num = s.replace(/s$/, '').trim();
  const val = Number(num);
  if (!Number.isFinite(val) || val < 0) return null;
  return val;
}

/**
 * Valida que una URL no tenga SSRF (sin credenciales, sin localhost, sin IPs privadas).
 * Retorna la URL limpia o lanza error.
 */
export function validateUrlAntiSsrf(rawUrl: string): string {
  const url = (rawUrl || '').trim();
  if (!url) throw new Error('Pega una URL válida.');

  // Debe empezar con http:// o https://
  if (!(url.startsWith('http://') || url.startsWith('https://'))) {
    throw new Error('La URL debe comenzar con http:// o https://');
  }

  // No permitir credenciales user:pass@
  if (url.includes('@')) {
    throw new Error('No se permiten credenciales (user:pass@) dentro de la URL.');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('URL inválida.');
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isPrivateOrLocalHost(host)) {
    throw new Error('No se permiten direcciones locales o IPs privadas.');
  }
  return url;
}

/** Detecta localhost, dominios .local y direcciones IP privadas/reservadas. */
export function isPrivateOrLocalHost(host: string): boolean {
  const clean = (host || '').toLowerCase().trim();
  if (!clean) return true;
  if (clean === 'localhost' || clean === 'localhost.localdomain') return true;
  if (clean.endsWith('.localhost') || clean.endsWith('.local')) return true;

  const version = net.isIP(clean);
  if (version === 4) {
    const parts = clean.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (version === 6) {
    if (clean === '::1' || clean === '::') return true;
    if (clean.startsWith('fc') || clean.startsWith('fd')) return true; // ULA
    if (clean.startsWith('fe80')) return true; // link-local
    return false;
  }
  return false; // es un hostname público
}

/**
 * Detecta si un comando de video incluye un tiempo de inicio.
 * Retorna el tiempo en segundos o null.
 */
export function extractStartTimeFromArgs(argsText: string): number | null {
  const tokens = (argsText || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    const start = parseStartTime(tokens[i]);
    if (start !== null) {
      // Verificar que el siguiente token no sea 'completo' o '-full'
      if (tokens[i + 1] && (tokens[i + 1] === 'completo' || tokens[i + 1] === '-full')) {
        // El tiempo va antes de completo/-full, está bien
      }
      return start;
    }
  }
  return null;
}

/**
 * Separa la URL y el tiempo de inicio de los argumentos del comando.
 * Retorna { url, startTimeSeconds, restArgs }.
 */
export function parseUrlAndStartTime(argsText: string): { url: string | null; startTime: number | null; restArgs: string } {
  const tokens = (argsText || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  let url: string | null = null;
  let startTime: number | null = null;
  const rest: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const start = parseStartTime(token);
    if (start !== null && startTime === null) {
      // Este es un tiempo de inicio
      startTime = start;
      i++;
      continue;
    }
    // Verificar si es modo completo/-full
    if (token === 'completo' || token === '-full') {
      i++;
      continue;
    }
    // Si aún no tenemos URL, podría ser una URL
    if (url === null) {
      // Validar rápidamente si parece una URL
      if ((token.startsWith('http://') || token.startsWith('https://'))) {
        url = token;
        i++;
        continue;
      }
    }
    rest.push(token);
    i++;
  }

  return { url: url || null, startTime: startTime || null, restArgs: rest.join(' ') };
}

export function buildVideoScaleFilter(fps: number, size: number, cropMode: VideoCropMode): string {
  if (cropMode === 'full') {
    return `fps=${fps},scale=${size}:${size}:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
  }
  return `fps=${fps},scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size},scale=512:512:flags=lanczos`;
}

export function isAllowedGroup(
  remoteJid: string | undefined | null,
  authorizedGroupJid: string
): { allowed: boolean; reason: string } {
  if (!remoteJid || typeof remoteJid !== 'string') {
    return { allowed: false, reason: 'missing_jid' };
  }
  if (!remoteJid.endsWith('@g.us')) {
    return { allowed: false, reason: 'not_a_group' };
  }
  const cleanAuth = (authorizedGroupJid || '').trim();
  if (!cleanAuth) {
    return { allowed: false, reason: 'no_authorized_group_configured' };
  }
  if (remoteJid !== cleanAuth) {
    return { allowed: false, reason: 'unauthorized_group' };
  }
  return { allowed: true, reason: 'authorized' };
}

export function validateMediaBuffer(
  buffer: Uint8Array | null | undefined,
  maxBytes: number,
  label = 'archivo'
): { valid: boolean; error?: string } {
  if (!buffer || !(buffer instanceof Uint8Array) || buffer.length === 0) {
    return { valid: false, error: `El ${label} está vacío o no se pudo descargar.` };
  }
  if (buffer.length > maxBytes) {
    const maxMb = (maxBytes / (1024 * 1024)).toFixed(1);
    const actualMb = (buffer.length / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `El ${label} pesa ${actualMb} MB y supera el límite seguro de ${maxMb} MB.`,
    };
  }
  return { valid: true };
}

export function resolveColor(candidate: string): string | null {
  if (!candidate) return null;
  const clean = candidate.trim().toLowerCase();
  if (COLOR_MAP[clean]) return COLOR_MAP[clean];
  if (/^#[0-9a-f]{6}$/i.test(clean)) return clean.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(clean)) {
    const [, r, g, b] = clean;
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return null;
}

export function parseTextStickerArgs(rawArgs: string): {
  text: string;
  fillColor: string;
  strokeColor: string;
} {
  const input = (rawArgs || '').trim();
  if (!input) {
    return { text: '', fillColor: '#FFFFFF', strokeColor: '#0F172A' };
  }

  const tokens = input.split(/\s+/);
  const firstLower = tokens[0].toLowerCase();
  let fillColor = '#FFFFFF';
  let textStartIndex = 0;

  if (firstLower.startsWith('color:')) {
    const candidate = firstLower.slice(6);
    const resolved = resolveColor(candidate);
    if (resolved && tokens.length > 1) {
      fillColor = resolved;
      textStartIndex = 1;
    }
  } else {
    const resolved = resolveColor(firstLower);
    if (resolved && tokens.length > 1) {
      fillColor = resolved;
      textStartIndex = 1;
    }
  }

  const text = tokens.slice(textStartIndex).join(' ').trim();
  const strokeColor = fillColor.toUpperCase() === '#111827' ? '#FFFFFF' : '#0F172A';

  return { text, fillColor, strokeColor };
}

export function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export class BoundedIdCache {
  maxSize: number;
  ttlMs: number;
  entries: Map<string, number>;

  constructor(maxSize = 1000, ttlMs = 5 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  add(id: string | null | undefined): void {
    if (!id) return;
    const now = Date.now();
    this.prune(now);
    if (this.entries.size >= this.maxSize) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(id, now + this.ttlMs);
  }

  has(id: string | null | undefined): boolean {
    if (!id) return false;
    const expiresAt = this.entries.get(id);
    if (expiresAt === undefined) return false;
    if (Date.now() > expiresAt) {
      this.entries.delete(id);
      return false;
    }
    return true;
  }

  prune(now = Date.now()): void {
    for (const [key, expiresAt] of this.entries.entries()) {
      if (expiresAt <= now) {
        this.entries.delete(key);
      } else {
        break;
      }
    }
  }
}

export function maskJid(jid: string | undefined | null): string {
  if (!jid || typeof jid !== 'string') return 'desconocido';
  const [userPart, domain] = jid.split('@');
  if (!domain) return '***';
  const visible = userPart.slice(-4);
  return `***${visible}@${domain}`;
}
