import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { ZipArchive } from 'archiver';
import type { Request, Response } from 'express';
import { ROOT_DIR } from '../config.ts';

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'temp',
  'data',
  '.playwright-cli',
  '.aistudio',
  'StickerBot',
]);

const EXCLUDED_DIR_PREFIXES = ['auth_', 'whatsapp_session'];

const EXCLUDED_FILES = new Set([
  '.env',
  '.DS_Store',
  'bun.lock',
]);

export function shouldExcludeEntry(name: string, isDirectory: boolean): boolean {
  if (isDirectory) {
    if (EXCLUDED_DIRS.has(name)) return true;
    return EXCLUDED_DIR_PREFIXES.some((prefix) => name.startsWith(prefix));
  }
  if (EXCLUDED_FILES.has(name)) return true;
  if (name.startsWith('.env.') && name !== '.env.example') return true;
  if (name.endsWith('.zip') || name.endsWith('.log')) return true;
  return false;
}

export async function collectExportFiles(baseDir = ROOT_DIR): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentDir: string, relativeBase: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const isDir = entry.isDirectory();
      if (shouldExcludeEntry(entry.name, isDir)) continue;

      const relPath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
      const absPath = path.join(currentDir, entry.name);

      if (isDir) {
        await walk(absPath, relPath);
      } else if (entry.isFile()) {
        results.push(relPath);
      }
    }
  }

  await walk(baseDir, '');
  results.sort();
  return results;
}

export async function buildRenderZipBuffer(baseDir = ROOT_DIR): Promise<Buffer> {
  const relPaths = await collectExportFiles(baseDir);

  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({
      zlib: { level: 6 },
      forceZip64: false,
    });

    const stream = new PassThrough();
    const chunks: Buffer[] = [];

    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', reject);
    archive.on('error', reject);

    archive.pipe(stream);

    for (const relPath of relPaths) {
      const absPath = path.join(baseDir, relPath);
      archive.file(absPath, { name: `StickerBot-Render/${relPath}` });
    }

    void archive.finalize();
  });
}

export async function handleExportRender(_req: Request, res: Response): Promise<void> {
  try {
    const zipBuffer = await buildRenderZipBuffer(ROOT_DIR);
    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="StickerBot-Render.zip"');
    res.setHeader('Content-Length', String(zipBuffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.send(zipBuffer);
  } catch (err) {
    console.error('[StickerBot] Error generando StickerBot-Render.zip:', err);
    res.status(500).json({
      error: 'No se pudo generar el archivo StickerBot-Render.zip en el servidor.',
    });
  }
}
