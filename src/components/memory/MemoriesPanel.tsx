import React, { useState, useMemo, useRef } from 'react';
import {
  Shield,
  User,
  Plus,
  Search,
  Download,
  Upload,
  Pin,
  Sparkles,
  Compass,
  CheckCircle2,
  Trash2,
  Filter
} from 'lucide-react';
import type { MemoryFactInput, MemoryCategory } from '../../utils/rag/ragTypes';
import { MemoryCard } from './MemoryCard';
import { MemoryFormModal } from './MemoryFormModal';
import { MemoryProbeModal } from './MemoryProbeModal';
import {
  computeMemoryStats,
  exportMemoriesAsJson,
  parseAndValidateMemoriesJson,
  mergeMemories,
  findDuplicateMemories
} from '../../utils/memory';
import { probeDatabaseMemory, DatabaseMemoryProbeHit } from '../../utils/memory/memoryProbeEngine';

interface MemoriesPanelProps {
  memories: MemoryFactInput[];
  onAddMemory: (mem: Omit<MemoryFactInput, 'id'>) => void;
  onUpdateMemory: (id: string, updates: Partial<Omit<MemoryFactInput, 'id'>>) => void;
  onToggleMemory: (id: string) => void;
  onDeleteMemory: (id: string) => void;
  onTogglePinMemory?: (id: string) => void;
  onImportMemories?: (imported: MemoryFactInput[]) => void;
  messagesBySession?: Record<string, any[]>;
  sessions?: any[];
  onOpenProbe?: () => void;
}

type FilterCategory = 'all' | MemoryCategory | 'pinned';

