import React, { useState, useEffect, useCallback } from 'react';
import { Terminal, Trash2, Download, Filter, RefreshCw, Search, X } from 'lucide-react';
import { orchestrator, StructuredLogEntry, LogLevel, LogSubsystem } from '../../orchestrators';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';

interface RuntimeLogsPanelProps {
  logs?: StructuredLogEntry[];
}

export const RuntimeLogsPanel: React.FC<RuntimeLogsPanelProps> = ({ logs: externalLogs }) => {
  const [clientLogs, setClientLogs] = useState<StructuredLogEntry[]>(() =>
    externalLogs || orchestrator.loggingOrchestrator.getEntries()
  );
  const [serverLogs, setServerLogs] = useState<StructuredLogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const [subsystemFilter, setSubsystemFilter] = useState<LogSubsystem | 'all'>('all');
  const [searchFilter, setSearchFilter] = useState('');
  const [isRefreshingServer, setIsRefreshingServer] = useState(false);
  const [isConfirmClearOpen, setIsConfirmClearOpen] = useState(false);
  const [serverError, setServerError] = useState('');

  const fetchServerLogs = useCallback(async () => {
    setIsRefreshingServer(true);
    try {
      const res = await fetch('/api/logs?limit=120');
      if (!res.ok) throw new Error(`Server log request failed (${res.status}).`);
      const data = await res.json();
      if (!data || !Array.isArray(data.logs)) throw new Error('Server log request returned invalid data.');
      const mapped: StructuredLogEntry[] = data.logs.map(
        (srv: {
          id: string;
          isoTimestamp?: string;
          timestamp?: string;
          level?: LogLevel;
          subsystem?: LogSubsystem;
          message?: string;
          durationMs?: number;
          metadata?: Record<string, unknown>;
        }) => ({
          id: srv.id,
          timestamp: srv.isoTimestamp || srv.timestamp || new Date().toISOString(),
          level: (srv.level || 'INFO') as LogLevel,
          subsystem: (srv.subsystem || 'system') as LogSubsystem,
          event: `server.${srv.subsystem || 'system'}`,
          message: srv.message || '',
          durationMs: srv.durationMs,
          metadata: srv.metadata
        })
      );
      setServerLogs(mapped);
      setServerError('');
    } catch (error) {
      setServerError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRefreshingServer(false);
    }
  }, []);

  useEffect(() => {
    if (externalLogs) {
      setClientLogs(externalLogs);
    }
  }, [externalLogs]);

  useEffect(() => {
    const unsubscribe = orchestrator.loggingOrchestrator.subscribe(() => {
      setClientLogs([...orchestrator.loggingOrchestrator.getEntries()]);
    });
    const source = new EventSource('/api/logs/stream');
    const handleLogs = (event: Event) => {
      if (!(event instanceof MessageEvent) || typeof event.data !== 'string') {
        setServerError('Server log stream sent an invalid event.');
        return;
      }
      try {
        const payload = JSON.parse(event.data) as { logs?: Array<{
          id: string;
          isoTimestamp?: string;
          timestamp?: string;
          level?: LogLevel;
          subsystem?: LogSubsystem;
          message?: string;
          durationMs?: number;
          metadata?: Record<string, unknown>;
        }> };
        if (!Array.isArray(payload.logs)) throw new Error('Server log stream returned invalid data.');
        setServerLogs(payload.logs.map((srv) => ({
          id: srv.id,
          timestamp: srv.isoTimestamp || srv.timestamp || new Date().toISOString(),
          level: srv.level || 'INFO',
          subsystem: srv.subsystem || 'system',
          event: `server.${srv.subsystem || 'system'}`,
          message: srv.message || '',
          durationMs: srv.durationMs,
          metadata: srv.metadata
        })));
        setServerError('');
      } catch (error) {
        setServerError(error instanceof Error ? error.message : String(error));
      }
    };
    source.addEventListener('logs', handleLogs);
    source.onopen = () => setServerError('');
    source.onerror = () => setServerError('Server log stream disconnected; reconnecting.');
    return () => {
      unsubscribe();
      source.removeEventListener('logs', handleLogs);
      source.close();
    };
  }, []);

  // Merge client and server logs chronologically (newest first)
  const combinedLogs = React.useMemo(() => {
    const map = new Map<string, StructuredLogEntry>();
    for (const entry of clientLogs) map.set(entry.id, entry);
    for (const entry of serverLogs) map.set(entry.id, entry);
    return Array.from(map.values()).sort((a, b) =>
      b.timestamp.localeCompare(a.timestamp)
    );
  }, [clientLogs, serverLogs]);

  const normalizedLogQuery = searchFilter.trim().toLowerCase();
  const filteredLogs = combinedLogs.filter((log) => {
    if (
      levelFilter !== 'all' &&
      log.level.toUpperCase() !== levelFilter.toUpperCase()
    ) {
      return false;
    }
    if (subsystemFilter !== 'all' && log.subsystem !== subsystemFilter) {
      return false;
    }
    if (normalizedLogQuery) {
      const hay = `${log.message} ${log.subsystem} ${log.level} ${log.metadata ? JSON.stringify(log.metadata) : ''}`.toLowerCase();
      if (!hay.includes(normalizedLogQuery)) return false;
    }
    return true;
  });

  const handleClear = async () => {
    orchestrator.loggingOrchestrator.clear();
    setClientLogs([]);
    try {
      const response = await fetch('/api/logs', { method: 'DELETE' });
      if (!response.ok) throw new Error(`Server log clear failed (${response.status}).`);
      setServerLogs([]);
      setServerError('');
    } catch (error) {
      setServerError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleExport = () => {
    const json = JSON.stringify(filteredLogs, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `llmcp-runtime-logs-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getLevelBadge = (level: LogLevel) => {
    const normalized = String(level).toUpperCase();
    switch (normalized) {
      case 'ERROR':
        return 'bg-red-500/15 text-red-400 border-red-500/30';
      case 'WARN':
        return 'bg-orange-500/15 text-orange-400 border-orange-500/30';
      case 'DEBUG':
        return 'bg-purple-500/15 text-purple-400 border-purple-500/30';
      default:
        return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    }
  };

  const formatTimeDisplay = (ts: string) => {
    if (ts.includes('T')) {
      const timePart = ts.split('T')[1];
      return timePart ? timePart.slice(0, 8) : ts;
    }
    return ts;
  };

  return (
    <div className="p-5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-accent" />
          <div>
            <h2 className="text-sm font-semibold">
              Application Runtime Logs
            </h2>
            <p className="text-xs text-zinc-500">
              Unified client + server ring buffer ({filteredLogs.length} visible of{' '}
              {combinedLogs.length} events)
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              aria-label="Filter runtime logs by keyword"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Search logs..."
              className="pl-7 pr-6 py-1 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-stone-50 dark:bg-zinc-950 text-xs font-mono text-zinc-700 dark:text-zinc-200 focus-accent w-40 sm:w-48"
            />
            {searchFilter && (
              <button
                type="button"
                aria-label="Clear log search"
                onClick={() => setSearchFilter('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-200 cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-stone-50 dark:bg-zinc-950 text-xs">
            <Filter className="w-3.5 h-3.5 text-zinc-400" />
            <select
              aria-label="Filter logs by level"
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value as LogLevel | 'all')}
              className="bg-transparent text-zinc-700 dark:text-zinc-300 focus:outline-none text-xs font-mono"
            >
              <option value="all">All Levels</option>
              <option value="INFO">INFO</option>
              <option value="WARN">WARN</option>
              <option value="ERROR">ERROR</option>
              <option value="DEBUG">DEBUG</option>
            </select>
          </div>

          <select
            aria-label="Filter logs by subsystem"
            value={subsystemFilter}
            onChange={(e) => setSubsystemFilter(e.target.value as LogSubsystem | 'all')}
            className="px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-stone-50 dark:bg-zinc-950 text-xs font-mono text-zinc-700 dark:text-zinc-300 focus:outline-none"
          >
            <option value="all">All Subsystems</option>
            <option value="inference">inference</option>
            <option value="context">context</option>
            <option value="tool">tool</option>
            <option value="knowledge">knowledge</option>
            <option value="storage">storage</option>
            <option value="system">system</option>
          </select>

          <button
            type="button"
            onClick={fetchServerLogs}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-xs font-medium text-zinc-700 dark:text-zinc-300 cursor-pointer"
            title="Sync server logs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingServer ? 'animate-spin' : ''}`} />
            Sync
          </button>

          <button
            type="button"
            onClick={handleExport}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-xs font-medium text-zinc-700 dark:text-zinc-300 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Export JSON
          </button>

          <button
            type="button"
            onClick={() => setIsConfirmClearOpen(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-red-500/10 hover:text-red-400 text-xs font-medium text-zinc-500 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear
          </button>
        </div>
      </div>

      {serverError && <p role="status" className="text-xs text-red-500">{serverError}</p>}

      <div className="max-h-72 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] space-y-1.5">
        {filteredLogs.length === 0 ? (
          <div className="text-zinc-500 py-8 text-center">
            No runtime events match the active filter.
          </div>
        ) : (
          filteredLogs.map((log) => (
            <div
              key={log.id}
              className="flex items-start gap-2.5 py-1.5 px-2 rounded hover:bg-zinc-900/80 border-b border-zinc-900 last:border-none"
            >
              <span className="text-zinc-500 shrink-0 select-all">
                {formatTimeDisplay(log.timestamp)}
              </span>
              <span
                className={`px-1.5 py-0.2 rounded border text-[9px] uppercase font-bold shrink-0 ${getLevelBadge(
                  log.level
                )}`}
              >
                {log.level}
              </span>
              <span className="px-1.5 py-0.2 rounded bg-zinc-900 text-zinc-400 border border-zinc-800 text-[10px] shrink-0">
                {log.subsystem}
              </span>
              <span className="text-zinc-200 break-all flex-1">{log.message}</span>
              {typeof log.durationMs === 'number' && (
                <span className="text-zinc-500 shrink-0">{log.durationMs}ms</span>
              )}
            </div>
          ))
        )}
      </div>

      <ConfirmDeleteModal
        isOpen={isConfirmClearOpen}
        onClose={() => setIsConfirmClearOpen(false)}
        onConfirm={() => {
          setIsConfirmClearOpen(false);
          handleClear();
        }}
        title="Clear Runtime Logs?"
        description="Are you sure you want to clear all runtime event logs? This will wipe the client and server log history."
        confirmLabel="Clear Logs"
      />
    </div>
  );
};
