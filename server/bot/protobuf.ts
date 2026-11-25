/**
 * Lector minimalista de formato binario Protobuf (sin esquema).
 * Permite verificar el campo 26 (AudioMessage) incrustado dentro de StickerMessage.
 */

const WIRE = Object.freeze({
  VARINT: 0,
  FIXED64: 1,
  BYTES: 2,
  FIXED32: 5,
});

export interface RawProtobufField {
  field: number;
  type: 'varint' | 'fixed64' | 'fixed32' | 'bytes';
  value?: string;
  length?: number;
  payload?: Buffer;
}

export function readVarint(buffer: Uint8Array, position: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;

  for (;;) {
    const byte = buffer[position++];
    if (byte === undefined) {
      throw new Error('Fin inesperado del buffer al leer varint.');
    }
    result |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) {
      return [result, position];
    }
    shift += 7n;
  }
}

export function parseRawFields(input: Buffer | Uint8Array): RawProtobufField[] {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const fields: RawProtobufField[] = [];
  let position = 0;

  while (position < buffer.length) {
    let tag: bigint;
    [tag, position] = readVarint(buffer, position);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);

    if (field === 0) {
      throw new Error('Número de campo protobuf inválido (0).');
    }

    if (wire === WIRE.VARINT) {
      let value: bigint;
      [value, position] = readVarint(buffer, position);
      fields.push({ field, type: 'varint', value: value.toString() });
    } else if (wire === WIRE.FIXED64 || wire === WIRE.FIXED32) {
      const size = wire === WIRE.FIXED64 ? 8 : 4;
      if (position + size > buffer.length) {
        throw new Error('Fin inesperado del buffer al leer campo fijo.');
      }
      fields.push({ field, type: wire === WIRE.FIXED64 ? 'fixed64' : 'fixed32' });
      position += size;
    } else if (wire === WIRE.BYTES) {
      let length: bigint;
      [length, position] = readVarint(buffer, position);
      const size = Number(length);
      if (position + size > buffer.length) {
        throw new Error('Fin inesperado del buffer al leer campo bytes.');
      }
      fields.push({
        field,
        type: 'bytes',
        length: size,
        payload: buffer.subarray(position, position + size),
      });
      position += size;
    } else {
      throw new Error(`Tipo de cable protobuf no soportado: ${wire}`);
    }
  }

  return fields;
}

export function findBytesField(
  fields: RawProtobufField[],
  fieldNumber: number
): RawProtobufField | undefined {
  return fields.find((f) => f.field === fieldNumber && f.type === 'bytes');
}
