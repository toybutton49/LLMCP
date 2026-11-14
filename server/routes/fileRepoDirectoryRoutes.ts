import type { Express } from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ENV } from '../config/env';
import { serverLogger } from '../config/logger';
import { saveLocalDb } from '../db/localDatabase';
import type { LocalDatabaseSchema } from '../db/localDatabase';
import { octoVectorDb } from '../../src/utils/memory/octoVectorDatabase';
import { runSerializedAttachmentOcr } from './attachmentOcr';
import {
  materializeLegacyFileRepoEntries,
  readFileRepoDirectory
} from './fileRepoDirectory';

export function registerFileRepoDirectoryRoutes(
  app: Express,
  getLocalDb: () => LocalDatabaseSchema
): void {
  app.post('/api/file-repo/open', (_req, res) => {
    if (process.platform !== 'win32') {
      res.status(501).json({ error: 'Opening File Repo in Windows File Explorer is only available on Windows.' });
      return;
    }
    const localDb = getLocalDb();
    const targetDir = path.resolve(
      process.cwd(),
      localDb.engineSettings.ragStorageDirectory || APP_ENV.fileRepoDir
    );
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      const explorer = spawn('explorer.exe', [targetDir], {
        detached: true,
        stdio: 'ignore'
      });
      explorer.once('error', (error) => {
        serverLogger.error('storage', 'filerepo.explorer.open.error', error);
        if (!res.headersSent) {
          res.status(500).json({
            error: `Could not open File Repo in Explorer: ${error.message}`
          });
        }
      });
      explorer.once('spawn', () => {
        explorer.unref();
        res.json({ ok: true, directory: targetDir });
      });
    } catch (error) {
      serverLogger.error('storage', 'filerepo.explorer.open.error', error);
      res.status(500).json({
        error: `Could not open File Repo in Explorer: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  });

  app.post('/api/file-repo/refresh', async (_req, res) => {
    const localDb = getLocalDb();
    const targetDir = path.resolve(
      process.cwd(),
      localDb.engineSettings.ragStorageDirectory || APP_ENV.fileRepoDir
    );
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      const migratedCount = localDb.fileRepoMigrationCompleted
        ? 0
        : materializeLegacyFileRepoEntries(targetDir, localDb.vaultFiles);
      const result = await readFileRepoDirectory(
        targetDir,
        localDb.vaultFiles,
        APP_ENV.ocrMaxUploadBytes,
        (filePath) => runSerializedAttachmentOcr(filePath, localDb.ragConfig.ocrModel || '')
      );
      localDb.vaultFiles = result.files;
      localDb.fileRepoMigrationCompleted = true;
      saveLocalDb(localDb);
      const index = octoVectorDb.syncFromStores({
        vaultFiles: localDb.vaultFiles,
        fileChunkSize: localDb.ragConfig.chunkSize,
        fileChunkOverlap: localDb.ragConfig.chunkOverlap
      });
      res.json({
        ok: true,
        directory: targetDir,
        files: localDb.vaultFiles,
        fileCount: localDb.vaultFiles.length,
        migratedCount,
        ocrCount: result.ocrCount,
        indexedCount: index.indexedCount
      });
    } catch (error) {
      serverLogger.error('storage', 'filerepo.refresh.error', error);
      res.status(500).json({
        error: `Could not refresh File Repo from disk: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  });
}
