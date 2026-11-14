import React, { useState } from 'react';
import {
  Globe,
  Play,
  ShieldCheck,
  Sparkles,
  ExternalLink,
  Layers
} from 'lucide-react';
import {
  WebSearchResultItem,
  WebFetchResult,
  WebContextResult
} from '../../utils/webTools';
import { orchestrator } from '../../orchestrators';

interface WebToolTesterTabProps {
  onSendContextToChat?: (promptText: string) => void;
}

export const WebToolTesterTab: React.FC<WebToolTesterTabProps> = ({
  onSendContextToChat
}) => {
  const [webMode, setWebMode] = useState<'web_search' | 'web_fetch' | 'web_context'>('web_search');
  const [searchQuery, setSearchQuery] = useState(
    'llama.cpp GGUF quantization local inference architecture'
  );
  const [fetchUrl, setFetchUrl] = useState('https://en.wikipedia.org/wiki/Localhost');
  const [isExecutingWeb, setIsExecutingWeb] = useState(false);
  const [webError, setWebError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<WebSearchResultItem[]>([]);
  const [fetchResult, setFetchResult] = useState<WebFetchResult | null>(null);
  const [contextResult, setContextResult] = useState<WebContextResult | null>(null);

  const handleRunWebTool = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsExecutingWeb(true);
    setWebError(null);
    if (webMode === 'web_search') setSearchResults([]);
    else if (webMode === 'web_fetch') setFetchResult(null);
    else setContextResult(null);
    const startedAt = performance.now();

    try {
      if (webMode === 'web_search') {
        const res = await fetch('/api/tools/web-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: searchQuery, maxResults: 5 })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'web_search request failed');
        setSearchResults(data.results || []);
      } else if (webMode === 'web_fetch') {
        const res = await fetch('/api/tools/web-fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: fetchUrl, maxChars: 8000 })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'web_fetch request failed');
        setFetchResult(data.result || null);
      } else {
        const res = await fetch('/api/tools/web-context', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: searchQuery, topK: 4 })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'web_context request failed');
        setContextResult(data.context || null);
      }
      orchestrator.recordToolExecutionTrace({
        toolId: 'web_search',
        toolName: `Web Tool (${webMode})`,
        inputSummary: webMode === 'web_fetch' ? fetchUrl : searchQuery,
        outputSummary: `Completed ${webMode} request`,
        durationMs: Math.max(0, performance.now() - startedAt),
        status: 'success'
      });
    } catch (err) {
      setWebError(err instanceof Error ? err.message : 'Web tool execution failed.');
    } finally {
      setIsExecutingWeb(false);
    }
  };

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-4 border-b border-zinc-200 dark:border-zinc-800">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <Globe className="w-4 h-4 text-sky-500" />
            <span>
              Interactive Web Tool Tester (`web_search`, `web_fetch`, `web_context`)
            </span>
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            Test live search, SSRF-guarded URL fetching, and grounded context synthesis directly, then send results to Chat.
          </p>
        </div>

        <div className="inline-flex rounded-lg p-0.5 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
          {(
            [
              { id: 'web_search', label: 'web_search' },
              { id: 'web_fetch', label: 'web_fetch' },
              { id: 'web_context', label: 'web_context' }
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              disabled={isExecutingWeb}
              onClick={() => setWebMode(m.id)}
              className={`px-3 py-1 rounded-md text-xs font-mono transition-colors cursor-pointer ${
                webMode === m.id
                  ? 'bg-sky-500 text-white font-semibold'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <form onSubmit={handleRunWebTool} className="flex flex-col sm:flex-row gap-2.5">
        {webMode === 'web_fetch' ? (
          <input
            type="text"
            value={fetchUrl}
            disabled={isExecutingWeb}
            onChange={(e) => {
              setFetchUrl(e.target.value);
              setFetchResult(null);
              setWebError(null);
            }}
            placeholder="https://en.wikipedia.org/wiki/Localhost"
            className="flex-1 px-3.5 py-2 text-xs font-mono rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-sky-500"
          />
        ) : (
          <input
            type="text"
            value={searchQuery}
            disabled={isExecutingWeb}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchResults([]);
              setContextResult(null);
              setWebError(null);
            }}
            placeholder="Enter technical search query or topic..."
            className="flex-1 px-3.5 py-2 text-xs rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-sky-500"
          />
        )}

        <button
          type="submit"
          disabled={isExecutingWeb}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-white transition-colors disabled:opacity-50 cursor-pointer"
        >
          <Play className="w-3.5 h-3.5" />
          <span>{isExecutingWeb ? 'Running...' : `Execute ${webMode}`}</span>
        </button>
      </form>

      <div className="flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
        <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
        <span>
          SSRF Guard Active: Private LAN IPs (`10.x`, `192.168.x`), cloud metadata (`169.254.169.254`), and loopback ports are strictly blocked in `web_fetch`.
        </span>
      </div>

      {webError && (
        <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-xs text-rose-600 dark:text-rose-400">
          {webError}
        </div>
      )}

      {webMode === 'web_search' && searchResults.length > 0 && (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono uppercase text-zinc-400">
              Search Results ({searchResults.length})
            </span>
            {onSendContextToChat && (
              <button
                type="button"
                onClick={() =>
                  onSendContextToChat(
                    `Synthesize these web_search results for "${searchQuery}":\n\n` +
                      searchResults
                        .map((r, i) => `${i + 1}. **${r.title}** (${r.url})\n   ${r.snippet}`)
                        .join('\n\n')
                  )
                }
                className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Send Search Results to Chat</span>
              </button>
            )}
          </div>

          {searchResults.map((item) => (
            <div
              key={item.id}
              className="p-3.5 rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 space-y-1"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                  {item.title}
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-sky-500/10 text-sky-500">
                  {item.source} · {item.score.toFixed(2)}
                </span>
              </div>
              <div className="text-[11px] font-mono text-zinc-400 truncate flex items-center gap-1">
                <ExternalLink className="w-3 h-3 shrink-0" />
                <span className="truncate">{item.url}</span>
              </div>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed pt-1">
                {item.snippet}
              </p>
            </div>
          ))}
        </div>
      )}

      {webMode === 'web_fetch' && fetchResult && (
        <div className="p-4 rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                {fetchResult.title}
              </h3>
              <p className="text-[11px] font-mono text-zinc-400">
                {fetchResult.url} · {fetchResult.wordCount} words · {fetchResult.charCount} chars
              </p>
            </div>
            {onSendContextToChat && (
              <button
                type="button"
                onClick={() =>
                  onSendContextToChat(
                    `Analyze this fetched page from ${fetchResult.url} ("${fetchResult.title}"):\n\n${fetchResult.content.slice(0, 2500)}`
                  )
                }
                className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Send Page to Chat</span>
              </button>
            )}
          </div>

          <pre className="text-xs font-mono text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap max-h-72 overflow-y-auto p-3 rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
            {fetchResult.content}
          </pre>
        </div>
      )}

      {webMode === 'web_context' && contextResult && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono uppercase text-zinc-400">
              Grounded Passages ({contextResult.passages.length} across{' '}
              {contextResult.totalSources} source(s))
            </span>
            {onSendContextToChat && (
              <button
                type="button"
                onClick={() =>
                  onSendContextToChat(
                    `Answer "${contextResult.query}" using this grounded web_context summary:\n\n${contextResult.synthesizedSummary}`
                  )
                }
                className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline cursor-pointer"
              >
                <Layers className="w-3.5 h-3.5" />
                <span>Send Grounded Context to Chat</span>
              </button>
            )}
          </div>

          {contextResult.passages.map((p) => (
            <div
              key={p.id}
              className="p-3.5 rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 space-y-1.5"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                  {p.title}
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-500">
                  Relevance {(p.relevanceScore * 100).toFixed(0)}%
                </span>
              </div>
              <div className="text-[11px] font-mono text-zinc-400 truncate">{p.url}</div>
              <p className="text-xs text-zinc-600 dark:text-zinc-300 whitespace-pre-line">
                {p.excerpt}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
