// Local Filesystem GGUF Model Scanner (Strictly ./models) & AES-256-GCM / PBKDF2 Cryptography
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  deduplicateModelIds,
  isAuxiliaryOrEmbeddingModel,
  isNomicEmbeddingModel,
  isOcrModelId
} from '../../src/utils/rag';
import { APP_ENV, ensureModelsDirectory, WORKSPACE_ROOT } from '../config/env';
import { classifyGgufRole } from './ggufMetadata';

export interface DiscoveredGgufFile {
  id: string;
  fileName: string;
  relativePath: string;
  sizeBytes: number;
  quantization: string;
}

/**
 * Scans ./models for local .gguf model weight files for the built-in
 * llama.cpp Brain, while separately indexing Octo Heart embedding models (nomic-embed-*).
 */
export function scanLocalFilesystemModels(): {
  ggufModels: string[];
  chatIds: string[];
  nonChatIds: string[];
  ggufFiles: DiscoveredGgufFile[];
  ocrFiles: DiscoveredGgufFile[];
  embeddingModels: string[];
  embeddingFiles: DiscoveredGgufFile[];
  octoHeartModel: string | null;
  modelsDirectory: string;
} {
  const rawDiskModels: string[] = [];
  const chatIds: string[] = [];
  const nonChatIds: string[] = [];
  const ggufFiles: DiscoveredGgufFile[] = [];
  const ocrFiles: DiscoveredGgufFile[] = [];
  const embeddingFiles: DiscoveredGgufFile[] = [];
  const seenFileNames = new Set<string>();
  const primaryDir = ensureModelsDirectory();

  const floatQuantTags = ['f16', 'bf16', 'fp16', 'f32'];
  // Parses quant tags such as Q4_K_M, Q8_0, IQ4_XS and F16 from a filename, without a fixed tag list.
  const isQuantStartToken = (part: string): boolean => {
    const lower = part.toLowerCase();
    if (floatQuantTags.includes(lower)) return true;
    const digitsFrom = lower.startsWith('iq') ? 2 : lower.startsWith('q') ? 1 : 0;
    if (digitsFrom === 0 || lower.length <= digitsFrom) return false;
    const first = lower.charCodeAt(digitsFrom);
    return first >= 48 && first <= 57;
  };
  const extractQuantTag = (name: string): string => {
    const parts = name.replaceAll('_', '-').replaceAll('.', '-').split('-');
    const start = parts.findIndex(isQuantStartToken);
    if (start < 0) return 'GGUF';
    const tagParts = [parts[start]];
    for (let i = start + 1; i < parts.length && parts[i].length <= 2; i++) tagParts.push(parts[i]);
    return tagParts.join('_').toUpperCase();
  };

  const scanDirRecursive = (dirPath: string, rootDir: string, depth: number) => {
    if (depth > 2 || !fs.existsSync(dirPath)) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      const fullPath = path.join(dirPath, ent.name);
      if (ent.isFile() && ent.name.toLowerCase().endsWith('.gguf')) {
        const lowerName = ent.name.toLowerCase();
        if (seenFileNames.has(lowerName)) continue;
        seenFileNames.add(lowerName);

        const baseFile = ent.name.slice(0, -5);
        let sizeBytes = 0;
        try {
          sizeBytes = fs.statSync(fullPath).size;
        } catch {
          // Ignore stat error
        }
        const relFromWorkspace = path.relative(WORKSPACE_ROOT, fullPath).split(path.sep).join('/');
        const entryRecord: DiscoveredGgufFile = {
          id: baseFile,
          fileName: ent.name,
          relativePath: relFromWorkspace.startsWith('.') ? relFromWorkspace : `./${relFromWorkspace}`,
          sizeBytes,
          quantization: extractQuantTag(baseFile)
        };

        // GGUF metadata decides projector/embedding/chat; filenames only mark OCR purpose and files with unreadable headers.
        const role = classifyGgufRole(fullPath);
        if (role === 'projector') {
          nonChatIds.push(baseFile);
        } else if (role === 'embedding') {
          nonChatIds.push(baseFile);
          embeddingFiles.push(entryRecord);
        } else if (isOcrModelId(baseFile) || lowerName.includes('olmocr')) {
          nonChatIds.push(baseFile);
          if (!lowerName.includes('olmocr') && !lowerName.includes('mmproj')) ocrFiles.push(entryRecord);
        } else if (role === 'chat' || !isAuxiliaryOrEmbeddingModel(baseFile)) {
          chatIds.push(baseFile);
          rawDiskModels.push(baseFile);
          ggufFiles.push(entryRecord);
        } else {
          nonChatIds.push(baseFile);
          if (!lowerName.includes('mmproj')) embeddingFiles.push(entryRecord);
        }
      } else if (ent.isDirectory() && !ent.name.startsWith('.')) {
        scanDirRecursive(fullPath, rootDir, depth + 1);
      }
    }
  };

  try {
    scanDirRecursive(primaryDir, primaryDir, 0);
  } catch {
    // Ignore read errors
  }

  embeddingFiles.sort((a, b) => a.fileName.localeCompare(b.fileName));

  const deduped = deduplicateModelIds(rawDiskModels, () => false);
  const embeddingModels = embeddingFiles.map((f) => f.fileName);
  const preferredHeart = embeddingFiles.find((file) => isNomicEmbeddingModel(file.fileName)) || null;

  return {
    ggufModels: deduped,
    chatIds,
    nonChatIds,
    ggufFiles,
    ocrFiles,
    embeddingModels,
    embeddingFiles,
    octoHeartModel: preferredHeart ? preferredHeart.fileName : null,
    modelsDirectory: APP_ENV.modelsDir
  };
}

