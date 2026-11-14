import React from 'react';
import { X } from 'lucide-react';
import { DatabaseMemoryProber } from './DatabaseMemoryProber';
import type { DatabaseMemoryProbeHit } from '../../utils/memory/memoryProbeEngine';
import type { MemoryFactInput } from '../../utils/rag/ragTypes';
import type { WorkspaceMessage, WorkspaceSession } from '../../data/seedData';

interface MemoryProbeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onProbe?: (query: string, scope: 'all' | 'memories' | 'conversations') => Promise<{
    hits: DatabaseMemoryProbeHit[];
    contextSnippet: string;
    totalRecordsScanned: number;
    durationMs: number;
  }>;
  memories?: MemoryFactInput[];
  messagesBySession?: Record<string, WorkspaceMessage[]>;
  sessions?: WorkspaceSession[];
}

export const MemoryProbeModal: React.FC<MemoryProbeModalProps> = ({
  isOpen,
  onClose,
  memories = [],
  messagesBySession = {},
  sessions = []
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs overflow-y-auto">
      <div className="w-full max-w-4xl rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-500 font-mono">
            Semantic Memory Prober
          </span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 overflow-y-auto">
          <DatabaseMemoryProber
            memories={memories}
            messagesBySession={messagesBySession}
            sessions={sessions}
          />
        </div>
      </div>
    </div>
  );
};
