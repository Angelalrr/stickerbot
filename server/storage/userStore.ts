import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import type { Collection, Db } from 'mongodb';
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { config } from '../config.ts';
import { hashPin, verifyPin } from '../auth/sessionAuth.ts';
import { validateUserId } from '../bot/validation.ts';

export interface UserRecord {
  userId: string;
  pinSalt: string;
  pinHash: string;
  authorizedGroupJid: string;
  createdAt: string;
  updatedAt: string;
}

interface AuthKeyDoc {
  _id: string;
  userId: string;
  keyName: string;
  payload: string;
  updatedAt: string;
}

function confinePath(baseDir: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, ...segments);
  if (
    resolvedTarget !== resolvedBase &&
    !resolvedTarget.startsWith(resolvedBase + path.sep)
  ) {
    throw new Error('Ruta de archivo fuera del directorio permitido.');
  }
  return resolvedTarget;
}

export class HybridUserStore {
  mode: 'mongodb' | 'local';
  client: MongoClient | null;
  db: Db | null;
  usersCol: Collection<UserRecord> | null;
  authCol: Collection<AuthKeyDoc> | null;
  lastError: string | null;

  constructor() {
    this.mode = 'local';
    this.client = null;
    this.db = null;
    this.usersCol = null;
    this.authCol = null;
    this.lastError = null;
  }

  async init(): Promise<void> {
    if (!config.mongodbUri) {
      this.mode = 'local';
      await fs.mkdir(config.dataDir, { recursive: true });
      return;
    }

    try {
      const client = new MongoClient(config.mongodbUri, {
        serverSelectionTimeoutMS: 5000,
      });
      await client.connect();
      const db = client.db();
      this.client = client;
      this.db = db;
      this.usersCol = db.collection<UserRecord>('stickerbot_users');
      this.authCol = db.collection<AuthKeyDoc>('stickerbot_baileys_auth');
      await this.usersCol.createIndex({ userId: 1 }, { unique: true });
      await this.authCol.createIndex({ userId: 1, keyName: 1 });
      this.mode = 'mongodb';
      this.lastError = null;
    } catch (err) {
      this.mode = 'local';
      this.lastError = err instanceof Error ? err.message : 'No se pudo conectar a MongoDB';
      console.warn(
        `[StickerBot] MongoDB no disponible (${this.lastError}). Usando almacenamiento local en data/.`
      );
      await fs.mkdir(config.dataDir, { recursive: true });
    }
  }