export const MemoriesPanel: React.FC<MemoriesPanelProps> = ({
  memories,
  onAddMemory,
  onUpdateMemory,
  onToggleMemory,
  onDeleteMemory,
  onTogglePinMemory,
  onImportMemories,
  messagesBySession = {},
  sessions = [],
  onOpenProbe
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFilter, setSelectedFilter] = useState<FilterCategory>('all');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isProbeOpen, setIsProbeOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const stats = useMemo(() => computeMemoryStats(memories), [memories]);

  const handleTogglePin = (id: string) => {
    if (onTogglePinMemory) {
      onTogglePinMemory(id);
    } else {
      const target = memories.find((m) => m.id === id);
      if (target) {
        onUpdateMemory(id, { pinned: !target.pinned });
      }
    }
  };

  const filteredMemories = useMemo(() => {
    let list = memories;

    if (selectedFilter === 'pinned') {
      list = list.filter((m) => m.pinned);
    } else if (selectedFilter !== 'all') {
      list = list.filter((m) => m.category === selectedFilter);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((m) => {
        return (
          m.key.toLowerCase().includes(q) ||
          m.fact.toLowerCase().includes(q) ||
          (m.tags || []).some((t) => t.toLowerCase().includes(q))
        );
      });
    }

    return list;
  }, [memories, selectedFilter, searchQuery]);

  const handleExportJson = () => {
    const jsonStr = exportMemoriesAsJson(memories);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `llmcp-memories-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setNotice(`Exported ${memories.length} directive(s) to JSON.`);
    setTimeout(() => setNotice(null), 3000);
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = String(event.target?.result || '');
      const parsed = parseAndValidateMemoriesJson(content);
      if (!parsed.valid || parsed.memories.length === 0) {
        setNotice(`Import failed: ${parsed.errors.join(', ') || 'Invalid JSON'}`);
        return;
      }
      const mergeRes = mergeMemories(memories, parsed.memories, 'merge_overwrite');
      if (onImportMemories) {
        onImportMemories(mergeRes.merged);
      } else {
        for (const inc of parsed.memories) {
          onAddMemory(inc);
        }
      }
      setNotice(`Imported ${mergeRes.added} new and updated ${mergeRes.updated} directive(s).`);
      setTimeout(() => setNotice(null), 3500);
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDeduplicate = () => {
    const dupes = findDuplicateMemories(memories);
    if (dupes.length === 0) {
      setNotice('Memory hygiene clean: zero duplicates or conflicting directives found.');
    } else {
      setNotice(`Found ${dupes.length} potential duplicate(s) (e.g. "${dupes[0].duplicate.key}").`);
    }
    setTimeout(() => setNotice(null), 4000);
  };

  const handleProbe = async (query: string, scope: 'all' | 'memories' | 'conversations') => {
    return probeDatabaseMemory({
      query,
      memories,
      messagesBySession,
      sessions,
      scope,
      topK: 6
    });
  };

  return (
    <div className="space-y-5">
      {notice && (
        <div className="px-4 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 flex items-center justify-between shadow-lg">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-zinc-400 hover:text-zinc-200 text-xs"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Stats Summary Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60">
          <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Total Directives</div>
          <div className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mt-0.5">{stats.total}</div>
        </div>
        <div className="p-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60">
          <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Active Directives</div>
          <div className="text-lg font-bold text-accent mt-0.5">{stats.active}</div>
        </div>
        <div className="p-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60">
          <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Pinned Directives</div>
          <div className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mt-0.5">{stats.pinned}</div>
        </div>
        <div className="p-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60">
          <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Active Tokens</div>
          <div className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mt-0.5">~{stats.totalTokens}</div>
        </div>
      </div>

      {/* Control Actions Bar */}
      <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search directives by topic, content, or #tag..."
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400"
          />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => {
              if (onOpenProbe) {
                onOpenProbe();
              } else {
                setIsProbeOpen(true);
              }
            }}
            className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 flex items-center gap-1.5 cursor-pointer"
            title="Send live probe to the application database"
          >
            <Compass className="w-3.5 h-3.5 text-accent" />
            <span>Probe DB</span>
          </button>

          <button
            type="button"
            onClick={handleExportJson}
            className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 flex items-center gap-1.5 cursor-pointer"
            title="Export directives to JSON"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export</span>
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 flex items-center gap-1.5 cursor-pointer"
            title="Import directives from JSON"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Import</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImportFile}
            className="hidden"
          />

          <button
            type="button"
            onClick={() => setIsFormOpen(true)}
            className="px-3.5 py-1.5 rounded-lg bg-accent text-zinc-950 font-semibold text-xs flex items-center gap-1.5 cursor-pointer ml-auto sm:ml-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Directive</span>
          </button>
        </div>
      </div>

      {/* Filter Category Pills */}
      <div className="flex items-center gap-1.5 flex-wrap text-xs">
        <button
          type="button"
          onClick={() => setSelectedFilter('all')}
          className={`px-3 py-1 rounded-lg transition-colors cursor-pointer ${
            selectedFilter === 'all'
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-semibold'
              : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }`}
        >
          All ({memories.length})
        </button>
        <button
          type="button"
          onClick={() => setSelectedFilter('pinned')}
          className={`px-3 py-1 rounded-lg transition-colors flex items-center gap-1 cursor-pointer ${
            selectedFilter === 'pinned'
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-semibold'
              : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }`}
        >
          <Pin className="w-3 h-3 text-accent" />
          <span>Pinned ({stats.pinned})</span>
        </button>
        <button
          type="button"
          onClick={() => setSelectedFilter('system_directive')}
          className={`px-3 py-1 rounded-lg transition-colors cursor-pointer ${
            selectedFilter === 'system_directive'
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-semibold'
              : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }`}
        >
          Directives ({stats.byCategory.system_directive})
        </button>
        <button
          type="button"
          onClick={() => setSelectedFilter('constraint')}
          className={`px-3 py-1 rounded-lg transition-colors cursor-pointer ${
            selectedFilter === 'constraint'
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-semibold'
              : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }`}
        >
          Constraints ({stats.byCategory.constraint})
        </button>
        <button
          type="button"
          onClick={() => setSelectedFilter('architecture')}
          className={`px-3 py-1 rounded-lg transition-colors cursor-pointer ${
            selectedFilter === 'architecture'
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-semibold'
              : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }`}
        >
          Architecture ({stats.byCategory.architecture})
        </button>
        <button
          type="button"
          onClick={() => setSelectedFilter('preference')}
          className={`px-3 py-1 rounded-lg transition-colors cursor-pointer ${
            selectedFilter === 'preference'
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-semibold'
              : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }`}
        >
          Preferences ({stats.byCategory.preference})
        </button>
        <button
          type="button"
          onClick={() => setSelectedFilter('project')}
          className={`px-3 py-1 rounded-lg transition-colors cursor-pointer ${
            selectedFilter === 'project'
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-semibold'
              : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }`}
        >
          Project ({stats.byCategory.project})
        </button>
      </div>

      {/* Memory Cards Grid */}
      {filteredMemories.length === 0 ? (
        <div className="p-12 text-center rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 space-y-3">
          <Shield className="w-8 h-8 text-zinc-400 mx-auto" />
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {searchQuery ? 'No matching directives found' : 'No memory directives registered yet'}
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-md mx-auto">
            {searchQuery
              ? `No directives matched your query "${searchQuery}". Try a different search term or clear the filter.`
              : 'Add persistent directives, constraints, or preferences so the local LLM adheres to your standards across all chats.'}
          </p>
          {!searchQuery && (
            <button
              type="button"
              onClick={() => setIsFormOpen(true)}
              className="px-4 py-2 rounded-xl bg-accent text-zinc-950 font-semibold text-xs inline-flex items-center gap-1.5 cursor-pointer mt-2"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create First Directive</span>
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
          {filteredMemories.map((mem) => (
            <MemoryCard
              key={mem.id}
              memory={mem}
              onUpdate={onUpdateMemory}
              onToggle={onToggleMemory}
              onTogglePin={handleTogglePin}
              onDelete={onDeleteMemory}
            />
          ))}
        </div>
      )}

      {/* Modals */}
      <MemoryFormModal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        onAddMemory={onAddMemory}
      />

      <MemoryProbeModal
        isOpen={isProbeOpen}
        onClose={() => setIsProbeOpen(false)}
        onProbe={handleProbe}
        memories={memories}
        messagesBySession={messagesBySession}
        sessions={sessions}
      />
    </div>
  );
};
