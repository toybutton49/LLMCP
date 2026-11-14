import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Database,
  Compass,
  Search,
  Play,
  RefreshCw,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  Layers,
  Code,
  X
} from 'lucide-react';
import { DatabaseComparisonCards } from '../database/DatabaseComparisonCards';
import { getRecordSummary } from '../database/databaseFormatters';
import {
  ProbeScopeId,
  ProbeRecord,
  executeProbeQuery,
  executeSemanticProbe,
  fetchLocalDbFallback
} from '../../utils/memory/databaseProbeQuery';

export interface QueryResponse {
  collection: string;
  databasePath?: string;
  totalCount: number;
  matchedCount: number;
  executionMs: number;
  records: Array<Record<string, unknown>>;
}

export interface DatabaseQuerySettingsProps {
  initialView?: 'probe' | 'local_db';
}

export const DatabaseQuerySettings: React.FC<DatabaseQuerySettingsProps> = ({
  initialView = 'local_db'
}) => {
  const [activeView, setActiveView] = useState<'probe' | 'local_db'>(initialView);
  const [collection, setCollection] = useState<string>('sessions');
  const [probeScope, setProbeScope] = useState<ProbeScopeId>('all');
  const [filterText, setFilterText] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [queryError, setQueryError] = useState('');
  const [limit, setLimit] = useState(25);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [viewMode, setViewMode] = useState<'cards' | 'json'>('cards');
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({});
  const requestSeqRef = useRef(0);

  // Model-backed probes run only when submitted so typing does not launch the embedding model per keystroke.
  const dbFilter = activeView === 'local_db' ? filterText : '';
  const semanticQuery = activeView === 'probe' && probeScope !== 'sessions' ? submittedQuery.trim() : '';

  const runQueryAction = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setIsLoading(true);
    setQueryError('');
    const start = performance.now();
    try {
      if (activeView === 'local_db') {
        const res = await fetch('/api/local-db/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            collection,
            filter: dbFilter.trim(),
            limit,
            sortOrder
          })
        });
        if (!res.ok) throw new Error(`Database query returned HTTP ${res.status}.`);
        const json = (await res.json()) as QueryResponse;
        if (seq !== requestSeqRef.current) return;
        setResult(json);
      } else if (semanticQuery) {
        const semantic = await executeSemanticProbe({
          query: semanticQuery,
          scope: probeScope as Exclude<ProbeScopeId, 'sessions'>,
          limit
        });
        if (seq !== requestSeqRef.current) return;
        setResult({
          collection: semantic.scope,
          totalCount: semantic.totalCount,
          matchedCount: semantic.matchedCount,
          executionMs: Math.max(1, Math.round(semantic.durationMs ?? performance.now() - start)),
          records: semantic.records.map((r) => ({
            ...r.raw,
            _probeTitle: r.title,
            _probeBadge: r.badge,
            _probeSnippet: r.snippet
          }))
        });
      } else {
        const fallback = await fetchLocalDbFallback();
        if (seq !== requestSeqRef.current) return;
        const probeRes = executeProbeQuery({
          scope: probeScope,
          filterText: submittedQuery,
          sortOrder,
          limit,
          memories: fallback.memories,
          messagesBySession: fallback.messagesBySession,
          sessions: fallback.sessions
        });

        const unifiedRecords = probeRes.records.map((r: ProbeRecord) => ({
          ...r.raw,
          _probeTitle: r.title,
          _probeBadge: r.badge,
          _probeSnippet: r.snippet
        }));

        setResult({
          collection: probeRes.scope,
          totalCount: probeRes.totalCount,
          matchedCount: probeRes.matchedCount,
          executionMs: Math.max(1, Math.round(performance.now() - start)),
          records: unifiedRecords
        });
      }
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      setResult(null);
      setQueryError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === requestSeqRef.current) setIsLoading(false);
    }
  }, [activeView, collection, probeScope, dbFilter, semanticQuery, submittedQuery, limit, sortOrder]);

  useEffect(() => {
    void runQueryAction();
  }, [runQueryAction]);

  useEffect(() => {
    if (activeView !== 'probe') return undefined;
    if (!filterText.trim()) {
      setSubmittedQuery('');
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setSubmittedQuery(filterText);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [activeView, filterText]);

  const submitQuery = () => {
    if (filterText === submittedQuery) void runQueryAction();
    else setSubmittedQuery(filterText);
  };

  const collections: Array<{ id: string; label: string }> = [
    { id: 'all', label: 'All Collections' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'messages', label: 'Messages' },
    { id: 'vaultFiles', label: 'File Repo Files' },
    { id: 'ragDocuments', label: 'File Repo Chunks' },
    { id: 'memories', label: 'Memories' },
    { id: 'customPlugins', label: 'Custom Tools' },
    { id: 'engineSettings', label: 'Engine Config' }
  ];

  const probeScopes: Array<{ id: ProbeScopeId; label: string }> = [
    { id: 'all', label: 'All Stores' },
    { id: 'memories', label: 'Directives' },
    { id: 'conversations', label: 'Chat History' },
    { id: 'sessions', label: 'Sessions' }
  ];

  const handleCopyRecord = (id: string, record: unknown) => {
    navigator.clipboard.writeText(JSON.stringify(record, null, 2));
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const toggleExpand = (id: string) => {
    setExpandedCards((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="p-5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50 space-y-5">
      {activeView === 'local_db' ? (
        <DatabaseComparisonCards activeView="local_db"
          onNavigate={(v) => setActiveView(v)}
          onSelectView={(v) => setActiveView(v)}
        />
      ) : (
        <DatabaseComparisonCards activeView="probe"
          onNavigate={(v) => setActiveView(v)}
          onSelectView={(v) => setActiveView(v)}
        />
      )}

      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-zinc-200 dark:border-zinc-800">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            {activeView === 'local_db' ? (
              <>
                <Database className="w-4 h-4 text-accent" />
                <span>Local Database Query Explorer</span>
              </>
            ) : (
              <>
                <Compass className="w-4 h-4 text-accent" />
                <span>Semantic Retrieval Probe</span>
              </>
            )}
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {activeView === 'local_db'
              ? `Structured query explorer for persisted local database tables, sessions, and rolling backup state.${
                  result?.databasePath ? ` Database file: ${result.databasePath}` : ''
                }`
              : 'Semantically ranks persistent memories, past chat turns, and File Repo text chunks as separate sources. This is a retrieval diagnostic, not a file manager or database editor.'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isLoading && (
            <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-accent" />
              <span>Searching...</span>
            </span>
          )}
          <div className="inline-flex rounded-lg p-0.5 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
            <button
              type="button"
              onClick={() => setViewMode('cards')}
              className={`px-2.5 py-1 rounded text-xs transition-colors cursor-pointer flex items-center gap-1 ${
                viewMode === 'cards'
                  ? 'bg-accent text-zinc-950 font-semibold shadow-xs'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
              }`}
            >
              <Layers className="w-3 h-3" />
              <span>Cards</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('json')}
              className={`px-2.5 py-1 rounded text-xs transition-colors cursor-pointer flex items-center gap-1 ${
                viewMode === 'json'
                  ? 'bg-accent text-zinc-950 font-semibold shadow-xs'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
              }`}
            >
              <Code className="w-3 h-3" />
              <span>Raw JSON</span>
            </button>
          </div>
        </div>
      </div>

      {/* Scope / Collection Selection Pills */}
      <div className="flex flex-wrap gap-1.5">
        {activeView === 'local_db'
          ? collections.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCollection(c.id)}
                className={`px-2.5 py-1 rounded-md text-xs font-mono cursor-pointer transition-colors ${
                  collection === c.id
                    ? 'bg-accent text-zinc-950 font-semibold shadow-xs'
                    : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
                }`}
              >
                {c.label}
              </button>
            ))
          : probeScopes.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setProbeScope(s.id)}
                className={`px-2.5 py-1 rounded-md text-xs font-mono cursor-pointer transition-colors ${
                  probeScope === s.id
                    ? 'bg-accent text-zinc-950 font-semibold shadow-xs'
                    : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
                }`}
              >
                {s.label}
              </button>
            ))}
      </div>

      {/* Query Filter Controls */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="sm:col-span-2 relative">
          <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={filterText}
            onChange={(e) => {
              setFilterText(e.target.value);
              if (!e.target.value) setSubmittedQuery('');
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              if (activeView === 'local_db') void runQueryAction();
              else submitQuery();
            }}
            placeholder={
              activeView === 'local_db'
                ? 'Filter records by keyword, ID, or field value...'
                : 'Probe by meaning, then press Enter...'
            }
            aria-label="Filter database records"
            className="w-full pl-8 pr-8 py-1.5 text-xs font-mono rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
          />
          {filterText && (
            <button
              type="button"
              onClick={() => { setFilterText(''); setSubmittedQuery(''); }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div>
          <select
            aria-label="Sort order"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as 'asc' | 'desc')}
            className="w-full px-3 py-1.5 text-xs font-mono rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
          >
            <option value="desc">Sort: Newest / Desc</option>
            <option value="asc">Sort: Oldest / Asc</option>
          </select>
        </div>
        <div>
          <select
            aria-label="Record limit"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="w-full px-3 py-1.5 text-xs font-mono rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
          >
            <option value={10}>Limit: 10 rows</option>
            <option value={25}>Limit: 25 rows</option>
            <option value={50}>Limit: 50 rows</option>
          </select>
        </div>
      </div>

      {queryError && (
        <div role="alert" className="p-3 rounded-lg border border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100 text-xs">
          {queryError}
        </div>
      )}

      {/* Query Results */}
      {result && (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-[11px] font-mono text-zinc-500 dark:text-zinc-400 px-1">
            <span>
              {activeView === 'local_db' ? 'Collection' : 'Scope'}:{' '}
              <strong className="text-accent">{result.collection}</strong> · Matched{' '}
              {result.matchedCount} of {result.totalCount} record(s)
            </span>
            <span>Query execution: {result.executionMs}ms</span>
          </div>

          {viewMode === 'cards' ? (
            <div className="grid grid-cols-1 gap-2.5 max-h-[500px] overflow-y-auto pr-1">
              {result.records.length === 0 ? (
                <div className="p-8 text-center text-xs text-zinc-500 font-mono border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl">
                  {activeView === 'local_db'
                    ? 'Zero records matched your filter criteria.'
                    : 'Zero records matched your probe criteria.'}
                </div>
              ) : (
                result.records.map((rec, idx) => {
                  const cardId = String(rec.id || `row_${idx}`);
                  const isExpanded = Boolean(expandedCards[cardId]);
                  const isCopied = copiedId === cardId;
                  const currentScope = activeView === 'local_db' ? collection : probeScope;
                  const summary = getRecordSummary(rec, currentScope);

                  return (
                    <div
                      key={cardId}
                      className="p-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/80 hover:border-accent/40 transition-colors space-y-2"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                              {summary.title}
                            </span>
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-accent/10 text-accent shrink-0">
                              {summary.badge}
                            </span>
                          </div>
                          <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-1 line-clamp-2">
                            {summary.snippet}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleCopyRecord(cardId, rec)}
                            title="Copy record JSON"
                            className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                          >
                            {isCopied ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleExpand(cardId)}
                            title={isExpanded ? 'Collapse JSON' : 'Expand full JSON payload'}
                            className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                          >
                            {isExpanded ? (
                              <ChevronUp className="w-3.5 h-3.5" />
                            ) : (
                              <ChevronDown className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      </div>

                      {isExpanded && (
                        <pre className="p-3 rounded-lg bg-zinc-900 dark:bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-300 overflow-x-auto max-h-60 leading-relaxed">
                          {JSON.stringify(rec, null, 2)}
                        </pre>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          ) : (
            <pre className="p-4 rounded-xl bg-zinc-950 text-zinc-200 border border-zinc-800 text-[11px] font-mono overflow-x-auto max-h-96 leading-relaxed">
              {JSON.stringify(result.records, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};
