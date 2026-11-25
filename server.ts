import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config, getSystemCapabilities, ROOT_DIR } from './server/config.ts';
import {
  issueSessionToken,
  requireAuth,
  type AuthenticatedRequest,
} from './server/auth/sessionAuth.ts';
import { HybridUserStore } from './server/storage/userStore.ts';
import { MultiUserSessionManager } from './server/bot/sessionManager.ts';
import {
  startTempCleanupScheduler,
  sweepOrphanedTempFiles,
  videoProcessingQueue,
} from './server/bot/mediaQueue.ts';
import {
  sanitizePhoneForPairing,
  validateGroupJid,
  validatePin,
  validateUserId,
} from './server/bot/validation.ts';
import { handleStickerCreate } from './server/routes/stickerCreate.ts';

async function bootstrap(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // Subidas del creador web en memoria (Sharp/FFmpeg trabajan sobre Buffer)
  const stickerUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: Math.max(config.maxImageBytes, config.maxVideoBytes) + 1024,
      files: 1,
    },
  });

  const store = new HybridUserStore();
  await store.init();

  const sessionManager = new MultiUserSessionManager(store);

  // Limpiar archivos temporales huerfanos al iniciar y cada 10 minutos
  await sweepOrphanedTempFiles(0);
  startTempCleanupScheduler();

  // Ruta rapida para cron-job.org y Render Health Check (sin tocar DB ni WhatsApp)
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/api/system/status', async (_req, res) => {
    try {
      const capabilities = await getSystemCapabilities(store.mode);
      res.status(200).json({
        ...capabilities,
        limits: {
          maxImageMb: Math.round(config.maxImageBytes / (1024 * 1024)),
          maxVideoMb: Math.round(config.maxVideoBytes / (1024 * 1024)),
          maxVideoSeconds: config.maxVideoSeconds,
          maxStickerKb: Math.round(config.maxStickerBytes / 1024),
        },
        queue: videoProcessingQueue.stats(),
      });
    } catch {
      res.status(200).json({
        ffmpegAvailable: false,
        ffprobeAvailable: false,
        mongodbConfigured: Boolean(config.mongodbUri),
        dbMode: store.mode,
        limits: {
          maxImageMb: Math.round(config.maxImageBytes / (1024 * 1024)),
          maxVideoMb: Math.round(config.maxVideoBytes / (1024 * 1024)),
          maxVideoSeconds: config.maxVideoSeconds,
          maxStickerKb: Math.round(config.maxStickerBytes / 1024),
        },
        queue: videoProcessingQueue.stats(),
      });
    }
  });

  // Grupos a los que pertenece la cuenta vinculada (para el selector del creador web)
  app.get('/api/session/groups', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const groups = await sessionManager.listUserGroups(req.authUserId!);
      res.status(200).json({ groups });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'No se pudieron listar los grupos de tu WhatsApp.';
      res.status(400).json({ error: message });
    }
  });

  // Creador de stickers web: foto/video/texto procesado en el servidor y enviado al grupo
  app.post(
    '/api/sticker/create',
    requireAuth,
    stickerUpload.single('file'),
    (req: AuthenticatedRequest, res) => {
      void handleStickerCreate(req, res, store, sessionManager);
    }
  );

  app.post('/api/auth/register', async (req, res) => {
    try {
      const rawUserId = typeof req.body?.userId === 'string' ? req.body.userId : '';
      const rawPin = typeof req.body?.pin === 'string' ? req.body.pin : '';

      const idCheck = validateUserId(rawUserId);
      if (!idCheck.valid) {
        res.status(400).json({ error: idCheck.error });
        return;
      }

      const pinCheck = validatePin(rawPin);
      if (!pinCheck.valid) {
        res.status(400).json({ error: pinCheck.error });
        return;
      }

      const user = await store.registerUser(idCheck.normalized, rawPin);
      const token = issueSessionToken(user.userId);
      const snapshot = await sessionManager.getSnapshot(user.userId);

      res.status(201).json({
        token,
        user: {
          userId: user.userId,
          authorizedGroupJid: user.authorizedGroupJid,
        },
        session: snapshot,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo registrar el usuario.';
      const status = message.includes('ya existe') ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const rawUserId = typeof req.body?.userId === 'string' ? req.body.userId : '';
      const rawPin = typeof req.body?.pin === 'string' ? req.body.pin : '';

      const idCheck = validateUserId(rawUserId);
      const pinCheck = validatePin(rawPin);
      if (!idCheck.valid || !pinCheck.valid) {
        res.status(400).json({ error: 'Usuario o PIN con formato inválido.' });
        return;
      }

      const user = await store.authenticateUser(idCheck.normalized, rawPin);
      if (!user) {
        res.status(401).json({ error: 'Usuario o PIN incorrecto.' });
        return;
      }

      const token = issueSessionToken(user.userId);
      const snapshot = await sessionManager.getSnapshot(user.userId);

      res.status(200).json({
        token,
        user: {
          userId: user.userId,
          authorizedGroupJid: user.authorizedGroupJid,
        },
        session: snapshot,
      });
    } catch {
      res.status(500).json({ error: 'Error interno al iniciar sesión.' });
    }
  });

  app.get('/api/session/status', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const snapshot = await sessionManager.getSnapshot(req.authUserId!);
      res.status(200).json(snapshot);
    } catch {
      res.status(500).json({ error: 'No se pudo obtener el estado de WhatsApp.' });
    }
  });

  app.post('/api/session/connect-qr', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const snapshot = await sessionManager.startSession(req.authUserId!, { mode: 'qr' });
      res.status(200).json(snapshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo iniciar la sesión QR.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/session/connect-pairing', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const rawPhone = typeof req.body?.phoneNumber === 'string' ? req.body.phoneNumber : '';
      const phoneCheck = sanitizePhoneForPairing(rawPhone);
      if (!phoneCheck.valid) {
        res.status(400).json({ error: phoneCheck.error });
        return;
      }
      const snapshot = await sessionManager.startSession(req.authUserId!, {
        mode: 'pairing',
        phoneNumber: phoneCheck.digits,
      });
      res.status(200).json(snapshot);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'No se pudo generar el código de 8 dígitos.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/session/disconnect', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const snapshot = await sessionManager.disconnectSession(req.authUserId!, false);
      res.status(200).json(snapshot);
    } catch {
      res.status(500).json({ error: 'No se pudo desconectar la sesión.' });
    }
  });

  app.post('/api/session/logout', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const snapshot = await sessionManager.disconnectSession(req.authUserId!, true);
      res.status(200).json(snapshot);
    } catch {
      res.status(500).json({ error: 'No se pudo cerrar la sesión de WhatsApp.' });
    }
  });

  app.put('/api/session/group', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const rawGroup = typeof req.body?.groupJid === 'string' ? req.body.groupJid : '';
      const trimmed = rawGroup.trim();

      if (trimmed !== '') {
        const check = validateGroupJid(trimmed);
        if (!check.valid) {
          res.status(400).json({ error: check.error });
          return;
        }
        await store.setAuthorizedGroup(req.authUserId!, check.normalized);
      } else {
        await store.setAuthorizedGroup(req.authUserId!, '');
      }

      const snapshot = await sessionManager.getSnapshot(req.authUserId!);
      res.status(200).json(snapshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo guardar el grupo autorizado.';
      res.status(400).json({ error: message });
    }
  });

  // Manejador de errores para multer y middlewares de subida
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code: unknown }).code)
          : '';
      if (code === 'LIMIT_FILE_SIZE') {
        const maxMb = (
          Math.max(config.maxImageBytes, config.maxVideoBytes) /
          (1024 * 1024)
        ).toFixed(0);
        res
          .status(413)
          .json({ error: `El archivo supera el límite de ${maxMb} MB para stickers.` });
        return;
      }
      console.error('[StickerBot] Error de middleware:', err);
      res.status(500).json({ error: 'Error interno al procesar la solicitud.' });
    }
  );

  const distDir = path.join(ROOT_DIR, 'dist');
  const distIndex = path.join(distDir, 'index.html');
  const isProduction =
    process.env.NODE_ENV === 'production' ||
    (process.env.npm_lifecycle_event === 'start' && fs.existsSync(distIndex));

  if (isProduction) {
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path === '/health') {
        next();
        return;
      }
      res.sendFile(distIndex);
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(config.port, '0.0.0.0', () => {
    console.log(
      `[StickerBot] Servidor listo en http://0.0.0.0:${config.port} (modo=${isProduction ? 'produccion' : 'desarrollo'}, db=${store.mode})`
    );
    void sessionManager.restoreExistingSessions();
  });
}

bootstrap().catch((err) => {
  console.error('[StickerBot] Error fatal al iniciar el servidor:', err);
  process.exit(1);
});
