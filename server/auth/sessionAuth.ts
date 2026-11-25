import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.ts';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function hashPin(pin: string): Promise<{ salt: string; hash: string }> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(pin, salt, 64, (err, derived) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ salt, hash: derived.toString('hex') });
    });
  });
}

export function verifyPin(pin: string, salt: string, expectedHashHex: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pin, salt, 64, (err, derived) => {
      if (err) {
        reject(err);
        return;
      }
      const expected = Buffer.from(expectedHashHex, 'hex');
      if (expected.length !== derived.length) {
        resolve(false);
        return;
      }
      resolve(crypto.timingSafeEqual(expected, derived));
    });
  });
}

export function issueSessionToken(userId: string): string {
  const payload = {
    sub: userId,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySessionToken(token: string): { userId: string } | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encoded, providedSig] = parts;
  if (!encoded || !providedSig) return null;

  const expectedSig = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(encoded)
    .digest('base64url');

  const a = Buffer.from(providedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (
      typeof decoded.sub !== 'string' ||
      typeof decoded.exp !== 'number' ||
      decoded.exp < Date.now()
    ) {
      return null;
    }
    return { userId: decoded.sub };
  } catch {
    return null;
  }
}

export interface AuthenticatedRequest extends Request {
  authUserId?: string;
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Sesión requerida. Inicia sesión con tu usuario y PIN.' });
    return;
  }

  const token = header.slice(7).trim();
  const verified = verifySessionToken(token);
  if (!verified) {
    res.status(401).json({ error: 'Sesión inválida o expirada. Vuelve a iniciar sesión.' });
    return;
  }

  req.authUserId = verified.userId;
  next();
}
