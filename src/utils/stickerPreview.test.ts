import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMAND_DOCS,
  computeStickerTextLayout,
  resolvePreviewColor,
  wrapPreviewLines,
} from './stickerPreview';

test('resolvePreviewColor converts color names and short hex codes', () => {
  assert.equal(resolvePreviewColor('rojo'), '#EF4444');
  assert.equal(resolvePreviewColor('#0f0'), '#00FF00');
  assert.equal(resolvePreviewColor('inexistente'), null);
});

test('wrapPreviewLines limits line width and keeps up to 6 lines', () => {
  const lines = wrapPreviewLines('Esta frase tiene varias palabras para dividir en lineas', 12);
  assert.ok(lines.length >= 2 && lines.length <= 6);
  for (const line of lines) {
    assert.ok(line.length <= 12);
  }
});

test('computeStickerTextLayout extracts inline color and keeps font readable', () => {
  const layout = computeStickerTextLayout('/stickertexto azul Buenos dias');
  assert.equal(layout.text, 'Buenos dias');
  assert.equal(layout.fillColor, '#3B82F6');
  assert.equal(layout.strokeColor, '#0F172A');
  assert.ok(layout.fontSize >= 30 && layout.fontSize <= 110);
});

test('COMMAND_DOCS covers all required general and sticker commands', () => {
  const commands = COMMAND_DOCS.map((c) => c.command);
  for (const required of [
    '/menu',
    '/ayuda',
    '/ping',
    '/info',
    '/version',
    '/cancelar',
    '/sticker',
    '/stickertexto',
    '/gif',
    '/stickeraudio',
  ]) {
    assert.ok(commands.includes(required), `Missing ${required}`);
  }
});
