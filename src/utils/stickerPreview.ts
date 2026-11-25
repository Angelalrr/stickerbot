export interface StickerTextLayout {
  text: string;
  fillColor: string;
  strokeColor: string;
  lines: string[];
  fontSize: number;
  lineHeight: number;
  strokeWidth: number;
  firstBaselineY: number;
}

export interface CommandDoc {
  command: string;
  aliases?: string[];
  category: 'General' | 'Stickers';
  summary: string;
  example: string;
  sampleReply: string;
  requiresFfmpeg?: boolean;
}

export const STICKER_COLORS: Array<{ name: string; label: string; hex: string }> = [
  { name: 'blanco', label: 'Blanco', hex: '#FFFFFF' },
  { name: 'amarillo', label: 'Amarillo', hex: '#FACC15' },
  { name: 'rojo', label: 'Rojo', hex: '#EF4444' },
  { name: 'azul', label: 'Azul', hex: '#3B82F6' },
  { name: 'verde', label: 'Verde', hex: '#22C55E' },
  { name: 'morado', label: 'Morado', hex: '#A855F7' },
  { name: 'naranja', label: 'Naranja', hex: '#F97316' },
  { name: 'negro', label: 'Negro', hex: '#111827' },
];

const COLOR_MAP: Record<string, string> = Object.fromEntries(
  STICKER_COLORS.map((c) => [c.name, c.hex])
);

