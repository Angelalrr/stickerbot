import { findBytesField, parseRawFields } from './protobuf.ts';

export const MESSAGE_STICKER_FIELD = 26;
export const STICKER_AUDIO_FIELD = 26;
export const STICKER_AUDIO_TAG = (STICKER_AUDIO_FIELD << 3) | 2;

const PATCHED = Symbol.for('stickerbot.sound-sticker-encode-patched');
const pendingAudio = new Map<string, Uint8Array>();

function keyOf(fileSha256: Uint8Array): string {
  return Buffer.from(fileSha256).toString('base64');
}

export function attachAudioToSticker(fileSha256: Uint8Array, audioMessageBytes: Uint8Array): void {
  pendingAudio.set(keyOf(fileSha256), audioMessageBytes);
}

export function detachAudioFromSticker(fileSha256: Uint8Array): void {
  pendingAudio.delete(keyOf(fileSha256));
}

export function getEmbeddedAudioSize(encodedMessage: Buffer | Uint8Array): number | null {
  const sticker = findBytesField(parseRawFields(encodedMessage), MESSAGE_STICKER_FIELD);
  if (!sticker?.payload) return null;
  const audio = findBytesField(parseRawFields(sticker.payload), STICKER_AUDIO_FIELD);
  return audio && typeof audio.length === 'number' ? audio.length : null;
}

interface PatchedEncodeFn {
  (message: { fileSha256?: Uint8Array } | null | undefined, writer?: unknown): {
    uint32: (tag: number) => { bytes: (data: Uint8Array) => void };
  };
  [PATCHED]?: boolean;
}

interface ProtoLike {
  Message?: {
    StickerMessage?: {
      encode?: PatchedEncodeFn;
    };
  };
}

export function installStickerAudioPatch(protoObj: unknown): void {
  const typed = protoObj as ProtoLike;
  const StickerMessage = typed?.Message?.StickerMessage;
  if (!StickerMessage || typeof StickerMessage.encode !== 'function') {
    throw new Error('No se encontró proto.Message.StickerMessage.encode en Baileys.');
  }

  if (StickerMessage.encode[PATCHED]) {
    return;
  }

  const originalEncode = StickerMessage.encode;

  const patchedEncode: PatchedEncodeFn = function patchedStickerEncode(
    this: unknown,
    message: { fileSha256?: Uint8Array } | null | undefined,
    writer?: unknown
  ) {
    const result = originalEncode.call(this, message, writer);
    try {
      if (message?.fileSha256) {
        const audio = pendingAudio.get(keyOf(message.fileSha256));
        if (audio) {
          result.uint32(STICKER_AUDIO_TAG).bytes(audio);
        }
      }
    } catch (err) {
      console.error('[StickerBot] No se pudo incrustar el audio en el campo 26:', err);
    }
    return result;
  };

  patchedEncode[PATCHED] = true;
  StickerMessage.encode = patchedEncode;
}
