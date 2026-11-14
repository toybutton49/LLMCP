// Web, Agent, Sandbox, and Hot-Swappable Tool Registry Routes
import type { Express } from 'express';
import {
  VaultFileEntry,
  buildVectorIndex,
  getRegisteredToolPlugins,
  invokeToolCallByName,
  sanitizeJsonObject
} from '../../src/utils/rag';
import {
  extractUrlsFromText,
  validateSafeWebUrl
} from '../../src/utils/webTools';
import {
  AgentTaskExecutionResult,
  executeAgenticTaskPipeline
} from '../../src/utils/agentTools';
import type { LocalDatabaseSchema } from '../../server-db';
import { performWebContext, performWebFetch, performWebSearch } from './webSearchAndFetch';
import { recordsHaveStrings } from '../routes/workspaceValidation';

function sanitizeRequestBody<T extends object>(input: unknown): T | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return sanitizeJsonObject(input as T);
}

export function registerWebAndAgentToolRoutes(
  app: Express,
  getLocalDb: () => LocalDatabaseSchema,
  saveDb?: (db: LocalDatabaseSchema) => void
): void {
  // 1. GET /api/tools/registry - Inspect Hot-Swappable Tool Registry
  app.get('/api/tools/registry', (_req, res) => {
    const db = getLocalDb();
    const builtIn = getRegisteredToolPlugins().map((p) => p.definition);
    res.json({
      ok: true,
      builtInPlugins: builtIn,
      customPlugins: db.customPlugins || []
    });
  });

  // 2. POST /api/tools/web-search
  app.post('/api/tools/web-search', async (req, res) => {
    try {
      const body = sanitizeRequestBody<{ query?: string; maxResults?: number }>(req.body);
      if (!body) {
        res.status(400).json({ error: 'Request body must be a JSON object.' });
        return;
      }
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (!query) {
        res.status(400).json({ error: 'Search query is required.' });
        return;
      }
      const results = await performWebSearch(query, body.maxResults || 5);
      res.json({ ok: true, query, results });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Web search failed.'
      });
    }
  });

  // 3. POST /api/tools/web-fetch
  app.post('/api/tools/web-fetch', async (req, res) => {
    try {
      const body = sanitizeRequestBody<{ url?: string; maxChars?: number }>(req.body);
      if (!body) {
        res.status(400).json({ error: 'Request body must be a JSON object.' });
        return;
      }
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      if (!url) {
        res.status(400).json({ error: 'Target URL is required.' });
        return;
      }
      const maxChars = body.maxChars === undefined ? 10000 : body.maxChars;
      if (typeof maxChars !== 'number' || !Number.isFinite(maxChars) || maxChars < 1) {
        res.status(400).json({ error: 'maxChars must be a positive finite number.' });
        return;
      }
      const check = validateSafeWebUrl(url);
      if (!check.valid) {
        res.status(400).json({
          error: check.reason || 'URL blocked by SSRF security guard.'
        });
        return;
      }

      try {
        const result = await performWebFetch(
          check.normalizedUrl,
          Math.max(1, Math.min(50000, Math.floor(maxChars)))
        );
        res.json({ ok: true, result });
      } catch (fetchErr) {
        res.status(502).json({
          ok: false,
          error: fetchErr instanceof Error ? fetchErr.message : 'Unable to fetch the remote page.'
        });
      }
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'web_fetch failed.'
      });
    }
  });

  // 4. POST /api/tools/web-context
  app.post('/api/tools/web-context', async (req, res) => {
    try {
      const body = sanitizeRequestBody<{ query?: string; urls?: string[]; topK?: number }>(req.body);
      if (!body) {
        res.status(400).json({ error: 'Request body must be a JSON object.' });
        return;
      }
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (!query) {
        res.status(400).json({ error: 'Context query is required.' });
        return;
      }
      if (
        body.urls !== undefined &&
        (!Array.isArray(body.urls) || body.urls.some((url) => typeof url !== 'string'))
      ) {
        res.status(400).json({ error: 'urls must be an array of strings.' });
        return;
      }
      const extractedUrls = extractUrlsFromText(query);
      const combinedUrls = Array.from(new Set([...(body.urls || []), ...extractedUrls]));
      const contextResult = await performWebContext({
        query,
        urls: combinedUrls,
        topK: body.topK || 4
      });
      res.json({ ok: true, context: contextResult });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'web_context failed.'
      });
    }
  });

  // 5. POST /api/agent/execute - Runs Agentic Task Pipeline
  app.post('/api/agent/execute', async (req, res) => {
    try {
      const body = sanitizeRequestBody<{
        objective?: string;
        fileIds?: string[];
        enabledToolIds?: string[];
        vaultFiles?: VaultFileEntry[];
      }>(req.body);
      if (!body) {
        res.status(400).json({ error: 'Request body must be a JSON object.' });
        return;
      }
      const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
      if (!objective) {
        res.status(400).json({ error: 'Agent objective is required.' });
        return;
      }
      if (
        body.fileIds !== undefined &&
        (!Array.isArray(body.fileIds) || body.fileIds.some((id) => typeof id !== 'string'))
      ) {
        res.status(400).json({ error: 'fileIds must be an array of strings.' });
        return;
      }
      if (
        body.enabledToolIds !== undefined &&
        (!Array.isArray(body.enabledToolIds) ||
          body.enabledToolIds.some((id) => typeof id !== 'string'))
      ) {
        res.status(400).json({ error: 'enabledToolIds must be an array of strings.' });
        return;
      }
      if (body.vaultFiles !== undefined &&
          !recordsHaveStrings(body.vaultFiles, ['id', 'fileName', 'content', 'collection'])) {
        res.status(400).json({ error: 'vaultFiles must be an array of valid file records.' });
        return;
      }

      const db = getLocalDb();
      const allFiles = body.vaultFiles ?? db.vaultFiles;

      const targetFiles =
        body.fileIds !== undefined
          ? allFiles.filter((f) => body.fileIds!.includes(f.id))
          : allFiles;

      const enabledToolIds = Array.isArray(body.enabledToolIds)
        ? body.enabledToolIds
        : [
            'knowledge_file_inspector',
            'agent_symbol_navigator',
            'code_complexity_analyzer',
            'agent_file_ops'
          ];

      const result: AgentTaskExecutionResult = executeAgenticTaskPipeline({
        objective,
        targetFiles,
        enabledToolIds
      });

      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Agentic task execution failed.'
      });
    }
  });

  // 6. POST /api/tools/call & POST /api/tools/execute - Invokes a built-in or custom tool
  const handleToolCall = async (req: any, res: any) => {
    try {
      const body = sanitizeRequestBody<{
        toolName?: string;
        arguments?: Record<string, unknown>;
      }>(req.body);
      if (!body) {
        res.status(400).json({ ok: false, error: 'Request body must be a JSON object.' });
        return;
      }
      const toolName = typeof body.toolName === 'string' ? body.toolName.trim() : '';
      if (!toolName) {
        res.status(400).json({ ok: false, error: 'toolName is required.' });
        return;
      }

      if (
        body.arguments !== undefined &&
        (!body.arguments || typeof body.arguments !== 'object' || Array.isArray(body.arguments))
      ) {
        res.status(400).json({ ok: false, error: 'arguments must be a JSON object.' });
        return;
      }
      const args = body.arguments || {};
      const db = getLocalDb();

      const vectorIndex = buildVectorIndex(
        db.ragDocuments,
        db.ragConfig.chunkSize,
        db.ragConfig.chunkOverlap
      );
      const invocation = invokeToolCallByName(toolName, args, {
        vectorIndex,
        vaultFiles: db.vaultFiles,
        memories: db.memories,
        messagesBySession: db.messagesBySession,
        sessions: db.sessions,
        distanceMetric: db.ragConfig.similarityMetric || 'cosine',
        providerId: 'llamacpp',
        customPlugins: db.customPlugins
      });

      if (saveDb) {
        saveDb(db);
      }

      res.json({
        ok: true,
        transport: 'built-in-tools',
        toolName,
        invocation
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Tool invocation failed.'
      });
    }
  };

  app.post('/api/tools/call', handleToolCall);
  app.post('/api/tools/execute', handleToolCall);
}
