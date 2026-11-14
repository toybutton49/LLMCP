import React, { useState, useMemo } from 'react';
import {
  RagDocumentInput,
  VaultFileEntry,
  SimilarityMetricId,
  buildVectorIndex,
  estimateTokenCount
} from '../../utils/rag';
import { FileRepoExplorerPanel, UnifiedContextItem } from './FileRepoExplorerPanel';
import { FileRepoInspectorAndSearch } from './FileRepoInspectorAndSearch';

export interface RagConfigState {
  embeddingModel?: string;
  ocrModel?: string;
  embeddingDimensions?: number;
  embeddingBatchSize?: number;
  normalizeEmbeddings?: boolean;
  hybridDenseWeight?: number;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  similarityMetric?: SimilarityMetricId;
  minScore?: number;
}

interface RagViewProps {
  ragLabel?: string;
  documents: RagDocumentInput[];
  ragConfig: RagConfigState;
  onAddDocument: (doc: Omit<RagDocumentInput, 'id'>) => void;
  onUpdateDocument: (id: string, updates: Partial<Omit<RagDocumentInput, 'id'>>) => void;
  onDeleteDocument: (docId: string) => void;
  vaultFiles?: VaultFileEntry[];
  onReplaceVaultFiles: (files: VaultFileEntry[]) => void;
  onUpdateVaultFile?: (
    id: string,
    updates: Partial<Omit<VaultFileEntry, 'id' | 'createdAt'>>
  ) => void;
  onSetAllVaultPins?: (pinned: boolean) => void;
  onSendFilePromptToChat?: (promptText: string) => void;
}

export const RagView: React.FC<RagViewProps> = ({
  ragLabel = 'File Repo',
  documents,
  ragConfig,
  onAddDocument,
  onUpdateDocument,
  onDeleteDocument,
  vaultFiles = [],
  onReplaceVaultFiles,
  onUpdateVaultFile,
  onSetAllVaultPins,
  onSendFilePromptToChat
}) => {
  const [searchFilter, setSearchFilter] = useState('');
  const [selectedCollection, setSelectedCollection] = useState<string>('ALL');
  const [sortField, setSortField] = useState<'title' | 'collection' | 'sizeBytes'>('title');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<'file' | 'note'>('file');

  const unifiedItems: UnifiedContextItem[] = useMemo(() => {
    const fromFiles: UnifiedContextItem[] = vaultFiles.map((vf) => ({
      id: vf.id,
      sourceType: 'file',
      title: vf.relativePath || vf.fileName,
      collection: vf.collection || 'General',
      content: vf.content,
      tokenEstimate: vf.tokenEstimate,
      sizeBytes: vf.sizeBytes,
      pinnedInChat: vf.pinnedInChat,
      rawFile: vf
    }));

    const fromDocs: UnifiedContextItem[] = documents.map((doc) => ({
      id: doc.id,
      sourceType: 'note',
      title: doc.title,
      collection: doc.category || 'Notes',
      content: doc.content,
      tokenEstimate: estimateTokenCount(doc.content),
      sizeBytes: doc.content.length,
      pinnedInChat: true,
      rawDoc: doc
    }));

    return [...fromFiles, ...fromDocs];
  }, [vaultFiles, documents]);

  const collections = useMemo(() => {
    const set = new Set<string>();
    for (const item of unifiedItems) {
      if (item.sourceType === activeSource && item.collection) set.add(item.collection);
    }
    return Array.from(set);
  }, [unifiedItems, activeSource]);

  const filteredItems = useMemo(() => {
    const matches = unifiedItems.filter((item) => {
      if (item.sourceType !== activeSource) return false;
      if (selectedCollection !== 'ALL' && item.collection !== selectedCollection) {
        return false;
      }
      if (!searchFilter.trim()) return true;
      const q = searchFilter.toLowerCase();
      return (
        item.title.toLowerCase().includes(q) ||
        item.collection.toLowerCase().includes(q) ||
        item.content.toLowerCase().includes(q)
      );
    });

    return [...matches].sort((a, b) => {
      const cmp =
        sortField === 'sizeBytes'
          ? a.sizeBytes - b.sizeBytes
          : a[sortField].localeCompare(b[sortField]);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [unifiedItems, activeSource, selectedCollection, searchFilter, sortField, sortDir]);

  const inspectedItem = useMemo(() => {
    if (selectedItemId) {
      const found = filteredItems.find((i) => i.id === selectedItemId);
      if (found) return found;
    }
    return filteredItems[0] || null;
  }, [selectedItemId, filteredItems]);

  const combinedRagDocuments = useMemo(() => {
    const fileDocs: RagDocumentInput[] = vaultFiles.map((vf) => ({
      id: `file_${vf.id}`,
      title: vf.relativePath || vf.fileName,
      category: vf.collection,
      content: vf.content
    }));
    return [...documents, ...fileDocs];
  }, [documents, vaultFiles]);

  const vectorIndex = useMemo(
    () =>
      buildVectorIndex(
        combinedRagDocuments,
        ragConfig.chunkSize,
        ragConfig.chunkOverlap,
        ragConfig.embeddingDimensions,
        ragConfig.normalizeEmbeddings ?? true
      ),
    [
      combinedRagDocuments,
      ragConfig.chunkSize,
      ragConfig.chunkOverlap,
      ragConfig.embeddingDimensions,
      ragConfig.normalizeEmbeddings
    ]
  );

  const handleToggleSort = (field: 'title' | 'collection' | 'sizeBytes') => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  return (
    <div className="flex-1 h-full overflow-y-auto bg-stone-50/40 dark:bg-zinc-950 p-4 sm:p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="pb-4 border-b border-zinc-200 dark:border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
                {ragLabel}
              </h1>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-1">
                File Repo documents live on disk and are managed in File Explorer. Database notes and chat memories remain separate.
              </p>
            </div>
          </div>
          <div className="text-xs font-mono text-accent">
            {vaultFiles.length} File Repo files · {documents.length} database notes · {vectorIndex.length} searchable chunks
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-6 xl:col-span-5">
            <FileRepoExplorerPanel
              ragLabel={ragLabel}
              items={filteredItems}
              fileCount={vaultFiles.length}
              noteCount={documents.length}
              activeSource={activeSource}
              onSourceChange={(source) => {
                setActiveSource(source);
                setSelectedCollection('ALL');
                setSearchFilter('');
              }}
              collections={collections}
              selectedCollection={selectedCollection}
              onSelectCollection={setSelectedCollection}
              searchFilter={searchFilter}
              onSearchChange={setSearchFilter}
              sortField={sortField}
              sortDir={sortDir}
              onToggleSort={handleToggleSort}
              selectedItemId={inspectedItem?.id || null}
              onSelectItem={setSelectedItemId}
              onAddDocument={onAddDocument}
              onReplaceVaultFiles={onReplaceVaultFiles}
              onUpdateVaultFile={onUpdateVaultFile}
              onSetAllVaultPins={onSetAllVaultPins}
            />
          </div>

          <div className="lg:col-span-6 xl:col-span-7">
            <FileRepoInspectorAndSearch
              item={inspectedItem}
              vectorIndex={vectorIndex}
              ragConfig={ragConfig}
              documents={documents}
              vaultFiles={vaultFiles}
              onUpdateDocument={onUpdateDocument}
              onDeleteDocument={onDeleteDocument}
              onSendFilePromptToChat={onSendFilePromptToChat}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