export function resolvePreviewColor(candidate: string): string | null {
  const clean = candidate.trim().toLowerCase();
  if (COLOR_MAP[clean]) return COLOR_MAP[clean];
  if (/^#[0-9a-f]{6}$/i.test(clean)) return clean.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(clean)) {
    const [, r, g, b] = clean;
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return null;
}

export function wrapPreviewLines(text: string, maxCharsPerLine = 13): string[] {
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

  if (currentLine) {
    lines.push(currentLine);
  }
  return lines.slice(0, 6);
}

export function computeStickerTextLayout(rawInput: string, forcedColorHex?: string): StickerTextLayout {
  const trimmed = rawInput.trim().replace(/^\/stickertexto\s*/i, '');
  const tokens = trimmed ? trimmed.split(/\s+/) : [];
  let fillColor = forcedColorHex || '#FFFFFF';
  let startIdx = 0;

  if (!forcedColorHex && tokens.length > 1) {
    const first = tokens[0].toLowerCase().replace(/^color:/, '');
    const parsedColor = resolvePreviewColor(first);
    if (parsedColor) {
      fillColor = parsedColor;
      startIdx = 1;
    }
  }

  const text = (tokens.slice(startIdx).join(' ') || 'Hola mundo').slice(0, 90);
  const strokeColor = fillColor.toUpperCase() === '#111827' ? '#FFFFFF' : '#0F172A';
  const maxChars = text.length <= 14 ? 9 : text.length <= 36 ? 12 : 16;
  const lines = wrapPreviewLines(text, maxChars);
  const longestLine = Math.max(...lines.map((l) => Array.from(l).length), 1);

  const widthBasedSize = Math.floor(430 / Math.max(longestLine * 0.62, 1));
  const heightBasedSize = Math.floor(420 / Math.max(lines.length * 1.18, 1));
  const fontSize = Math.max(30, Math.min(110, widthBasedSize, heightBasedSize));

  const lineHeight = Math.round(fontSize * 1.16);
  const strokeWidth = Math.max(6, Math.round(fontSize * 0.14));
  const totalHeight = lineHeight * lines.length;
  const firstBaselineY = Math.round((512 - totalHeight) / 2 + fontSize * 0.84);

  return {
    text,
    fillColor,
    strokeColor,
    lines,
    fontSize,
    lineHeight,
    strokeWidth,
    firstBaselineY,
  };
}

export const COMMAND_DOCS: CommandDoc[] = [
  {
    command: '/menu',
    category: 'General',
    summary: 'Muestra todos los comandos generales, de stickers y ejemplos rápidos en el grupo.',
    example: '/menu',
    sampleReply: `┌──────────────────────┐\n STICKERBOT\n Tu creador de stickers\n└──────────────────────┘\n\nGeneral:\n• /menu — Muestra esta lista de comandos.\n• /ayuda — Guía rápida paso a paso.\n• /ping — Comprueba si el bot responde.\n• //pingdiag — Muestra el ID de este grupo.\n• /info — Configuración y estado de FFmpeg.\n• /version — Versión del proyecto y librerías.\n• /cancelar — Cancela un sticker en proceso.\n\nStickers:\n• /sticker o /s — Imagen a sticker.\n• /stickertexto <texto> — Sticker con texto.\n• /gif o /stickeranimado — Video/GIF animado (recorte cuadrado o "completo").\n• /stickeraudio — Sound Sticker nativo con audio.`,
  },
  {
    command: '//pingdiag',
    aliases: ['/pingdiag'],
    category: 'General',
    summary: 'Detecta y muestra el ID (@g.us) del grupo actual en WhatsApp y lo envía directo a tu panel web para autorizarlo.',
    example: '//pingdiag',
    sampleReply: `┌──────────────────────┐\n STICKERBOT\n Tu creador de stickers\n└──────────────────────┘\n\nID de este grupo detectado:\n120363012345678901@g.us\n\nCopia este ID o pulsa "Usar este grupo" en tu panel web de StickerBot.`,
  },
  {
    command: '/ping',
    category: 'General',
    summary: 'Comprueba al instante que el bot está conectado y escuchando en el grupo autorizado.',
    example: '/ping',
    sampleReply: `┌──────────────────────┐\n STICKERBOT\n Tu creador de stickers\n└──────────────────────┘\n\n¡Hola! Estoy funcionando correctamente.\n\nUsa "/menu" para ver mis comandos.`,
  },
  {
    command: '/ayuda',
    category: 'General',
    summary: 'Envía una guía breve dentro de WhatsApp explicando cómo usar fotos, texto, videos y recorte completo.',
    example: '/ayuda',
    sampleReply: `┌──────────────────────┐\n STICKERBOT\n Tu creador de stickers\n└──────────────────────┘\n\n1. Fotos: Responde con /sticker o /s.\n2. Texto: Escribe /stickertexto Tu frase aquí.\n3. Videos: Responde con /gif, /stickeranimado o /stickeraudio (usa "completo" o "-full" para evitar recorte cuadrado).`,
  },
  {
    command: '/info',
    category: 'General',
    summary: 'Informa el nombre del pack, límites configurados y disponibilidad de FFmpeg en el servidor.',
    example: '/info',
    sampleReply: `┌──────────────────────┐\n STICKERBOT\n Tu creador de stickers\n└──────────────────────┘\n\nNombre: StickerBot\nPaquete: StickerBot Pack\nFFmpeg disponible: Sí\nSound Stickers nativos: Activados (campo 26)`,
  },
  {
    command: '/version',
    category: 'General',
    summary: 'Muestra la versión de StickerBot, Node.js, plataforma y motor Baileys v7.',
    example: '/version',
    sampleReply: `┌──────────────────────┐\n STICKERBOT\n Tu creador de stickers\n└──────────────────────┘\n\nStickerBot v2.0.0\nNode.js: v22.x\nPlataforma: linux\nMotor WhatsApp: @whiskeysockets/baileys v7 (ESM)`,
  },
  {
    command: '/cancelar',
    category: 'General',
    summary: 'Detiene inmediatamente un proceso largo de FFmpeg que esté corriendo en el grupo.',
    example: '/cancelar',
    sampleReply: `┌──────────────────────┐\n STICKERBOT\n Tu creador de stickers\n└──────────────────────┘\n\nOperación cancelada correctamente.`,
  },
  {
    command: '/sticker',
    aliases: ['/s'],
    category: 'Stickers',
    summary: 'Convierte fotos JPG, PNG o WebP a sticker 512x512 conservando la proporción completa y transparencia (sin recortar).',
    example: 'Responder a una foto con /sticker',
    sampleReply: '[Sticker WebP 512x512 enviado como respuesta a tu foto]',
  },
  {
    command: '/stickertexto',
    category: 'Stickers',
    summary: 'Genera un sticker transparente 512x512 con texto centrado, contorno grueso, sombra y emojis.',
    example: '/stickertexto rojo ¡Listo! 😎',
    sampleReply: '[Sticker WebP 512x512 transparente con el texto "¡Listo! 😎"]',
  },
  {
    command: '/gif',
    aliases: ['/stickeranimado'],
    category: 'Stickers',
    summary: 'Convierte GIFs o videos cortos en stickers animados WebP (< 500 KB) con recorte cuadrado centrado automático. Añade "completo" o "-full" para conservar todos los bordes.',
    example: '/stickeranimado (o /stickeranimado completo)',
    requiresFfmpeg: true,
    sampleReply: '[Sticker WebP animado 512x512 sin audio, recorte cuadrado centrado por defecto]',
  },
  {
    command: '/stickeraudio',
    category: 'Stickers',
    summary: 'Convierte un video con sonido en un único Sound Sticker nativo (WebP animado con recorte cuadrado centrado + OGG/Opus en campo 26). Admite "completo" o "-full".',
    example: '/stickeraudio (o /stickeraudio -full)',
    requiresFfmpeg: true,
    sampleReply: `[Único Sound Sticker WebP animado 512x512 + AudioMessage OGG/Opus sincronizado en campo 26, con icono de volumen y reproducción al pulsar]`,
  },
];
