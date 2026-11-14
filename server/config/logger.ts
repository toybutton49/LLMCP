import type { Express } from 'express';

export type ServerLogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
export type ServerLogSubsystem =
  | 'inference'
  | 'tool'
  | 'context'
  | 'knowledge'
  | 'storage'
  | 'system';

export interface ServerLogEntry {
  id: string;
  timestamp: string;
  isoTimestamp: string;
  level: ServerLogLevel;
  subsystem: ServerLogSubsystem;
  message: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

const MAX_SERVER_LOGS = 300;

class ServerRuntimeLogger {
  private buffer: ServerLogEntry[] = [];
  private readonly subscribers = new Set<(entry: ServerLogEntry) => void>();

  public log(
    level: ServerLogLevel,
    subsystem: ServerLogSubsystem,
    message: string,
    options?: {
      durationMs?: number;
      metadata?: Record<string, unknown>;
    }
  ): ServerLogEntry {
    const now = new Date();
    const entry: ServerLogEntry = {
      id: `srv-log-${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: now.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }),
      isoTimestamp: now.toISOString(),
      level,
      subsystem,
      message,
      durationMs: options?.durationMs,
      metadata: options?.metadata
    };

    this.buffer = [entry, ...this.buffer].slice(0, MAX_SERVER_LOGS);

    if (level === 'ERROR') {
      console.error(`[LLMCP:${subsystem.toUpperCase()}] ${message}`, options?.metadata || '');
    }
    for (const subscriber of this.subscribers) {
      try {
        subscriber(entry);
      } catch (error) {
        console.error('[LLMCP:LOGGING] Server log subscriber failed:', error);
      }
    }
    return entry;
  }

  public info(
    subsystem: ServerLogSubsystem,
    message: string,
    metadata?: Record<string, unknown>,
    durationMs?: number
  ): ServerLogEntry {
    return this.log('INFO', subsystem, message, { metadata, durationMs });
  }

  public warn(
    subsystem: ServerLogSubsystem,
    message: string,
    metadata?: Record<string, unknown>,
    durationMs?: number
  ): ServerLogEntry {
    return this.log('WARN', subsystem, message, { metadata, durationMs });
  }

  public error(
    subsystem: ServerLogSubsystem,
    message: string,
    errorOrMeta?: unknown,
    durationMs?: number
  ): ServerLogEntry {
    let metadata: Record<string, unknown> | undefined;
    if (errorOrMeta instanceof Error) {
      metadata = {
        errorName: errorOrMeta.name,
        errorMessage: errorOrMeta.message,
        stack: errorOrMeta.stack?.split('\n').slice(0, 4).join(' | ')
      };
    } else if (errorOrMeta && typeof errorOrMeta === 'object') {
      metadata = errorOrMeta as Record<string, unknown>;
    }
    return this.log('ERROR', subsystem, message, { metadata, durationMs });
  }

  public debug(
    subsystem: ServerLogSubsystem,
    message: string,
    metadata?: Record<string, unknown>,
    durationMs?: number
  ): ServerLogEntry {
    return this.log('DEBUG', subsystem, message, { metadata, durationMs });
  }

  public getEntries(filter?: {
    level?: ServerLogLevel;
    subsystem?: ServerLogSubsystem;
    limit?: number;
  }): ServerLogEntry[] {
    let items = this.buffer;
    if (filter?.level) {
      items = items.filter((e) => e.level === filter.level);
    }
    if (filter?.subsystem) {
      items = items.filter((e) => e.subsystem === filter.subsystem);
    }
    const limit = filter?.limit && filter.limit > 0 ? filter.limit : 200;
    return items.slice(0, limit);
  }

  public clear(): void {
    this.buffer = [];
  }

  public subscribe(listener: (entry: ServerLogEntry) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }
}

export const serverLogger = new ServerRuntimeLogger();

export function registerServerLogRoutes(app: Express): void {
  app.get('/api/logs', (req, res) => {
    const levelRaw = typeof req.query.level === 'string' ? req.query.level.toUpperCase() : undefined;
    const subsystemRaw =
      typeof req.query.subsystem === 'string' ? req.query.subsystem.toLowerCase() : undefined;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 150;

    const validLevels: ServerLogLevel[] = ['INFO', 'WARN', 'ERROR', 'DEBUG'];
    const validSubsystems: ServerLogSubsystem[] = [
      'inference',
      'tool',
      'context',
      'knowledge',
      'storage',
      'system'
    ];

    const level = validLevels.includes(levelRaw as ServerLogLevel)
      ? (levelRaw as ServerLogLevel)
      : undefined;
    const subsystem = validSubsystems.includes(subsystemRaw as ServerLogSubsystem)
      ? (subsystemRaw as ServerLogSubsystem)
      : undefined;

    res.json({
      logs: serverLogger.getEntries({
        level,
        subsystem,
        limit: Number.isFinite(limitRaw) ? limitRaw : 150
      })
    });
  });

  app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (payload: unknown) => {
      if (!res.writableEnded) res.write(`event: logs\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const unsubscribe = serverLogger.subscribe(() => {
      send({ logs: serverLogger.getEntries({ limit: 120 }) });
    });
    send({ logs: serverLogger.getEntries({ limit: 120 }) });
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': heartbeat\n\n');
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post('/api/logs/client', (req, res) => {
    const body = (req.body || {}) as {
      level?: string;
      subsystem?: string;
      message?: string;
      durationMs?: number;
      metadata?: Record<string, unknown>;
    };
    const validLevels: ServerLogLevel[] = ['INFO', 'WARN', 'ERROR', 'DEBUG'];
    const validSubsystems: ServerLogSubsystem[] = [
      'inference',
      'tool',
      'context',
      'knowledge',
      'storage',
      'system'
    ];
    const rawLevel = typeof body.level === 'string' ? body.level.toUpperCase() : 'INFO';
    const rawSub = typeof body.subsystem === 'string' ? body.subsystem.toLowerCase() : 'system';
    const level: ServerLogLevel = validLevels.includes(rawLevel as ServerLogLevel)
      ? (rawLevel as ServerLogLevel)
      : 'INFO';
    const subsystem: ServerLogSubsystem = validSubsystems.includes(rawSub as ServerLogSubsystem)
      ? (rawSub as ServerLogSubsystem)
      : 'system';
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, 500) : '';
    if (!message) {
      res.status(400).json({ ok: false, error: 'Log message is required.' });
      return;
    }
    const entry = serverLogger.log(level, subsystem, message, {
      durationMs: typeof body.durationMs === 'number' ? body.durationMs : undefined,
      metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined
    });
    res.json({ ok: true, entry });
  });

  app.delete('/api/logs', (_req, res) => {
    serverLogger.clear();
    serverLogger.info('system', 'Server runtime logs cleared by operator.');
    res.json({ ok: true, logs: serverLogger.getEntries() });
  });
}
