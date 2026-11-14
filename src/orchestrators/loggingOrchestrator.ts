export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export type LogSubsystem =
  | 'inference'
  | 'tool'
  | 'context'
  | 'knowledge'
  | 'storage'
  | 'system';

export interface StructuredLogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  subsystem: LogSubsystem;
  event: string;
  message: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export type LogSubscriber = (entries: StructuredLogEntry[]) => void;

/**
 * Industry-standard structured logging orchestrator with ring-buffer storage,
 * subsystem filtering, latency instrumentation, and reactive subscribers.
 */
export class LoggingOrchestrator {
  public readonly domain = 'structured_telemetry_ring_buffer';
  public readonly suctionCups = ['GET /api/logs', 'POST /api/logs/client', 'DELETE /api/logs'];
  private entries: StructuredLogEntry[] = [];
  private readonly maxEntries: number;
  private subscribers: Set<LogSubscriber> = new Set();

  constructor(maxEntries: number = 400) {
    this.maxEntries = maxEntries;
    this.info('system', 'orchestrator.init', 'Modular orchestrator & structured logging subsystem initialized.');
  }

  public log(
    level: LogLevel,
    subsystem: LogSubsystem,
    event: string,
    message: string,
    options?: { durationMs?: number; metadata?: Record<string, unknown> }
  ): StructuredLogEntry {
    const entry: StructuredLogEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      level,
      subsystem,
      event,
      message,
      durationMs: options?.durationMs,
      metadata: options?.metadata
    };

    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.length = this.maxEntries;
    }

    if (
      typeof window !== 'undefined' &&
      typeof fetch === 'function' &&
      event !== 'orchestrator.init'
    ) {
      fetch('/api/logs/client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          level,
          subsystem,
          message: `[${event}] ${message}`,
          durationMs: options?.durationMs,
          metadata: options?.metadata
        })
      }).catch(() => {});
    }

    this.notify();
    return entry;
  }

  public debug(
    subsystem: LogSubsystem,
    event: string,
    message: string,
    options?: { durationMs?: number; metadata?: Record<string, unknown> }
  ): StructuredLogEntry {
    return this.log('DEBUG', subsystem, event, message, options);
  }

  public info(
    subsystem: LogSubsystem,
    event: string,
    message: string,
    options?: { durationMs?: number; metadata?: Record<string, unknown> }
  ): StructuredLogEntry {
    return this.log('INFO', subsystem, event, message, options);
  }

  public warn(
    subsystem: LogSubsystem,
    event: string,
    message: string,
    options?: { durationMs?: number; metadata?: Record<string, unknown> }
  ): StructuredLogEntry {
    return this.log('WARN', subsystem, event, message, options);
  }

  public error(
    subsystem: LogSubsystem,
    event: string,
    message: string,
    options?: { durationMs?: number; metadata?: Record<string, unknown> }
  ): StructuredLogEntry {
    return this.log('ERROR', subsystem, event, message, options);
  }

  public getEntries(filter?: {
    level?: LogLevel | 'ALL';
    subsystem?: LogSubsystem | 'ALL';
    search?: string;
    limit?: number;
  }): StructuredLogEntry[] {
    let list = [...this.entries];

    if (filter?.level && filter.level.toUpperCase() !== 'ALL') {
      list = list.filter((e) => e.level.toUpperCase() === filter.level!.toUpperCase());
    }
    if (filter?.subsystem && filter.subsystem.toLowerCase() !== 'all') {
      list = list.filter((e) => e.subsystem.toLowerCase() === filter.subsystem!.toLowerCase());
    }
    if (filter?.search && filter.search.trim()) {
      const q = filter.search.trim().toLowerCase();
      list = list.filter(
        (e) =>
          e.message.toLowerCase().includes(q) ||
          e.event.toLowerCase().includes(q) ||
          e.subsystem.toLowerCase().includes(q)
      );
    }
    if (filter?.limit && filter.limit > 0) {
      list = list.slice(0, filter.limit);
    }
    return list;
  }

  public clear(): void {
    this.entries = [];
    this.notify();
  }

  public subscribe(fn: LogSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  public exportJson(): string {
    return JSON.stringify(this.entries, null, 2);
  }

  private notify(): void {
    const snapshot = [...this.entries];
    for (const sub of this.subscribers) {
      try {
        sub(snapshot);
      } catch {
        // Ignore subscriber error
      }
    }
  }
}
