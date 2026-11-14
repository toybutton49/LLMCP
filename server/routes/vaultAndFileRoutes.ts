import type { Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ENV } from '../config/env';
import { serverLogger } from '../config/logger';
import { saveLocalDb } from '../db/localDatabase';
import type { LocalDatabaseSchema } from '../db/localDatabase';
import { RAG_DEFAULTS } from '../../src/data/runtimeDefaults';
import {
  buildVectorIndex,
  MIN_EMBEDDING_BATCH_SIZE,
  SimilarityMetricId,
  VaultScopeMode,
  createVaultFileEntry,
  isBinaryOrImageFile
} from '../../src/utils/rag';
import type { RetrievalHit, VaultExcerptHit } from '../../src/utils/rag';
import { octoVectorDb } from '../../src/utils/memory/octoVectorDatabase';
import { registerAttachmentOcrRoute } from './attachmentOcr';
import { registerFileRepoDirectoryRoutes } from './fileRepoDirectoryRoutes';
import { embeddingRetrieval, requireEmbeddingModel } from '../llamacpp/embeddingRetrieval';
import { searchVaultFilesWithEmbedding } from '../llamacpp/vaultEmbeddingRetrieval';
import { toAppErrorPayload } from '../../src/utils/appErrors';

export function registerVaultAndFileRoutes(app: Express, getLocalDb: () => LocalDatabaseSchema): void {
  registerAttachmentOcrRoute(
    app,
    () => getLocalDb().engineSettings.ragStorageDirectory || APP_ENV.fileRepoDir,
    undefined,
    () => getLocalDb().ragConfig.ocrModel || ''
  );
  registerFileRepoDirectoryRoutes(app, getLocalDb);

  // 1. Sub-10ms RAG Vector Query Route
  app.post('/api/rag/query', async (req, res) => {
    const localDb = getLocalDb();
    const {
      query = '',
      documents = localDb.ragDocuments,
      chunkSize = localDb.ragConfig.chunkSize ?? RAG_DEFAULTS.chunkSize,
      chunkOverlap = localDb.ragConfig.chunkOverlap ?? RAG_DEFAULTS.chunkOverlap,
      topK = localDb.ragConfig.topK ?? RAG_DEFAULTS.topK,
      minScore = localDb.ragConfig.minScore ?? RAG_DEFAULTS.minScore,
      similarityMetric = localDb.ragConfig.similarityMetric ?? RAG_DEFAULTS.similarityMetric,
      hybridDenseWeight = localDb.ragConfig.hybridDenseWeight ?? RAG_DEFAULTS.hybridDenseWeight,
      embeddingModel = localDb.ragConfig.embeddingModel,
      embeddingDimensions = localDb.ragConfig.embeddingDimensions,
      embeddingBatchSize = localDb.ragConfig.embeddingBatchSize,
      normalizeEmbeddings = localDb.ragConfig.normalizeEmbeddings,
      vaultEnabled = false,
      vaultFiles = localDb.vaultFiles,
      vaultScopeMode = 'all'
    } = req.body || {};

    if (!Array.isArray(documents) || !documents.every((document: unknown) =>
      document !== null && typeof document === 'object' &&
      ['id', 'title', 'category', 'content'].every((key) =>
        typeof (document as Record<string, unknown>)[key] === 'string'
      ))) {
      res.status(400).json({ error: 'documents must be an array of documents with string id, title, category, and content.' });
      return;
    }
    const start = performance.now();
    const index = buildVectorIndex(documents, chunkSize, chunkOverlap);
    const files = Array.isArray(vaultFiles) ? vaultFiles : localDb.vaultFiles;
    const scopeMode: VaultScopeMode = vaultScopeMode === 'pinned' ? 'pinned' : 'all';
    const useVault = vaultEnabled === true;
    let vaultHits: VaultExcerptHit[] = [];
    let hits: RetrievalHit[] = [];
    if (index.length || (useVault && files.length)) {
      try {
        const model = requireEmbeddingModel(String(embeddingModel || ''), 'Document and File Repo retrieval');
        const dimensions = Math.max(
          RAG_DEFAULTS.minEmbeddingDimensions,
          Math.min(RAG_DEFAULTS.maxEmbeddingDimensions, Number(embeddingDimensions) || RAG_DEFAULTS.embeddingDimensions)
        );
        const batchSize = Math.max(
          MIN_EMBEDDING_BATCH_SIZE,
          Math.min(RAG_DEFAULTS.maxEmbeddingBatchSize, Number(embeddingBatchSize) || RAG_DEFAULTS.embeddingBatchSize)
        );
        const effectiveTopK = Number(topK) || RAG_DEFAULTS.topK;
        const effectiveMinScore = typeof minScore === 'number' ? minScore : RAG_DEFAULTS.minScore;
        const effectiveDenseWeight = typeof hybridDenseWeight === 'number' ? hybridDenseWeight : RAG_DEFAULTS.hybridDenseWeight;
        if (index.length) {
          hits = await embeddingRetrieval.search({
            query: String(query), documents, model: model.fileName,
            dimensions, batchSize, normalize: normalizeEmbeddings !== false, chunkSize, chunkOverlap,
            topK: effectiveTopK, minScore: effectiveMinScore,
            metric: similarityMetric as SimilarityMetricId,
            hybridDenseWeight: effectiveDenseWeight
          }, model);
        }
        if (useVault) {
          vaultHits = await searchVaultFilesWithEmbedding({
            query: String(query),
            files,
            dimensions,
            batchSize,
            normalize: normalizeEmbeddings !== false,
            chunkSize,
            chunkOverlap,
            topK: effectiveTopK,
            metric: similarityMetric as SimilarityMetricId,
            hybridDenseWeight: effectiveDenseWeight,
            scopeMode,
            minScore: effectiveMinScore
          }, model);
        }
      } catch (error) {
        serverLogger.error('context', 'Nomic embedding retrieval failed', error);
        res.status(503).json(toAppErrorPayload(error, {
          code: 'EMBEDDING_RETRIEVAL_FAILED',
          feature: 'Document and File Repo retrieval',
          messagePrefix: 'Nomic embedding retrieval failed: ',
          action: 'Check the selected Nomic model and built-in server, then retry the search.'
        }));
        return;
      }
    }
    const elapsedMs = Number((performance.now() - start).toFixed(2));

    res.json({
      query,
      totalChunksIndexed: index.length,
      hits,
      vaultHits,
      source: index.length || (useVault && files.length) ? 'gguf' : 'none',
      elapsedMs
    });
  });

  // 2. Sub-10ms Vault File Retrieval Route
  app.post('/api/vault/query', async (req, res) => {
    const localDb = getLocalDb();
    const {
      query = '',
      vaultFiles = localDb.vaultFiles,
      scopeMode = 'all',
      topK = localDb.ragConfig.topK ?? RAG_DEFAULTS.topK,
      minScore = localDb.ragConfig.minScore ?? RAG_DEFAULTS.minScore,
      embeddingModel = localDb.ragConfig.embeddingModel,
      embeddingDimensions = localDb.ragConfig.embeddingDimensions,
      embeddingBatchSize = localDb.ragConfig.embeddingBatchSize,
      normalizeEmbeddings = localDb.ragConfig.normalizeEmbeddings,
      chunkSize = localDb.ragConfig.chunkSize ?? RAG_DEFAULTS.chunkSize,
      chunkOverlap = localDb.ragConfig.chunkOverlap ?? RAG_DEFAULTS.chunkOverlap,
      similarityMetric = localDb.ragConfig.similarityMetric ?? RAG_DEFAULTS.similarityMetric,
      hybridDenseWeight = localDb.ragConfig.hybridDenseWeight ?? RAG_DEFAULTS.hybridDenseWeight
    } = req.body || {};

    const start = performance.now();
    const files = Array.isArray(vaultFiles) ? vaultFiles : localDb.vaultFiles;
    const normalizedScope: VaultScopeMode = scopeMode === 'pinned' ? 'pinned' : 'all';
    let hits: VaultExcerptHit[] = [];
    if (files.length) {
      try {
        const model = requireEmbeddingModel(String(embeddingModel || ''), 'File Repo retrieval');
        hits = await searchVaultFilesWithEmbedding({
          query: String(query),
          files,
          dimensions: Math.max(
            RAG_DEFAULTS.minEmbeddingDimensions,
            Math.min(RAG_DEFAULTS.maxEmbeddingDimensions, Number(embeddingDimensions) || RAG_DEFAULTS.embeddingDimensions)
          ),
          batchSize: Math.max(
            MIN_EMBEDDING_BATCH_SIZE,
            Math.min(RAG_DEFAULTS.maxEmbeddingBatchSize, Number(embeddingBatchSize) || RAG_DEFAULTS.embeddingBatchSize)
          ),
          normalize: normalizeEmbeddings !== false,
          chunkSize,
          chunkOverlap,
          topK: Number(topK) || RAG_DEFAULTS.topK,
          metric: similarityMetric as SimilarityMetricId,
          hybridDenseWeight: typeof hybridDenseWeight === 'number' ? hybridDenseWeight : RAG_DEFAULTS.hybridDenseWeight,
          scopeMode: normalizedScope,
          minScore: typeof minScore === 'number' ? minScore : RAG_DEFAULTS.minScore
        }, model);
      } catch (error) {
        serverLogger.error('context', 'Nomic File Repo retrieval failed', error);
        res.status(503).json(toAppErrorPayload(error, {
          code: 'EMBEDDING_RETRIEVAL_FAILED',
          feature: 'File Repo retrieval',
          messagePrefix: 'Nomic File Repo retrieval failed: ',
          action: 'Check the selected Nomic model and built-in server, then retry the search.'
        }));
        return;
      }
    }
    const elapsedMs = Number((performance.now() - start).toFixed(2));

    res.json({
      query,
      totalVaultFiles: files.length,
      hits,
      source: files.length ? 'gguf' : 'none',
      elapsedMs
    });
  });

  // 3. Auto-Sync File Repo Directory Route
  app.get('/api/file-repo/sync', (_req, res) => {
    const localDb = getLocalDb();
    const targetDir = path.resolve(
      process.cwd(),
      localDb.engineSettings.ragStorageDirectory || APP_ENV.fileRepoDir
    );
    const ALLOWED_EXTS = new Set([
      '.md',
      '.txt',
      '.json',
      '.ts',
      '.tsx',
      '.js',
      '.py',
      '.yaml',
      '.yml',
      '.csv',
      '.html',
      '.css',
      '.sql',
      '.sh'
    ]);

    const discovered: Array<{
      fileName: string;
      relativePath: string;
      sizeBytes: number;
      content: string;
      updatedAt: string;
      isBinary?: boolean;
      mimeType?: string;
    }> = [];

    try {
      fs.mkdirSync(targetDir, { recursive: true });
      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.gitkeep' || entry.name.startsWith('.')) continue;
        if (!entry.isFile()) continue;

        const fullPath = path.join(targetDir, entry.name);
        const stat = fs.statSync(fullPath);

        if (isBinaryOrImageFile(entry.name)) {
          discovered.push({
            fileName: entry.name,
            relativePath: entry.name,
            sizeBytes: stat.size,
            content: `[Binary Media: ${entry.name} (${stat.size} bytes)]`,
            updatedAt: stat.mtime.toISOString(),
            isBinary: true,
            mimeType: 'application/octet-stream'
          });
          continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_EXTS.has(ext)) continue;
        if (stat.size > 512 * 1024) continue;
        const content = fs.readFileSync(fullPath, 'utf-8');
        discovered.push({
          fileName: entry.name,
          relativePath: entry.name,
          sizeBytes: stat.size,
          content,
          updatedAt: stat.mtime.toISOString()
        });
      }
    } catch (err) {
      serverLogger.error('storage', 'filerepo.sync.error', err);
      res.status(500).json({ error: `Could not sync File Repo: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    res.json({
      ok: true,
      directory: targetDir,
      fileCount: discovered.length,
      files: discovered
    });
  });

  // 4. Write Uploaded File into Local File Repo Directory & Index in OctoVectorDB
  app.post('/api/filerepo/write', (req, res) => {
    const localDb = getLocalDb();
    const { fileName, content, collection = 'Uploaded', exclusive = false } = req.body || {};
    if (!fileName || typeof fileName !== 'string') {
      res.status(400).json({ error: 'fileName is required.' });
      return;
    }
    const safeName = path.basename(fileName.trim());
    if (!safeName || safeName.startsWith('.')) {
      res.status(400).json({ error: 'Invalid fileName.' });
      return;
    }
    const targetDir = path.resolve(
      process.cwd(),
      localDb.engineSettings.ragStorageDirectory || APP_ENV.fileRepoDir
    );
    const targetPath = path.join(targetDir, safeName);
    const textContent = String(content ?? '');
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(targetPath, textContent, { encoding: 'utf-8', flag: exclusive === true ? 'wx' : 'w' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Could not save file: ${message}` });
      return;
    }

    // Update localDb.vaultFiles and OctoVectorDatabase
    const entry = createVaultFileEntry({
      fileName: safeName,
      collection: String(collection || 'Uploaded'),
      content: textContent,
      pinnedInChat: false
    });
    const existingIdx = localDb.vaultFiles.findIndex((f) => f.fileName === safeName);
    if (existingIdx >= 0) {
      localDb.vaultFiles[existingIdx] = {
        ...localDb.vaultFiles[existingIdx],
        content: textContent,
        sizeBytes: textContent.length,
        updatedAt: new Date().toISOString()
      };
    } else {
      localDb.vaultFiles.unshift(entry);
    }
    saveLocalDb(localDb);

    octoVectorDb.syncFromStores({
      vaultFiles: localDb.vaultFiles,
      fileChunkSize: localDb.ragConfig.chunkSize,
      fileChunkOverlap: localDb.ragConfig.chunkOverlap
    });

    res.json({
      ok: true,
      fileName: safeName,
      path: targetPath
    });
  });

  // 5. Local Folder Scanner & OctoVectorDB Chunk Indexer for File Repo
  const handleLocalFolderScan = (req: any, res: any) => {
    const defaultFolder = getLocalDb().engineSettings.ragStorageDirectory || APP_ENV.fileRepoDir;
    const { folderPath = defaultFolder, maxFiles = 100 } = req.body || {};
    if (typeof folderPath !== 'string' || !folderPath.trim() ||
        typeof maxFiles !== 'number' || !Number.isInteger(maxFiles) || maxFiles < 1) {
      res.status(400).json({ error: 'folderPath must be a non-empty string and maxFiles must be a positive integer.' });
      return;
    }
    const workspaceRoot = path.resolve(process.cwd());
    const resolvedDefaultRepo = path.resolve(workspaceRoot, defaultFolder);
    const resolvedTarget = path.resolve(workspaceRoot, String(folderPath).trim());
    const normalizedTargetLower = resolvedTarget.replaceAll('\\', '/').toLowerCase();

    const blockedSegments = ['/.ssh', '/.gnupg', '/.aws', '/windows/system32', '/etc', '/proc', '/sys'];
    if (blockedSegments.some((seg) => normalizedTargetLower === seg || normalizedTargetLower.includes(`${seg}/`) || normalizedTargetLower.endsWith(seg))) {
      res.status(403).json({
        error: 'Security Policy: Protected system or credential directories cannot be scanned.'
      });
      return;
    }

    try {
      if (resolvedTarget === resolvedDefaultRepo) {
        fs.mkdirSync(resolvedTarget, { recursive: true });
      }
      if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isDirectory()) {
        res.status(404).json({ error: `Directory not found: ${folderPath}` });
        return;
      }
    } catch (error) {
      serverLogger.error('storage', 'filerepo.scan.error', error);
      res.status(500).json({ error: `Could not scan folder: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    const ALLOWED_EXTS = new Set([
      '.md',
      '.txt',
      '.json',
      '.ts',
      '.tsx',
      '.js',
      '.py',
      '.yaml',
      '.yml',
      '.csv',
      '.html',
      '.css',
      '.sql',
      '.sh'
    ]);
    const IGNORED_DIRS = new Set([
      'node_modules',
      '.git',
      'dist',
      'build',
      '.next',
      'coverage',
      '.test-data'
    ]);

    const discoveredFiles: Array<{
      fileName: string;
      relativePath: string;
      sizeBytes: number;
      content: string;
    }> = [];

    function walkDir(currentDir: string, depth: number) {
      if (depth > 6 || discoveredFiles.length >= maxFiles) return;
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        if (discoveredFiles.length >= maxFiles) break;
        if (entry.name === '.gitkeep' || entry.name.startsWith('.')) continue;
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) {
            walkDir(fullPath, depth + 1);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!ALLOWED_EXTS.has(ext)) continue;
          const stat = fs.statSync(fullPath);
          if (stat.size > 512 * 1024) continue;
          const content = fs.readFileSync(fullPath, 'utf-8');
          const relFromScanned = path.relative(resolvedTarget, fullPath).replaceAll('\\', '/');
          discoveredFiles.push({
            fileName: relFromScanned.includes('/') ? relFromScanned.replaceAll('/', '__') : entry.name,
            relativePath: relFromScanned,
            sizeBytes: stat.size,
            content
          });
        }
      }
    }

    try {
      walkDir(resolvedTarget, 0);
    } catch (error) {
      serverLogger.error('storage', 'filerepo.scan.error', error);
      res.status(500).json({ error: `Could not scan folder: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    const relToWorkspace = path.relative(workspaceRoot, resolvedTarget);
    const isInsideWorkspace =
      relToWorkspace !== '..' &&
      !relToWorkspace.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relToWorkspace);

    res.json({
      folderPath: isInsideWorkspace ? relToWorkspace || '.' : resolvedTarget,
      scannedCount: discoveredFiles.length,
      files: discoveredFiles
    });
  };

  app.post('/api/filerepo/scan', handleLocalFolderScan);
  app.post('/api/vault/scan-folder', handleLocalFolderScan);
}
