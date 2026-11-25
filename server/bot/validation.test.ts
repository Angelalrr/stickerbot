import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { proto } from '@whiskeysockets/baileys';
import {
  BoundedIdCache,
  buildVideoScaleFilter,
  isAllowedGroup,
  parseCommand,
  parseVideoCropMode,
  sanitizePhoneForPairing,
  validateGroupJid,
  validatePin,
  validateUserId,
} from './validation.ts';
import {
  ConcurrencyQueue,
  sweepOrphanedTempFiles,
} from './mediaQueue.ts';
import {
  attachAudioToSticker,
  detachAudioFromSticker,
  getEmbeddedAudioSize,
  installStickerAudioPatch,
} from './stickerAudioPatch.ts';
import { buildRenderZipBuffer, collectExportFiles, shouldExcludeEntry } from '../routes/exportRender.ts';
import { checkFfmpegAvailable } from '../config.ts';
import { parseWebpInfo, runProcess, videoToAnimatedStickerWebp } from './mediaProcessors.ts';

test('parseCommand parses standard slash commands and //pingdiag', () => {
  const diagDouble = parseCommand('//pingdiag');
  assert.deepEqual(diagDouble, {
    command: 'pingdiag',
    argsText: '',
    args: [],
    rawPrefix: '//',
  });

  const diagSingle = parseCommand('/pingdiag');
  assert.equal(diagSingle?.command, 'pingdiag');

  const stickerCmd = parseCommand('/stickertexto rojo ¡Hola!');
  assert.equal(stickerCmd?.command, 'stickertexto');
  assert.equal(stickerCmd?.argsText, 'rojo ¡Hola!');
});

test('parseVideoCropMode defaults to centered square crop and respects completo / -full', () => {
  assert.equal(parseVideoCropMode(''), 'crop');
  assert.equal(parseVideoCropMode('algo'), 'crop');
  assert.equal(parseVideoCropMode('completo'), 'full');
  assert.equal(parseVideoCropMode('-full'), 'full');
  assert.equal(parseVideoCropMode('recorte -FULL'), 'full');

  const cropFilter = buildVideoScaleFilter(15, 512, 'crop');
  assert.ok(cropFilter.includes('force_original_aspect_ratio=increase'));
  assert.ok(cropFilter.includes('crop=512:512'));
  assert.ok(!cropFilter.includes('-vsync'));

  const fullFilter = buildVideoScaleFilter(15, 512, 'full');
  assert.ok(fullFilter.includes('force_original_aspect_ratio=decrease'));
  assert.ok(fullFilter.includes('pad=512:512'));
});

test('user, pin, phone pairing, and group validators enforce strict formats', () => {
  assert.equal(validateUserId('Victor_01').valid, true);
  assert.equal(validateUserId('Victor_01').normalized, 'victor_01');
  assert.equal(validateUserId('../etc').valid, false);
  assert.equal(validatePin('1234').valid, true);
  assert.equal(validatePin('12').valid, false);

  assert.equal(sanitizePhoneForPairing('+51 999-888-777').digits, '51999888777');
  assert.equal(sanitizePhoneForPairing('123').valid, false);

  assert.equal(validateGroupJid('120363012345678901@g.us').valid, true);
  assert.equal(validateGroupJid('51999888777@s.whatsapp.net').valid, false);

  assert.equal(isAllowedGroup('12036301@g.us', '12036301@g.us').allowed, true);
  assert.equal(isAllowedGroup('99999999@g.us', '12036301@g.us').allowed, false);
  assert.equal(isAllowedGroup('12036301@g.us', '').allowed, false);
});

test('BoundedIdCache tracks sent bot IDs to prevent fromMe loops', () => {
  const cache = new BoundedIdCache(3, 5000);
  cache.add('msg-1');
  cache.add('msg-2');
  cache.add('msg-3');
  cache.add('msg-4');
  assert.equal(cache.has('msg-1'), false);
  assert.equal(cache.has('msg-4'), true);
});

test('ConcurrencyQueue serializes FFmpeg jobs to maxConcurrency=1', async () => {
  const queue = new ConcurrencyQueue(1);
  let running = 0;
  let maxObserved = 0;

  await Promise.all(
    [1, 2, 3].map(() =>
      queue.run(async () => {
        running += 1;
        maxObserved = Math.max(maxObserved, running);
        await new Promise((r) => setTimeout(r, 15));
        running -= 1;
      })
    )
  );

  assert.equal(maxObserved, 1);
});

