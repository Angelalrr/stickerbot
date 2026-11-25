/**
 * Funciones puras de validacion, parseo de comandos y formato de mensajes.
 * Compatibles con ejecucion nativa Node 22 strip-types y tsx --test.
 */

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

/**
 * Detecta si un comando de video (/gif, /stickeranimado, /stickeraudio) pidio mantener
 * la proporcion completa (`completo` o `-full`) o usar el recorte cuadrado centrado por defecto.
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
