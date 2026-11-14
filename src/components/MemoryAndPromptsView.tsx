import React, { useState } from 'react';
import { Brain, Sparkles, Sliders, Compass } from 'lucide-react';
import { MemoryFactInput, estimateTokenCount } from '../utils/rag';
import { SystemPromptTemplate } from '../data/seedData';
import { MemoriesPanel } from './memory/MemoriesPanel';
import { PersonasAndMacrosPanel } from './memory/PersonasAndMacrosPanel';
import { DatabaseMemoryProber } from './memory/DatabaseMemoryProber';

interface MemoryAndPromptsViewProps {
  memories: MemoryFactInput[];
  onAddMemory: (mem: Omit<MemoryFactInput, 'id'>) => void;
  onUpdateMemory: (id: string, updates: Partial<Omit<MemoryFactInput, 'id'>>) => void;
  onToggleMemory: (id: string) => void;
  onDeleteMemory: (id: string) => void;
  onTogglePinMemory?: (id: string) => void;
  onImportMemories?: (imported: MemoryFactInput[]) => void;
  messagesBySession?: Record<string, any[]>;
  sessions?: any[];
  promptTemplates: SystemPromptTemplate[];
  activeSystemPrompt: string;
  onAddPromptTemplate: (tpl: Omit<SystemPromptTemplate, 'id'>) => void;
  onUpdatePromptTemplate: (id: string, updates: Partial<Omit<SystemPromptTemplate, 'id'>>) => void;
  onDeletePromptTemplate: (id: string) => void;
  onApplyTemplateToActiveSession: (tpl: SystemPromptTemplate) => void;
}

type MemoryTab = 'global_memory' | 'personas' | 'probe_db';

export const MemoryAndPromptsView: React.FC<MemoryAndPromptsViewProps> = ({
  memories,
  onAddMemory,
  onUpdateMemory,
  onToggleMemory,
  onDeleteMemory,
  onTogglePinMemory,
  onImportMemories,
  messagesBySession,
  sessions,
  promptTemplates,
  activeSystemPrompt,
  onAddPromptTemplate,
  onUpdatePromptTemplate,
  onDeletePromptTemplate,
  onApplyTemplateToActiveSession
}) => {
  const [activeTab, setActiveTab] = useState<MemoryTab>('global_memory');

  const totalActiveTokens = memories
    .filter((m) => m.isActive)
    .reduce((sum, m) => sum + estimateTokenCount(`${m.key}: ${m.fact}`), 0);

  return (
    <div className="flex-1 h-full overflow-y-auto bg-stone-50/30 dark:bg-zinc-950 p-4 sm:p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="pb-4 border-b border-zinc-200 dark:border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                <Brain className="w-5 h-5 text-accent" />
                <span>Global Memory &amp; Directives</span>
              </h1>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-1">
                Persistent system instructions, user directives, and custom role personas injected into chat prompts.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            <span className="text-xs font-mono text-zinc-400 whitespace-nowrap">
              Active Tokens: ~{totalActiveTokens}
            </span>
            <div className="inline-flex whitespace-nowrap rounded-lg p-0.5 bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setActiveTab('global_memory')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer ${
                  activeTab === 'global_memory'
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-semibold'
                    : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                }`}
              >
                <Sliders className="w-3.5 h-3.5" />
                <span>Directives ({memories.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('personas')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer ${
                  activeTab === 'personas'
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-semibold'
                    : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Personas ({promptTemplates.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('probe_db')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer ${
                  activeTab === 'probe_db'
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-semibold'
                    : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                }`}
              >
                <Compass className="w-3.5 h-3.5 text-accent" />
                <span>Probe DB</span>
              </button>
            </div>
          </div>
        </div>

        {activeTab === 'global_memory' && (
          <MemoriesPanel
            memories={memories}
            onAddMemory={onAddMemory}
            onUpdateMemory={onUpdateMemory}
            onToggleMemory={onToggleMemory}
            onDeleteMemory={onDeleteMemory}
            onTogglePinMemory={onTogglePinMemory}
            onImportMemories={onImportMemories}
            messagesBySession={messagesBySession}
            sessions={sessions}
            onOpenProbe={() => setActiveTab('probe_db')}
          />
        )}
        {activeTab === 'personas' && (
          <PersonasAndMacrosPanel
            promptTemplates={promptTemplates}
            activeSystemPrompt={activeSystemPrompt}
            onAddPromptTemplate={onAddPromptTemplate}
            onUpdatePromptTemplate={onUpdatePromptTemplate}
            onDeletePromptTemplate={onDeletePromptTemplate}
            onApplyTemplateToActiveSession={onApplyTemplateToActiveSession}
          />
        )}
        {activeTab === 'probe_db' && (
          <DatabaseMemoryProber
            memories={memories}
            messagesBySession={messagesBySession as any}
            sessions={sessions as any}
          />
        )}
      </div>
    </div>
  );
};
