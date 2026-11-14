import express from 'express';
import http from 'http';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { APP_ENV, validateUiPort } from './server/config/env';
import {
  createNetworkAccessMiddleware,
  listReachableNetworkUrls
} from './server/config/networkAccess';
import { RUNTIME_DEFAULTS } from './src/data/runtimeDefaults';
import { serverLogger, registerServerLogRoutes } from './server/config/logger';
import { ensureLocalDb } from './server-db';
import { registerWebAndAgentToolRoutes } from './server-tools';
import { registerWorkspaceRoutes } from './server/routes/workspaceRoutes';
import { registerChatRoutes } from './server/routes/chatRoutes';
import { octoVectorDb } from './src/utils/memory/octoVectorDatabase';
import { ensureLlamaRouter } from './server/llamacpp/llamaRouter';
import { registerApiNotFound } from './server/config/apiNotFound';
import { ContextOffloadManager } from './server/llamacpp/contextOffloadManager';
import { startGpuTelemetryMonitor } from './server/llamacpp/gpuTelemetry';
import { subscribeContextPressure } from './server/llamacpp/runtimeTelemetry';
import { registerRuntimeRoutes } from './server/routes/runtimeRoutes';
import { registerTtsRoutes } from './server/routes/ttsRoutes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason);
});

process.on('exit', (code) => {
  console.log('[server] process.exit called with code:', code);
});

process.on('SIGINT', () => {
  console.log('[server] received SIGINT');
});

process.on('SIGTERM', () => {
  console.log('[server] received SIGTERM');
});

process.on('beforeExit', (code) => {
  console.log('[server] beforeExit with code:', code);
});

async function startServer() {
  const cliArgs = process.argv.slice(2);
  const cliOrEnvPort = validateUiPort(cliArgs, process.env.PORT);
  const hasExplicitPort = Boolean(
    (process.env.PORT && process.env.PORT.trim() !== '') ||
    cliArgs.some((arg) => arg === '--port' || arg === '-p' || arg.startsWith('--port='))
  );
  const initialDb = ensureLocalDb();
  const PORT = hasExplicitPort
    ? cliOrEnvPort
    : (initialDb.engineSettings.preferredLocalPort || cliOrEnvPort);
  const app = express();
  let ready = false;
  app.use((_req, res, next) => {
    if (!ready) {
      res.status(503).send('LLMCP is starting.');
      return;
    }
    next();
  });
  const server = http.createServer(app);
  const bindHost = APP_ENV.bindHost;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, bindHost, () => {
      server.off('error', reject);
      resolve();
    });
  });

  try {
    await initializeServer(app, server, initialDb, PORT, bindHost);
    ready = true;
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}

