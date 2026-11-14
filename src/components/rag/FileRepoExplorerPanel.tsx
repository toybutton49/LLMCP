import React, { useState } from 'react';
import {
  ArrowUpDown,
  FileText,
  FolderOpen,
  Pin,
  Plus,
  RefreshCw,
  Search
} from 'lucide-react';
import { RagDocumentInput, VaultFileEntry, createVaultFileEntry } from '../../utils/rag';

export interface UnifiedContextItem {
  id: string;
  sourceType: 'file' | 'note';
  title: string;
  collection: string;
  content: string;
  tokenEstimate: number;
  sizeBytes: number;
  pinnedInChat: boolean;
  rawFile?: VaultFileEntry;
  rawDoc?: RagDocumentInput;
}

interface FileRepoExplorerPanelProps {
  ragLabel: string;
  items: UnifiedContextItem[];
  fileCount: number;
  noteCount: number;
  activeSource: 'file' | 'note';
  onSourceChange: (source: 'file' | 'note') => void;
  collections: string[];
  selectedCollection: string;
  onSelectCollection: (col: string) => void;
  searchFilter: string;
  onSearchChange: (q: string) => void;
  sortField: 'title' | 'collection' | 'sizeBytes';
  sortDir: 'asc' | 'desc';
  onToggleSort: (field: 'title' | 'collection' | 'sizeBytes') => void;
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
  onAddDocument: (doc: Omit<RagDocumentInput, 'id'>) => void;
  onReplaceVaultFiles: (files: VaultFileEntry[]) => void;
  onUpdateVaultFile?: (id: string, updates: Partial<Omit<VaultFileEntry, 'id' | 'createdAt'>>) => void;
  onSetAllVaultPins?: (pinned: boolean) => void;
}

function isVaultFileEntry(value: unknown): value is VaultFileEntry {
  if (!value || typeof value !== 'object') return false;
  const file = value as Record<string, unknown>;
  return ['id', 'fileName', 'fileExtension', 'mimeType', 'collection', 'content',
    'sha256Preview', 'createdAt', 'updatedAt'].every((key) => typeof file[key] === 'string') &&
    typeof file.sizeBytes === 'number' &&
    typeof file.tokenEstimate === 'number' &&
    typeof file.pinnedInChat === 'boolean' &&
    (file.relativePath === undefined || typeof file.relativePath === 'string');
}

