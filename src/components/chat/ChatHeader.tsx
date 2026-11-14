import React, { useState, useEffect } from 'react';
import {
  Pencil,
  Check,
  X,
  RotateCcw,
  BarChart2,
  Download
} from 'lucide-react';
import { WorkspaceSession, SystemPromptTemplate } from '../../data/seedData';
import { WorkspaceBranding } from '../../utils/rag';
import { ProviderOption } from '../ChatView';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';

interface ChatHeaderProps {
  session: WorkspaceSession;
  providers?: ProviderOption[];
  providersLoaded?: boolean;
  promptTemplates?: SystemPromptTemplate[];
  totalSessionTokens?: number;
  messageCount?: number;
  onUpdateSession: (updates: Partial<WorkspaceSession>) => void;
  onOpenContextInspector?: () => void;
  onOpenTokenAnalytics: () => void;
  onForkSession?: () => void;
  onExportMarkdown?: () => void;
  onDownloadChatDebug?: () => void;
  onClearSessionMessages: () => void;
  activeProviderId?: string;
  activeModelId?: string;
  branding?: WorkspaceBranding;
  onOpenAnalyticsTab?: () => void;
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({
  session,
  messageCount = 0,
  onUpdateSession,
  onClearSessionMessages,
  onOpenTokenAnalytics,
  onDownloadChatDebug
}) => {
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(session.title);
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);

  useEffect(() => {
    setTitleDraft(session.title);
    setIsEditingTitle(false);
    setIsConfirmingClear(false);
  }, [session.id, session.title]);

  useEffect(() => {
    if (messageCount === 0) {
      setIsConfirmingClear(false);
    }
  }, [messageCount]);

  const handleTitleSave = () => {
    if (titleDraft.trim() && titleDraft !== session.title) {
      onUpdateSession({ title: titleDraft.trim() });
    }
    setIsEditingTitle(false);
  };

  return (
    <header className="min-h-14 px-3 sm:px-5 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-xs flex flex-wrap items-center justify-between gap-2 sm:gap-3 shrink-0 relative z-30 select-none">
      <div className="flex items-center gap-2 min-w-[180px] flex-1">
        {isEditingTitle ? (
          <div className="flex items-center gap-1.5 min-w-0 w-full">
            <input
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleTitleSave();
                if (e.key === 'Escape') {
                  setTitleDraft(session.title);
                  setIsEditingTitle(false);
                }
              }}
              autoFocus
              className="min-w-0 flex-1 text-sm font-semibold px-2 py-0.5 rounded border border-accent bg-stone-50 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none"
            />
            <button
              type="button"
              onClick={handleTitleSave}
              className="shrink-0 p-1 rounded text-accent hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
              title="Save chat title"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setTitleDraft(session.title);
                setIsEditingTitle(false);
              }}
              className="shrink-0 p-1 rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 cursor-pointer"
              title="Cancel title editing"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 group min-w-0">
            <h1 className="font-heading text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-stone-100 truncate">
              {session.title}
            </h1>
            <button
              type="button"
              onClick={() => setIsEditingTitle(true)}
              title="Rename conversation"
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0 p-1 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-opacity cursor-pointer"
            >
              <Pencil className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2 max-w-full">
        {onOpenTokenAnalytics && (
          <button
            type="button"
            onClick={onOpenTokenAnalytics}
            title="Inspect Token Allocation & Analytics"
            aria-label="Inspect Token Analytics"
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono rounded-md border border-zinc-200 dark:border-zinc-800 bg-stone-50 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors cursor-pointer whitespace-nowrap shadow-xs"
          >
            <BarChart2 className="w-3.5 h-3.5 text-accent shrink-0" />
            <span className="hidden sm:inline font-sans">Tokens</span>
          </button>
        )}

        {onDownloadChatDebug && (
          <button
            type="button"
            data-testid="download-chat-btn"
            onClick={onDownloadChatDebug}
            title="Download Chat Log for Debugging (.json)"
            aria-label="Download Chat for Debugging"
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono rounded-md border border-zinc-200 dark:border-zinc-800 bg-stone-50 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors cursor-pointer whitespace-nowrap shadow-xs"
          >
            <Download className="w-3.5 h-3.5 text-accent shrink-0" />
            <span className="hidden sm:inline font-sans">Download</span>
          </button>
        )}

        <button
          type="button"
          data-testid="clear-chat-trigger-btn"
          disabled={messageCount === 0}
          onClick={() => {
            if (messageCount > 0) setIsConfirmingClear(true);
          }}
          title={messageCount > 0 ? 'Reset messages in this chat' : 'Chat is already empty'}
          aria-label="Reset chat"
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono rounded-md border border-zinc-200 dark:border-zinc-800 bg-stone-50 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 disabled:opacity-40 disabled:pointer-events-none transition-colors cursor-pointer whitespace-nowrap shadow-xs"
        >
          <RotateCcw className="w-3.5 h-3.5 text-accent shrink-0" />
          <span className="hidden sm:inline font-sans">Reset</span>
        </button>

        <ConfirmDeleteModal
          isOpen={isConfirmingClear}
          onClose={() => setIsConfirmingClear(false)}
          onConfirm={() => {
            setIsConfirmingClear(false);
            onClearSessionMessages();
          }}
          title="Clear chat?"
          description="Are you sure you want to clear all messages in this conversation? This action cannot be undone."
          confirmLabel="Confirm"
          testId="clear-chat-confirmation"
          confirmTestId="confirm-clear-chat-btn"
          data-testid="clear-chat-confirmation"
          data-confirm-testid="confirm-clear-chat-btn"
        />
        {/* data-testid="confirm-clear-chat-btn" */}
      </div>
    </header>
  );
};