export function hashPassphrase(passphrase: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.pbkdf2Sync(passphrase, salt, 100_000, 32, 'sha256').toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassphrase(passphrase: string, storedHash: string): boolean {
  try {
    if (!storedHash.includes(':')) {
      const legacy = crypto
        .createHash('sha256')
        .update(`llmcp_local_salt_${passphrase}`)
        .digest('hex');
      const a = Buffer.from(legacy, 'utf8');
      const b = Buffer.from(storedHash, 'utf8');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    const [salt, expectedHex] = storedHash.split(':');
    if (!salt || !expectedHex) return false;
    const derivedHex = crypto.pbkdf2Sync(passphrase, salt, 100_000, 32, 'sha256').toString('hex');
    const a = Buffer.from(derivedHex, 'hex');
    const b = Buffer.from(expectedHex, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export interface EncryptedVaultEnvelope {
  encryptedVault: true;
  algorithm: 'AES-256-GCM';
  kdf: 'PBKDF2-SHA256-100000';
  saltHex: string;
  ivHex: string;
  authTagHex: string;
  ciphertextHex: string;
  salt?: string;
  iv?: string;
  authTag?: string;
  ciphertext?: string;
  exportedAt: string;
}

export function encryptVaultSnapshot(
  plaintextJson: string,
  passphrase: string
): EncryptedVaultEnvelope {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(passphrase, salt, 100_000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintextJson, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const saltHex = salt.toString('hex');
  const ivHex = iv.toString('hex');
  const authTagHex = authTag.toString('hex');
  const ciphertextHex = encrypted.toString('hex');

  return {
    encryptedVault: true,
    algorithm: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256-100000',
    saltHex,
    ivHex,
    authTagHex,
    ciphertextHex,
    salt: saltHex,
    iv: ivHex,
    authTag: authTagHex,
    ciphertext: ciphertextHex,
    exportedAt: new Date().toISOString()
  };
}

export function decryptVaultSnapshot(
  envelope: EncryptedVaultEnvelope,
  passphrase: string
): string {
  const salt = Buffer.from(envelope.saltHex || envelope.salt || '', 'hex');
  const iv = Buffer.from(envelope.ivHex || envelope.iv || '', 'hex');
  const authTag = Buffer.from(envelope.authTagHex || envelope.authTag || '', 'hex');
  const ciphertext = Buffer.from(envelope.ciphertextHex || envelope.ciphertext || '', 'hex');

  const key = crypto.pbkdf2Sync(passphrase, salt, 100_000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