async function initializeServer(
  app: express.Express,
  server: http.Server,
  initialDb: ReturnType<typeof ensureLocalDb>,
  PORT: number,
  bindHost: string
) {
  // Security, Network Access (Loopback + LAN + Tailscale), & Origin Guard Headers
  app.use(createNetworkAccessMiddleware());

  const snapshotLimit = RUNTIME_DEFAULTS.maxSnapshotPayloadBytes;
  const ocrBodyLimit = Math.max(
    snapshotLimit,
    Math.ceil((APP_ENV.ocrMaxUploadBytes * 4) / 3) + 1024 * 1024
  );
  app.use('/api/local-db/decrypt-import', express.json({ limit: snapshotLimit }));
  // The workspace sync body carries full File Repo contents, so it needs the same headroom as imports.
  app.use('/api/local-db/sync', express.json({ limit: snapshotLimit }));
  // The OCR body is the base64 form of a file up to APP_ENV.ocrMaxUploadBytes.
  app.use('/api/filerepo/ocr', express.json({ limit: ocrBodyLimit }));
  app.use(express.json({ limit: RUNTIME_DEFAULTS.maxJsonPayloadBytes }));
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (typeof err === 'object' && err !== null && (err as { type?: unknown }).type === 'entity.too.large') {
      res.status(413).json({ error: 'The request is larger than this endpoint accepts.' });
      return;
    }
    if (err instanceof SyntaxError && typeof (err as unknown as Record<string, unknown>).status === 'number') {
      res.status(400).json({ error: 'Malformed JSON payload.' });
      return;
    }
    next(err);
  });

  // Serve the official uploaded logo files directly from /public/assets/logos/
  app.get('/llmcp-logo.jpg', (_req, res) => {
    res.sendFile(
      path.resolve(__dirname, 'public', 'assets', 'logos', 'llmcp-octopus.jpg')
    );
  });

  app.get('/llmcp-text-logo.jpg', (_req, res) => {
    res.sendFile(
      path.resolve(__dirname, 'public', 'assets', 'logos', 'llmcp-wordmark.jpg')
    );
  });

  let localDb = initialDb;
  const getLocalDb = () => localDb;
  const setLocalDb = (next: typeof localDb) => {
    localDb = next;
  };
  const contextOffloadManager = new ContextOffloadManager(getLocalDb);
  const unsubscribeContextPressure = subscribeContextPressure((snapshot) =>
    contextOffloadManager.onContextPressure(snapshot)
  );
  const stopGpuMonitor = startGpuTelemetryMonitor(APP_ENV.gpuSampleIntervalMs);
  server.once('close', () => {
    unsubscribeContextPressure();
    stopGpuMonitor();
  });

  serverLogger.info('system', 'LLMCP Local Nervous System initialized.', {
    port: PORT,
    modelsDir: APP_ENV.modelsDir,
    llamaCppEndpoint: localDb.engineSettings.llamaCppBaseUrl
  });

  // Dedicated Octo Vector Database Boot & Store Sync
  octoVectorDb.ensureLoaded();
  octoVectorDb.syncFromStores({
    messagesBySession: localDb.messagesBySession,
    memories: localDb.memories,
    sessions: localDb.sessions,
    vaultFiles: localDb.vaultFiles,
    fileChunkSize: localDb.ragConfig.chunkSize,
    fileChunkOverlap: localDb.ragConfig.chunkOverlap
  });

  // 0. Structured Runtime Telemetry & Error Reporting Routes (/api/logs)
  registerServerLogRoutes(app);
  registerRuntimeRoutes(app, getLocalDb, contextOffloadManager);

  // 1. Workspace, Settings, File Repo, RAG, GGUF Native Engine, and Encrypted Snapshot Routes
  registerWorkspaceRoutes(app, getLocalDb, setLocalDb, PORT);

  // 2. Web, Sandbox, and Hot-Swappable Tool Registry Routes
  registerWebAndAgentToolRoutes(app, getLocalDb);

  // 3. Local Inference Streaming Chat Route & Local Kokoro-82M TTS Routes
  registerChatRoutes(app, getLocalDb);
  registerTtsRoutes(app, getLocalDb);
  registerApiNotFound(app);

  const isHmrDisabled = process.env.DISABLE_HMR === 'true';

  if (process.env.NODE_ENV !== 'production' && !process.argv.includes('--production')) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ...(isHmrDisabled
          ? { hmr: false, ws: false, watch: null }
          : { ws: { server } })
      },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(
      express.static(distPath, {
        setHeaders: (res, filePath) => {
          if (path.basename(filePath) === 'index.html') res.setHeader('Cache-Control', 'no-cache');
        }
      })
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Global Express Error Boundary for API routes
  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      serverLogger.error('system', `Unhandled exception on ${req.method} ${req.path}`, err);
      if (res.headersSent) {
        return next(err);
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Internal server error'
      });
    }
  );

  const networkUrls = listReachableNetworkUrls(PORT, bindHost);
  const extraEndpoints = [
    ...networkUrls.lanUrls.map((u) => `LAN: ${u}`),
    ...networkUrls.tailscaleUrls.map((u) => `Tailscale: ${u}`)
  ];
  console.log(
    `${localDb.engineSettings.branding?.appName || 'LLMCP'} running on ${networkUrls.loopbackUrl}${
      extraEndpoints.length > 0 ? ` (${extraEndpoints.join(' · ')})` : ''
    } (Brain: Built-In llama.cpp Core @ ${localDb.engineSettings.llamaCppBaseUrl} · Models: ${APP_ENV.modelsDir})`
  );
  void ensureLlamaRouter(localDb.engineSettings.llamaCppBaseUrl).catch((error: unknown) => {
    serverLogger.error('system', 'llama.cpp startup failed; use the runtime banner to retry.', error);
  });
}

void startServer().catch((error: unknown) => {
  console.error(`[server] Startup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