  private async readLocalUsers(): Promise<Record<string, UserRecord>> {
    const filePath = confinePath(config.dataDir, 'users.json');
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, UserRecord>;
      }
      return {};
    } catch {
      return {};
    }
  }

  private async writeLocalUsers(users: Record<string, UserRecord>): Promise<void> {
    await fs.mkdir(config.dataDir, { recursive: true });
    const filePath = confinePath(config.dataDir, 'users.json');
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(users, null, 2), 'utf8');
    await fs.rename(tmpPath, filePath);
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    const check = validateUserId(userId);
    if (!check.valid) return null;
    const cleanId = check.normalized;

    if (this.mode === 'mongodb' && this.usersCol) {
      return this.usersCol.findOne({ userId: cleanId });
    }

    const users = await this.readLocalUsers();
    return users[cleanId] || null;
  }

  async listUsers(): Promise<UserRecord[]> {
    if (this.mode === 'mongodb' && this.usersCol) {
      return this.usersCol.find({}).toArray();
    }
    const users = await this.readLocalUsers();
    return Object.values(users);
  }

  async registerUser(userId: string, pin: string): Promise<UserRecord> {
    const idCheck = validateUserId(userId);
    if (!idCheck.valid) {
      throw new Error(idCheck.error || 'Usuario inválido.');
    }
    const cleanId = idCheck.normalized;

    const existing = await this.getUser(cleanId);
    if (existing) {
      throw new Error('Ese nombre de usuario ya existe. Inicia sesión con tu PIN.');
    }

    const { salt, hash } = await hashPin(pin);
    const now = new Date().toISOString();
    const record: UserRecord = {
      userId: cleanId,
      pinSalt: salt,
      pinHash: hash,
      authorizedGroupJid: '',
      createdAt: now,
      updatedAt: now,
    };

    if (this.mode === 'mongodb' && this.usersCol) {
      await this.usersCol.insertOne(record);
      return record;
    }

    const users = await this.readLocalUsers();
    users[cleanId] = record;
    await this.writeLocalUsers(users);
    return record;
  }

  async authenticateUser(userId: string, pin: string): Promise<UserRecord | null> {
    const user = await this.getUser(userId);
    if (!user) return null;
    const valid = await verifyPin(pin, user.pinSalt, user.pinHash);
    return valid ? user : null;
  }

  async setAuthorizedGroup(userId: string, groupJid: string): Promise<UserRecord> {
    const idCheck = validateUserId(userId);
    if (!idCheck.valid) {
      throw new Error('Usuario inválido.');
    }
    const cleanId = idCheck.normalized;
    const now = new Date().toISOString();

    if (this.mode === 'mongodb' && this.usersCol) {
      await this.usersCol.updateOne(
        { userId: cleanId },
        { $set: { authorizedGroupJid: groupJid, updatedAt: now } }
      );
      const updated = await this.usersCol.findOne({ userId: cleanId });
      if (!updated) throw new Error('Usuario no encontrado.');
      return updated;
    }

    const users = await this.readLocalUsers();
    const existing = users[cleanId];
    if (!existing) throw new Error('Usuario no encontrado.');
    existing.authorizedGroupJid = groupJid;
    existing.updatedAt = now;
    await this.writeLocalUsers(users);
    return existing;
  }

  private localUserAuthDir(userId: string): string {
    const check = validateUserId(userId);
    if (!check.valid) throw new Error('Usuario inválido para ruta auth.');
    return confinePath(config.dataDir, 'auth', check.normalized);
  }

  private async readAuthValue(userId: string, keyName: string): Promise<unknown | null> {
    if (this.mode === 'mongodb' && this.authCol) {
      const doc = await this.authCol.findOne({ _id: `${userId}:${keyName}` });
      if (!doc) return null;
      return JSON.parse(doc.payload, BufferJSON.reviver);
    }

    const dir = this.localUserAuthDir(userId);
    const safeName = `${keyName.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
    const filePath = confinePath(dir, safeName);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw, BufferJSON.reviver);
    } catch {
      return null;
    }
  }

  private async writeAuthValue(userId: string, keyName: string, value: unknown): Promise<void> {
    const payload = JSON.stringify(value, BufferJSON.replacer);

    if (this.mode === 'mongodb' && this.authCol) {
      await this.authCol.updateOne(
        { _id: `${userId}:${keyName}` },
        {
          $set: {
            userId,
            keyName,
            payload,
            updatedAt: new Date().toISOString(),
          },
        },
        { upsert: true }
      );
      return;
    }

    const dir = this.localUserAuthDir(userId);
    await fs.mkdir(dir, { recursive: true });
    const safeName = `${keyName.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
    const filePath = confinePath(dir, safeName);
    await fs.writeFile(filePath, payload, 'utf8');
  }

  private async removeAuthValue(userId: string, keyName: string): Promise<void> {
    if (this.mode === 'mongodb' && this.authCol) {
      await this.authCol.deleteOne({ _id: `${userId}:${keyName}` });
      return;
    }

    const dir = this.localUserAuthDir(userId);
    const safeName = `${keyName.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
    const filePath = confinePath(dir, safeName);
    await fs.rm(filePath, { force: true }).catch(() => {});
  }

  async hasStoredCreds(userId: string): Promise<boolean> {
    const creds = await this.readAuthValue(userId, 'creds');
    return Boolean(creds && typeof creds === 'object');
  }

  async clearBaileysAuth(userId: string): Promise<void> {
    const check = validateUserId(userId);
    if (!check.valid) return;
    const cleanId = check.normalized;

    if (this.mode === 'mongodb' && this.authCol) {
      await this.authCol.deleteMany({ userId: cleanId });
      return;
    }

    const dir = this.localUserAuthDir(cleanId);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  async getBaileysAuthState(userId: string): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  }> {
    const check = validateUserId(userId);
    if (!check.valid) throw new Error('Usuario inválido.');
    const cleanId = check.normalized;

    const loadedCreds = await this.readAuthValue(cleanId, 'creds');
    const creds: AuthenticationCreds =
      loadedCreds && typeof loadedCreds === 'object'
        ? (loadedCreds as AuthenticationCreds)
        : initAuthCreds();

    return {
      state: {
        creds,
        keys: {
          get: async <T extends keyof SignalDataTypeMap>(
            type: T,
            ids: string[]
          ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
            const data: { [id: string]: SignalDataTypeMap[T] } = {};
            await Promise.all(
              ids.map(async (id) => {
                let value = await this.readAuthValue(cleanId, `${String(type)}-${id}`);
                if (type === 'app-state-sync-key' && value) {
                  value = proto.Message.AppStateSyncKeyData.create(
                    value as Record<string, unknown>
                  );
                }
                if (value !== null && value !== undefined) {
                  data[id] = value as SignalDataTypeMap[T];
                }
              })
            );
            return data;
          },
          set: async (data: SignalDataSet): Promise<void> => {
            const tasks: Array<Promise<void>> = [];
            for (const category of Object.keys(data) as Array<keyof SignalDataSet>) {
              const bucket = data[category];
              if (!bucket) continue;
              for (const id of Object.keys(bucket)) {
                const value = bucket[id];
                const keyName = `${String(category)}-${id}`;
                if (value) {
                  tasks.push(this.writeAuthValue(cleanId, keyName, value));
                } else {
                  tasks.push(this.removeAuthValue(cleanId, keyName));
                }
              }
            }
            await Promise.all(tasks);
          },
        },
      },
      saveCreds: async () => {
        await this.writeAuthValue(cleanId, 'creds', creds);
      },
    };
  }
}