export const FileRepoExplorerPanel: React.FC<FileRepoExplorerPanelProps> = ({
  ragLabel,
  items,
  fileCount,
  noteCount,
  activeSource,
  onSourceChange,
  collections,
  selectedCollection,
  onSelectCollection,
  searchFilter,
  onSearchChange,
  sortField,
  sortDir,
  onToggleSort,
  selectedItemId,
  onSelectItem,
  onAddDocument,
  onReplaceVaultFiles,
  onUpdateVaultFile,
  onSetAllVaultPins
}) => {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [notice, setNotice] = useState('');
  const [noteTitle, setNoteTitle] = useState('');
  const [noteCategory, setNoteCategory] = useState('');
  const [noteContent, setNoteContent] = useState('');

  const refreshFileRepo = async () => {
    setIsRefreshing(true);
    setNotice('');
    try {
      const response = await fetch('/api/file-repo/refresh', { method: 'POST' });
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object') throw new Error('Invalid File Repo refresh response.');
      const data = payload as {
        error?: unknown;
        files?: unknown;
        ocrCount?: unknown;
        migratedCount?: unknown;
      };
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `Refresh failed (HTTP ${response.status}).`);
      if (!Array.isArray(data.files) || !data.files.every(isVaultFileEntry)) {
        throw new Error('File Repo refresh returned an invalid file list.');
      }
      const files = data.files.map((file) => createVaultFileEntry(file));
      onReplaceVaultFiles(files);
      setNotice(
        `Refreshed ${files.length} File Repo file(s); OCR processed ${Number(data.ocrCount) || 0}; migrated ${Number(data.migratedCount) || 0} legacy file(s).`
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not refresh File Repo.');
    } finally {
      setIsRefreshing(false);
    }
  };

  const openFileExplorer = async () => {
    setIsOpening(true);
    setNotice('');
    try {
      const response = await fetch('/api/file-repo/open', { method: 'POST' });
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object') throw new Error('Invalid File Repo open response.');
      const data = payload as { error?: unknown };
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `Could not open File Repo (HTTP ${response.status}).`);
      setNotice('Manage files in Explorer, then refresh File Repo to index your changes.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not open File Repo in Explorer.');
    } finally {
      setIsOpening(false);
    }
  };

  const handleCreateNote = (event: React.FormEvent) => {
    event.preventDefault();
    if (!noteTitle.trim() || !noteContent.trim()) {
      setNotice('A database note needs both a title and content.');
      return;
    }
    onAddDocument({
      title: noteTitle.trim(),
      category: noteCategory.trim() || 'Notes',
      content: noteContent
    });
    setNoteTitle('');
    setNoteCategory('');
    setNoteContent('');
    setShowNoteForm(false);
    setNotice('Database note added.');
  };

  return (
    <div className="flex flex-col h-full space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onSourceChange('file')}
          className={`rounded-lg border px-3 py-2 text-left text-xs ${
            activeSource === 'file'
              ? 'border-accent bg-accent-subtle text-accent'
              : 'border-zinc-200 dark:border-zinc-800 text-zinc-500'
          }`}
        >
          <span className="block font-semibold">File Repo · {fileCount}</span>
          <span className="text-[11px]">Explorer-managed documents</span>
        </button>
        <button
          type="button"
          onClick={() => onSourceChange('note')}
          className={`rounded-lg border px-3 py-2 text-left text-xs ${
            activeSource === 'note'
              ? 'border-accent bg-accent-subtle text-accent'
              : 'border-zinc-200 dark:border-zinc-800 text-zinc-500'
          }`}
        >
          <span className="block font-semibold">Database Notes · {noteCount}</span>
          <span className="text-[11px]">Stored separately from File Repo</span>
        </button>
      </div>

      {activeSource === 'file' ? (
        <div className="space-y-2 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void openFileExplorer()}
              disabled={isOpening}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs font-semibold disabled:opacity-50"
            >
              <FolderOpen className="h-4 w-4 text-accent" />
              {isOpening ? 'Opening...' : 'Open in Windows File Explorer'}
            </button>
            <button
              type="button"
              onClick={() => void refreshFileRepo()}
              disabled={isRefreshing}
              className="flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-zinc-950 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              {isRefreshing ? 'Refreshing...' : 'Refresh & Index'}
            </button>
          </div>
          <p className="text-[11px] text-zinc-500">
            Add, edit, move, or delete files in Explorer. Refresh re-reads this File Repo folder, OCRs supported documents, and updates semantic search.
          </p>
        </div>
      ) : (
        <div className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
          <p className="text-[11px] text-zinc-500">Database notes are stored separately and do not create files in the File Repo.</p>
          <button
            type="button"
            onClick={() => { setShowNoteForm((previous) => !previous); setNotice(''); }}
            className="flex items-center gap-1 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-zinc-950"
          >
            <Plus className="h-3.5 w-3.5" />
            {showNoteForm ? 'Cancel' : 'New Note'}
          </button>
        </div>
      )}

      {notice && <p role="status" className="text-xs text-zinc-500">{notice}</p>}

      {showNoteForm && activeSource === 'note' && (
        <form onSubmit={handleCreateNote} className="space-y-2 rounded-lg border border-accent p-3">
          <input
            value={noteTitle}
            onChange={(event) => setNoteTitle(event.target.value)}
            placeholder="Database note title"
            className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs dark:border-zinc-800 dark:bg-zinc-950"
          />
          <input
            value={noteCategory}
            onChange={(event) => setNoteCategory(event.target.value)}
            placeholder="Category (optional)"
            className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs dark:border-zinc-800 dark:bg-zinc-950"
          />
          <textarea
            rows={5}
            value={noteContent}
            onChange={(event) => setNoteContent(event.target.value)}
            placeholder="Note content"
            className="w-full rounded-lg border border-zinc-200 bg-white p-2.5 text-xs font-mono dark:border-zinc-800 dark:bg-zinc-950"
          />
          <button type="submit" className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-zinc-950">
            Save Database Note
          </button>
        </form>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex min-w-[200px] flex-1 items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-zinc-400" />
            <input
              type="text"
              value={searchFilter}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={`Filter ${items.length} ${activeSource === 'file' ? ragLabel : 'database note'} items...`}
              className="w-full rounded-lg border border-zinc-200 bg-white py-1.5 pl-9 pr-3 text-xs dark:border-zinc-800 dark:bg-zinc-900"
            />
          </div>
          <button
            type="button"
            onClick={() => onToggleSort('title')}
            aria-label="Sort items by title"
            className={`flex items-center gap-1 rounded-lg border p-1.5 text-xs ${
              sortField === 'title' ? 'border-accent text-accent' : 'border-zinc-200 text-zinc-500 dark:border-zinc-800'
            }`}
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
            {sortDir === 'asc' ? 'A-Z' : 'Z-A'}
          </button>
        </div>
        {activeSource === 'file' && onSetAllVaultPins && items.some((item) => item.rawFile && !item.pinnedInChat) && (
          <button
            type="button"
            onClick={() => onSetAllVaultPins(true)}
            className="flex items-center gap-1 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs dark:border-zinc-800"
          >
            <Pin className="h-3 w-3 text-accent" />
            Pin All
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onSelectCollection('ALL')}
          className={`rounded-md px-2.5 py-1 text-xs ${
            selectedCollection === 'ALL' ? 'bg-accent font-semibold text-zinc-950' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400'
          }`}
        >
          All ({items.length})
        </button>
        {collections.map((collection) => (
          <button
            key={collection}
            type="button"
            onClick={() => onSelectCollection(collection)}
            className={`rounded-md px-2.5 py-1 text-xs ${
              selectedCollection === collection ? 'bg-accent font-semibold text-zinc-950' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400'
            }`}
          >
            {collection}
          </button>
        ))}
      </div>

      <div className="min-h-[300px] flex-1 space-y-2 overflow-y-auto pr-1">
        {items.length === 0 ? (
          <div className="py-12 text-center text-xs text-zinc-400">
            {activeSource === 'file'
              ? `No files indexed in ${ragLabel}. Add them in File Explorer, then refresh.`
              : 'No database notes found.'}
          </div>
        ) : items.map((item) => (
          <div
            key={item.id}
            onClick={() => onSelectItem(item.id)}
            className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-3 ${
              selectedItemId === item.id
                ? 'border-accent bg-accent-subtle'
                : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900'
            }`}
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className={`shrink-0 rounded-lg p-2 ${
                item.sourceType === 'file' ? 'bg-accent-subtle text-accent' : 'bg-sky-500/10 text-sky-500'
              }`}>
                <FileText className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold">{item.title}</div>
                <div className="mt-0.5 flex items-center gap-2 truncate font-mono text-[11px] text-zinc-500">
                  <span>{item.collection}</span>
                  <span>·</span>
                  <span>{item.tokenEstimate} tokens</span>
                  <span>·</span>
                  <span>{item.sizeBytes} B</span>
                </div>
              </div>
            </div>
            {item.rawFile && onUpdateVaultFile && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onUpdateVaultFile(item.id, { pinnedInChat: !item.pinnedInChat });
                }}
                className={`cursor-pointer rounded-lg p-1.5 ${
                  item.pinnedInChat ? 'text-accent' : 'text-zinc-400'
                }`}
                title={item.pinnedInChat ? 'Pinned in Chat' : 'Unpinned'}
              >
                <Pin className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
