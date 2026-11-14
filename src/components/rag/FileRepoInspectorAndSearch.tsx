import React, { useState } from 'react';
import {
  Trash2,
  Copy,
  Check,
  Pencil,
  Search,
  MessageSquarePlus,
  Save,
  X
} from 'lucide-react';
import {
  RetrievalHit,
  VaultExcerptHit,
  DocumentChunk
} from '../../utils/rag';
import type { RagDocumentInput, VaultFileEntry } from '../../utils/rag';
import { UnifiedContextItem } from './FileRepoExplorerPanel';
import { RagConfigState } from './RagView';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';

interface PreviewHit {
  key: string;
  title: string;
  score: number;
  text: string;
}

interface FileRepoInspectorAndSearchProps {
  item: UnifiedContextItem | null;
  vectorIndex: DocumentChunk[];
  ragConfig?: RagConfigState;
  documents: RagDocumentInput[];
  vaultFiles: VaultFileEntry[];
  onUpdateDocument: (id: string, updates: Partial<Omit<RagDocumentInput, 'id'>>) => void;
  onDeleteDocument: (id: string) => void;
  onSendFilePromptToChat?: (promptText: string) => void;
}

export const FileRepoInspectorAndSearch: React.FC<FileRepoInspectorAndSearchProps> = ({
  item,
  vectorIndex,
  ragConfig,
  documents,
  vaultFiles,
  onUpdateDocument,
  onDeleteDocument,
  onSendFilePromptToChat
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(item?.title || '');
  const [editCollection, setEditCollection] = useState(item?.collection || '');
  const [editContent, setEditContent] = useState(item?.content || '');
  const [copied, setCopied] = useState(false);
  const [isConfirmDeleteOpen, setIsConfirmDeleteOpen] = useState(false);

  // Preview uses the same Nomic retrieval as chat, so the scores shown match what chat injects.
  const [testQuery, setTestQuery] = useState('');
  const [previewHits, setPreviewHits] = useState<PreviewHit[]>([]);
  const [previewStatus, setPreviewStatus] = useState<'idle' | 'searching' | 'error'>('idle');
  const [previewError, setPreviewError] = useState('');

  React.useEffect(() => {
    const query = testQuery.trim();
    if (!query || !item) {
      setPreviewHits([]);
      setPreviewStatus('idle');
      setPreviewError('');
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setPreviewStatus('searching');
      fetch('/api/rag/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          query,
          documents: item.sourceType === 'note' ? documents.filter((doc) => doc.id === item.id) : [],
          vaultEnabled: item.sourceType === 'file',
          vaultFiles: item.sourceType === 'file' ? vaultFiles : [],
          topK: ragConfig?.topK,
          minScore: ragConfig?.minScore,
          similarityMetric: ragConfig?.similarityMetric,
          hybridDenseWeight: ragConfig?.hybridDenseWeight,
          chunkSize: ragConfig?.chunkSize,
          chunkOverlap: ragConfig?.chunkOverlap,
          embeddingModel: ragConfig?.embeddingModel,
          embeddingDimensions: ragConfig?.embeddingDimensions,
          embeddingBatchSize: ragConfig?.embeddingBatchSize,
          normalizeEmbeddings: ragConfig?.normalizeEmbeddings
        })
      })
        .then(async (response) => {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
            hits?: RetrievalHit[];
            vaultHits?: VaultExcerptHit[];
          };
          if (!response.ok) throw new Error(body.error || `Search failed (HTTP ${response.status}).`);
          const fromRepo = (body.hits ?? []).map((hit): PreviewHit => ({
            key: hit.chunkId, title: hit.docTitle, score: hit.similarityScore, text: hit.text
          }));
          const fromFiles = (body.vaultHits ?? []).map((hit): PreviewHit => ({
            key: hit.chunkId, title: hit.fileName, score: hit.similarityScore, text: hit.excerpt
          }));
          setPreviewHits([...fromRepo, ...fromFiles].sort((a, b) => b.score - a.score));
          setPreviewError('');
          setPreviewStatus('idle');
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setPreviewHits([]);
          setPreviewError(error instanceof Error ? error.message : 'Search failed.');
          setPreviewStatus('error');
        });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    testQuery,
    item?.id,
    item?.sourceType,
    item?.content,
    documents,
    vaultFiles,
    ragConfig?.topK,
    ragConfig?.minScore,
    ragConfig?.similarityMetric,
    ragConfig?.hybridDenseWeight,
    ragConfig?.chunkSize,
    ragConfig?.chunkOverlap,
    ragConfig?.embeddingModel,
    ragConfig?.embeddingDimensions,
    ragConfig?.embeddingBatchSize,
    ragConfig?.normalizeEmbeddings
  ]);

  React.useEffect(() => {
    if (item) {
      setEditTitle(item.title);
      setEditCollection(item.collection);
      setEditContent(item.content);
      setIsEditing(false);
    }
  }, [item?.id]);

  if (!item) {
    return (
      <div className="h-full flex items-center justify-center p-8 text-center text-xs text-zinc-400 bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800">
        Select a context item to inspect, edit, or test semantic similarity.
      </div>
    );
  }

  const handleCopyContent = () => {
    navigator.clipboard?.writeText(item.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleSaveEdit = () => {
    if (item.sourceType !== 'note') return;
    onUpdateDocument(item.id, {
      title: editTitle.trim(),
      category: editCollection.trim(),
      content: editContent
    });
    setIsEditing(false);
  };

  const handleDelete = () => {
    if (item.sourceType === 'note') onDeleteDocument(item.id);
  };

  return (
    <div className="space-y-5">
      {/* Detail Card / Inspector */}
      <div className="p-5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {isEditing ? (
              <div className="space-y-2">
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs font-semibold rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
                />
                <input
                  type="text"
                  value={editCollection}
                  onChange={(e) => setEditCollection(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
                />
              </div>
            ) : (
              <div>
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                  {item.title}
                </h2>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 whitespace-nowrap text-[11px] text-zinc-500 font-mono mt-0.5">
                  <span className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">
                    {item.collection}
                  </span>
                  <span>{item.sourceType === 'file' ? 'File Repo · Explorer-managed' : 'Database Note'}</span>
                  <span>·</span>
                  <span>{item.tokenEstimate} tokens</span>
                  <span>·</span>
                  <span>{item.sizeBytes} B</span>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {isEditing ? (
              <>
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  className="p-1.5 rounded-lg bg-accent text-zinc-950 text-xs font-semibold flex items-center gap-1 cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Save</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </>
            ) : (
              <>
                {item.sourceType === 'note' && (
                  <button
                    type="button"
                    onClick={() => setIsEditing(true)}
                    className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
                    title="Edit database note"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleCopyContent}
                  className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
                  title="Copy content"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
                {item.sourceType === 'note' && (
                  <button
                    type="button"
                    onClick={() => setIsConfirmDeleteOpen(true)}
                    className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:text-rose-500 cursor-pointer"
                    title="Delete database note"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {item.sourceType === 'file' && (
          <p className="text-[11px] text-zinc-500">
            This file is read-only here. Manage it in Windows File Explorer and use Refresh &amp; Index to update retrieval.
          </p>
        )}

        {/* Content Viewer / Editor */}
        {isEditing ? (
          <textarea
            rows={12}
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="w-full p-3 text-xs font-mono rounded-lg bg-zinc-950 text-zinc-100 border border-zinc-800 focus-accent leading-relaxed"
          />
        ) : (
          <pre className="p-3.5 rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs font-mono text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap max-h-72 overflow-y-auto leading-relaxed">
            {item.content}
          </pre>
        )}

        {onSendFilePromptToChat && (
          <button
            type="button"
            onClick={() =>
              onSendFilePromptToChat(
                `Explain and summarize context from "${item.title}" (${item.collection}):\n\n${item.content.slice(0, 3000)}`
              )
            }
            className="w-full py-2 px-3 rounded-lg border border-accent bg-accent-subtle hover:opacity-90 text-accent text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
            <span>Send File Context to Chat Prompt</span>
          </button>
        )}
      </div>

      {/* Retrieval preview: same Nomic search and cutoff that chat uses */}
      <div className="p-5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 space-y-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-accent" />
            <h3 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
              {item.sourceType === 'file' ? 'File Repo Retrieval Preview' : 'Database Note Retrieval Preview'}
            </h3>
          </div>
          <span className="text-xs text-zinc-400">
            {vectorIndex.length} indexed chunks · cutoff {(ragConfig?.minScore ?? 0.45).toFixed(2)}
          </span>
        </div>

        <input
          type="text"
          value={testQuery}
          onChange={(e) => setTestQuery(e.target.value)}
          aria-label="Retrieval preview question"
          placeholder="Type a question to see which passages chat would retrieve..."
          className="w-full px-3.5 py-2 text-sm rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 focus-accent"
        />

        <div className="space-y-2">
          {!testQuery.trim() ? (
            <div className="py-4 text-center text-xs text-zinc-400">
              Enter a question to preview retrieval.
            </div>
          ) : previewStatus === 'error' ? (
            <div role="alert" className="py-4 text-center text-xs text-rose-600 dark:text-rose-400">
              {previewError}
            </div>
          ) : previewHits.length === 0 ? (
            <div className="py-4 text-center text-xs text-zinc-400">
              {previewStatus === 'searching'
                ? 'Searching with the Nomic embedding model...'
                : 'No passages clear the cutoff for this question. Chat would not inject any File Repo context.'}
            </div>
          ) : (
            previewHits.map((h) => (
              <div
                key={h.key}
                className="p-3 rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 space-y-1"
              >
                <div className="flex items-center justify-between text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                  <span>{h.title}</span>
                  <span className="text-[10px] font-mono text-accent">
                    score {(h.score * 100).toFixed(0)}%
                  </span>
                </div>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  {h.text}
                </p>
              </div>
            ))
          )}
        </div>
      </div>

      {item && (
        <ConfirmDeleteModal
          isOpen={isConfirmDeleteOpen}
          onClose={() => setIsConfirmDeleteOpen(false)}
          onConfirm={() => {
            setIsConfirmDeleteOpen(false);
            handleDelete();
          }}
          title="Delete Repository Item?"
          description="Are you sure you want to delete this item? This database note is removed from the database, not the File Repo."
          itemName={item.title}
          confirmLabel="Delete"
        />
      )}
    </div>
  );
};
