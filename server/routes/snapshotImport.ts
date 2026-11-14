import type { Express, Request } from 'express';
import { decryptVaultSnapshot } from '../db/cryptoAndModels';
import { bumpWorkspaceRevision, normalizeUiState, saveLocalDb, type LocalDatabaseSchema } from '../db/localDatabase';
import { APP_ENV } from '../config/env';
import { RUNTIME_DEFAULTS } from '../../src/data/runtimeDefaults';
import { sanitizeJsonObject, sanitizeLoopbackEndpoint } from '../../src/utils/rag';
import { octoVectorDb } from '../../src/utils/memory/octoVectorDatabase';
import { isRecord, recordsHaveStrings } from './workspaceValidation';

function validHex(value: unknown, length?: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length % 2 !== 0 ||
      (length !== undefined && value.length !== length)) return false;
  for (const char of value) if (!'0123456789abcdefABCDEF'.includes(char)) return false;
  return true;
}

function isDatabaseSnapshot(parsed: unknown): parsed is LocalDatabaseSchema {
  if (!isRecord(parsed) || parsed.schemaVersion !== 9 || !isRecord(parsed.engineSettings) ||
      !isRecord(parsed.engineSettings.branding) || !isRecord(parsed.ragConfig) || !isRecord(parsed.messagesBySession) ||
      !Array.isArray(parsed.sessions) || parsed.sessions.length === 0 ||
      !parsed.sessions.every((session: unknown) => isRecord(session) &&
        typeof session.id === 'string' && session.id.length > 0 && typeof session.title === 'string' &&
        typeof session.modelId === 'string' && Array.isArray(session.enabledPluginIds)) ||
      !Object.values(parsed.messagesBySession).every((messages) => Array.isArray(messages) &&
        messages.every((message: unknown) => isRecord(message) && typeof message.id === 'string' &&
          typeof message.content === 'string' && ['user', 'assistant', 'system'].includes(String(message.role)))) ||
      !recordsHaveStrings(parsed.ragDocuments, ['id', 'title', 'category', 'content']) ||
      !recordsHaveStrings(parsed.vaultFiles, ['id', 'fileName', 'content', 'collection']) ||
      !recordsHaveStrings(parsed.vaultMatrixColumns, ['id', 'header', 'extractionRule']) ||
      !recordsHaveStrings(parsed.memories, ['id', 'key', 'fact', 'category']) ||
      !recordsHaveStrings(parsed.promptTemplates, ['id', 'name', 'systemPrompt']) ||
      !recordsHaveStrings(parsed.customPlugins, ['id', 'name', 'category', 'description', 'parameterSummary'])) return false;
  const ragConfig = parsed.ragConfig;
  const engineSettings = parsed.engineSettings;
  return ['chunkSize', 'chunkOverlap', 'topK'].every((key) =>
    typeof ragConfig[key] === 'number' && Number.isFinite(ragConfig[key])) &&
    ['activeModelId', 'accentTheme', 'uiDensity'].every((key) => typeof engineSettings[key] === 'string') &&
    typeof engineSettings.defaultTemperature === 'number';
}

export function decryptSnapshot(envelope: unknown, passphrase: string): LocalDatabaseSchema {
  if (!isRecord(envelope)) throw new Error('Invalid encrypted snapshot envelope.');
  const saltHex = envelope.saltHex ?? envelope.salt;
  const ivHex = envelope.ivHex ?? envelope.iv;
  const authTagHex = envelope.authTagHex ?? envelope.authTag;
  const ciphertextHex = envelope.ciphertextHex ?? envelope.ciphertext;
  if (envelope.encryptedVault !== true || envelope.algorithm !== 'AES-256-GCM' ||
      envelope.kdf !== 'PBKDF2-SHA256-100000' ||
      !validHex(saltHex, 32) || !validHex(ivHex, 24) ||
      !validHex(authTagHex, 32) || !validHex(ciphertextHex)) {
    throw new Error('Invalid encrypted snapshot envelope.');
  }
  let plaintext: string;
  try {
    plaintext = decryptVaultSnapshot({
      encryptedVault: true, algorithm: 'AES-256-GCM', kdf: 'PBKDF2-SHA256-100000',
      saltHex, ivHex, authTagHex, ciphertextHex, exportedAt: ''
    }, passphrase);
  } catch {
    throw new Error('Incorrect passphrase or damaged encrypted snapshot.');
  }
  let parsed: unknown;
  try {
    parsed = sanitizeJsonObject(JSON.parse(plaintext));
  } catch {
    throw new Error('Decrypted snapshot is not valid JSON.');
  }
  if (!isDatabaseSnapshot(parsed)) {
    throw new Error('Decrypted snapshot has an invalid or unsupported database schema.');
  }
  return parsed;
}

interface SnapshotResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): unknown;
  json(body: unknown): unknown;
}

export function createSnapshotImportHandler(
  getLocalDb: () => LocalDatabaseSchema,
  setLocalDb: (next: LocalDatabaseSchema) => void
) {
  return (req: Pick<Request, 'body'>, res: SnapshotResponse): void => {
    res.setHeader('Cache-Control', 'no-store');
    const passphrase = typeof req.body?.passphrase === 'string' ? req.body.passphrase.trim() : '';
    if (passphrase.length < 4 || passphrase.length > 128) {
      res.status(400);
      res.json({ error: 'Passphrase must be between 4 and 128 characters.' });
      return;
    }
    let restored: LocalDatabaseSchema;
    try {
      restored = decryptSnapshot(req.body?.envelope, passphrase);
    } catch (error) {
      res.status(400);
      res.json({ error: error instanceof Error ? error.message : 'Invalid encrypted snapshot.' });
      return;
    }
    const current = getLocalDb();
    const restoredPort = restored.engineSettings.preferredLocalPort;
    restored.engineSettings = {
      ...restored.engineSettings,
      llamaCppBaseUrl: sanitizeLoopbackEndpoint(
        restored.engineSettings.llamaCppBaseUrl || '',
        APP_ENV.llamaCppBaseUrl
      ),
      preferredLocalPort:
        typeof restoredPort === 'number' &&
        Number.isInteger(restoredPort) &&
        restoredPort >= RUNTIME_DEFAULTS.minPort &&
        restoredPort <= RUNTIME_DEFAULTS.maxPort
          ? restoredPort
          : APP_ENV.port,
      databaseFilePath: current.engineSettings.databaseFilePath,
      ragStorageDirectory: current.engineSettings.ragStorageDirectory
    };
    restored.uiState = normalizeUiState(restored.uiState);
    saveLocalDb(restored);
    setLocalDb(restored);
    const { current: revision } = bumpWorkspaceRevision();
    octoVectorDb.syncFromStores({
      messagesBySession: restored.messagesBySession,
      memories: restored.memories,
      sessions: restored.sessions,
      vaultFiles: restored.vaultFiles,
      fileChunkSize: restored.ragConfig.chunkSize,
      fileChunkOverlap: restored.ragConfig.chunkOverlap
    });
    const { vaultMasterHash: _hash, ...snapshot } = restored;
    res.json({ revision, snapshot: { ...snapshot, branding: restored.engineSettings.branding } });
  };
}

export function registerSnapshotImportRoute(
  app: Express,
  getLocalDb: () => LocalDatabaseSchema,
  setLocalDb: (next: LocalDatabaseSchema) => void
): void {
  app.post('/api/local-db/decrypt-import', createSnapshotImportHandler(getLocalDb, setLocalDb));
}
