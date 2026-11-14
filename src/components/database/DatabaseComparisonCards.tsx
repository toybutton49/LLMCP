import React from 'react';
import { Compass, Database, ArrowUpRight } from 'lucide-react';

export interface DatabaseComparisonCardsProps {
  activeView: 'probe' | 'local_db';
  onNavigate?: (view: 'probe' | 'local_db') => void;
  onSelectView?: (view: 'probe' | 'local_db') => void;
}

export const DatabaseComparisonCards: React.FC<DatabaseComparisonCardsProps> = ({
  activeView,
  onNavigate,
  onSelectView
}) => {
  const isProbeActive = activeView === 'probe';
  const isLocalDbActive = activeView === 'local_db';

  const handleSelect = (view: 'probe' | 'local_db') => {
    if (onSelectView) {
      onSelectView(view);
    }
    if (onNavigate) {
      onNavigate(view);
    }
  };

  const isInteractive = Boolean(onSelectView || onNavigate);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 pb-2">
      {/* Probe DB Card */}
      <div
        role={isInteractive && !isProbeActive ? 'button' : undefined}
        tabIndex={isInteractive && !isProbeActive ? 0 : undefined}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !isProbeActive && isInteractive) {
            e.preventDefault();
            handleSelect('probe');
          }
        }}
        onClick={() => {
          if (!isProbeActive && isInteractive) handleSelect('probe');
        }}
        className={`p-3.5 rounded-xl space-y-1 transition-all ${
          isProbeActive
            ? 'border border-accent/40 bg-accent-subtle ring-1 ring-accent/20 shadow-xs'
            : 'border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/70 hover:bg-zinc-100/60 dark:hover:bg-zinc-900/60'
        } ${!isProbeActive && isInteractive ? 'cursor-pointer hover:border-accent/40' : ''}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div
            className={`flex items-center gap-2 text-xs font-semibold ${
              isProbeActive ? 'text-accent' : 'text-zinc-900 dark:text-zinc-100'
            }`}
          >
            <Compass className="w-3.5 h-3.5 text-accent" />
            <span>Probe DB (Semantic Retrieval)</span>
          </div>
          {isProbeActive ? (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-accent/20 text-accent font-semibold shrink-0">
              Active View
            </span>
          ) : (
            <span
              className={`text-[10px] font-mono shrink-0 flex items-center gap-1 ${
                isInteractive ? 'text-accent font-medium' : 'text-zinc-400'
              }`}
            >
              <span>Switch to Semantic Retrieval</span>
              {isInteractive && <ArrowUpRight className="w-2.5 h-2.5" />}
            </span>
          )}
        </div>
        <p
          className={`text-[11px] leading-relaxed ${
            isProbeActive
              ? 'text-zinc-600 dark:text-zinc-300'
              : 'text-zinc-500 dark:text-zinc-400'
          }`}
        >
          {isProbeActive ? (
            <>
              Located here in <strong>Memory &amp; Personas</strong>. Tests semantic retrieval across separate sources: persistent memories, past chat turns, and File Repo document chunks.
            </>
          ) : (
            <>
              Located in <strong>Memory &amp; Personas</strong>. Tests semantic retrieval across separate sources: persistent memories, past chat turns, and File Repo document chunks.
            </>
          )}
        </p>
      </div>

      {/* Local Database Query Explorer Card */}
      <div
        role={isInteractive && !isLocalDbActive ? 'button' : undefined}
        tabIndex={isInteractive && !isLocalDbActive ? 0 : undefined}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !isLocalDbActive && isInteractive) {
            e.preventDefault();
            handleSelect('local_db');
          }
        }}
        onClick={() => {
          if (!isLocalDbActive && isInteractive) handleSelect('local_db');
        }}
        className={`p-3.5 rounded-xl space-y-1 transition-all ${
          isLocalDbActive
            ? 'border border-accent/40 bg-accent-subtle ring-1 ring-accent/20 shadow-xs'
            : 'border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/70 hover:bg-zinc-100/60 dark:hover:bg-zinc-900/60'
        } ${!isLocalDbActive && isInteractive ? 'cursor-pointer hover:border-accent/40' : ''}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div
            className={`flex items-center gap-2 text-xs font-semibold ${
              isLocalDbActive ? 'text-accent' : 'text-zinc-900 dark:text-zinc-100'
            }`}
          >
            <Database className="w-3.5 h-3.5 text-accent" />
            <span>Local Database Query Explorer (Real Disk DB)</span>
          </div>
          {isLocalDbActive ? (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-accent/20 text-accent font-semibold shrink-0">
              Active View
            </span>
          ) : (
            <span
              className={`text-[10px] font-mono shrink-0 flex items-center gap-1 ${
                isInteractive ? 'text-accent font-medium' : 'text-zinc-400'
              }`}
            >
              <span>Switch to Query DB</span>
              {isInteractive && <ArrowUpRight className="w-2.5 h-2.5" />}
            </span>
          )}
        </div>
        <p
          className={`text-[11px] leading-relaxed ${
            isLocalDbActive
              ? 'text-zinc-600 dark:text-zinc-300'
              : 'text-zinc-500 dark:text-zinc-400'
          }`}
        >
          {isLocalDbActive ? (
            <>
              Located here in <strong>Settings</strong>. Inspects the physical database file: chat history, persistent memories, settings, and cached File Repo records. This is storage browsing, not semantic retrieval.
            </>
          ) : (
            <>
              Located in <strong>Settings</strong>. Inspects the physical database file: chat history, persistent memories, settings, and cached File Repo records. This is storage browsing, not semantic retrieval.
            </>
          )}
        </p>
      </div>
    </div>
  );
};