test('sweepOrphanedTempFiles removes old stickerbot-* temp files and keeps unrelated files', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-test-sweep-'));
  const oldTarget = path.join(sandbox, 'stickerbot-old.tmp');
  const keepOther = path.join(sandbox, 'other-file.txt');
  try {
    await fs.writeFile(oldTarget, 'temp');
    await fs.writeFile(keepOther, 'keep');
    const past = new Date(Date.now() - 20 * 60 * 1000);
    await fs.utimes(oldTarget, past, past);

    const deleted = await sweepOrphanedTempFiles(10 * 60 * 1000, sandbox);
    assert.equal(deleted, 1);

    const remaining = await fs.readdir(sandbox);
    assert.deepEqual(remaining, ['other-file.txt']);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test('installStickerAudioPatch embeds AudioMessage into field 26 for matching fileSha256 only', () => {
  installStickerAudioPatch(proto);

  const sha = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const audioBytes = proto.Message.AudioMessage.encode(
    proto.Message.AudioMessage.create({
      url: 'https://example.invalid/audio.ogg',
      mimetype: 'audio/ogg; codecs=opus',
      seconds: 3,
      ptt: true,
    })
  ).finish();

  attachAudioToSticker(sha, audioBytes);
  try {
    const encodedWithAudio = proto.Message.encode(
      proto.Message.create({
        stickerMessage: {
          url: 'https://example.invalid/sticker.webp',
          mimetype: 'image/webp',
          fileSha256: sha,
          isAnimated: true,
        },
      })
    ).finish();

    const embeddedSize = getEmbeddedAudioSize(encodedWithAudio);
    assert.equal(embeddedSize, audioBytes.length);
  } finally {
    detachAudioFromSticker(sha);
  }

  const encodedNormal = proto.Message.encode(
    proto.Message.create({
      stickerMessage: {
        url: 'https://example.invalid/normal.webp',
        mimetype: 'image/webp',
        fileSha256: Uint8Array.from({ length: 32 }, () => 9),
      },
    })
  ).finish();
  assert.equal(getEmbeddedAudioSize(encodedNormal), null);
});

test('exportRender includes Render files, excludes secrets/sessions, and generates valid PKZIP buffer', async () => {
  assert.equal(shouldExcludeEntry('node_modules', true), true);
  assert.equal(shouldExcludeEntry('.git', true), true);
  assert.equal(shouldExcludeEntry('auth_info', true), true);
  assert.equal(shouldExcludeEntry('.env', false), true);
  assert.equal(shouldExcludeEntry('.env.example', false), false);

  const files = await collectExportFiles();
  assert.ok(files.includes('Dockerfile'));
  assert.ok(files.includes('render.yaml'));
  assert.ok(files.includes('package.json'));
  assert.ok(files.includes('server.ts'));
  assert.ok(files.includes('README.md'));
  assert.ok(!files.some((f) => f.startsWith('node_modules/')));
  assert.ok(!files.some((f) => f.startsWith('StickerBot/')));

  const zipBuf = await buildRenderZipBuffer();
  assert.equal(zipBuf[0], 0x50);
  assert.equal(zipBuf[1], 0x4b);
  assert.ok(zipBuf.length > 5000);
});

test('videoToAnimatedStickerWebp crops 16:9 video to 512x512 square and cleans temp files', async (t) => {
  const ffmpegOk = await checkFfmpegAvailable();
  if (!ffmpegOk) {
    t.skip('FFmpeg no disponible en este entorno');
    return;
  }

  const samplePath = path.join(os.tmpdir(), `sb-sample-16x9-${Date.now()}.mp4`);
  try {
    await runProcess('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=15:duration=1.5',
      '-pix_fmt',
      'yuv420p',
      samplePath,
    ]);
    const inputBuf = await fs.readFile(samplePath);
    const result = await videoToAnimatedStickerWebp(inputBuf, {
      cropMode: 'crop',
      maxSeconds: 2,
      maxBytes: 500 * 1024,
    });
    const info = parseWebpInfo(result.buffer);
    assert.equal(info?.width, 512);
    assert.equal(info?.height, 512);
    assert.equal(info?.animated, true);
  } finally {
    await fs.rm(samplePath, { force: true }).catch(() => {});
  }
});
