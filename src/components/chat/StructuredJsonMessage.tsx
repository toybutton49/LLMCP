import React, { useState } from 'react';
import {
  Check,
  Copy,
  RefreshCw,
  BookmarkPlus,
  GitBranch,
  Trash2,
  Brain,
  Wrench,
  FolderArchive,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Pencil,
  Send,
  X,
  Volume2,
  Square,
  Loader2
} from 'lucide-react';
import type { TtsChunkProgress, TtsPlaybackStatus } from '../../hooks/useTtsPlayer';
import { WorkspaceMessage } from '../../data/seedData';
import { MarkdownContent } from './MarkdownContent';
import { SourceVerificationDrawer } from './SourceVerificationDrawer';
import { orchestrator } from '../../orchestrators';

interface StructuredJsonMessageProps {
  message: WorkspaceMessage;
  isStreaming?: boolean;
  thinkingEnabled?: boolean;
  onCopy: (id: string, text: string) => void;
  copiedId: string | null;
  onRegenerate?: () => void;
  onEditMessage?: (
    msgId: string,
    newContent: string,
    role: 'user' | 'assistant',
    resubmit?: boolean
  ) => void;
  onSaveMemory?: (msg: WorkspaceMessage) => void;
  onFork?: (msgId: string) => void;
  onDelete?: (msg: WorkspaceMessage) => void;
  onVerifyWithWeb?: (claimOrPrompt: string) => void;
  ttsStatus?: TtsPlaybackStatus;
  ttsErrorMessage?: string | null;
  ttsChunkProgress?: TtsChunkProgress | null;
  onToggleSpeak?: (msgId: string, content: string) => void;
  onDismissTtsError?: () => void;
}

const StructuredJsonMessageInner: React.FC<StructuredJsonMessageProps> = ({
  message,
  isStreaming = false,
  thinkingEnabled = true,
  onCopy,
  copiedId,
  onRegenerate,
  onEditMessage,
  onSaveMemory,
  onFork,
  onDelete,
  onVerifyWithWeb,
  ttsStatus = 'idle',
  ttsErrorMessage = null,
  ttsChunkProgress = null,
  onToggleSpeak,
  onDismissTtsError
}) => {
  const isUser = message.role === 'user';
  const [thinkingExpanded, setThinkingExpanded] = useState(isStreaming);
  const [isEditing, setIsEditing] = useState(false);

  // Programmatic structure guarantees backend, streaming, and chat state never break.
  // Content is never parsed as JSON in the chat UI.
  const promptEnvelope = isUser
    ? orchestrator.chatOrchestrator.buildProgrammaticPromptEnvelope({
        sessionId: message.sessionId || '',
        modelId: message.modelId || '',
        prompt: message.content || '',
        timestamp: message.createdAt || message.timestamp
      })
    : null;

  const responseEnvelope = !isUser
    ? orchestrator.chatOrchestrator.buildProgrammaticResponseEnvelope({
        sessionId: message.sessionId || '',
        modelId: message.modelId || '',
        rawContent: message.content || '',
        existingReasoning: message.reasoningContent,
        isStreaming,
        toolInvocations: message.toolInvocations,
        vaultCitations: message.vaultCitations,
        ragCitations: message.ragCitations,
        tokenCount: message.tokenCount,
        latencyMs: message.latencyMs,
        generationMs: message.generationMs,
        timestamp: message.createdAt || message.timestamp
      })
    : null;

  const cleanContent = isUser
    ? promptEnvelope?.prompt || ''
    : responseEnvelope?.response || '';
  const reasoningContent = responseEnvelope?.reasoning || undefined;
  const [editDraft, setEditDraft] = useState(cleanContent);

  const handleStartEdit = () => {
    setEditDraft(cleanContent);
    setIsEditing(true);
  };

  const handleCommitEdit = (resubmit: boolean) => {
    const trimmed = editDraft.trim();
    if (!trimmed) return;
    setIsEditing(false);
    onEditMessage?.(
      message.id,
      trimmed,
      isUser ? 'user' : 'assistant',
      resubmit
    );
  };

  const tokPerSec =
    responseEnvelope && responseEnvelope.metrics.tokPerSec > 0
      ? responseEnvelope.metrics.tokPerSec.toFixed(1)
      : null;

  const hasTools = Boolean(message.toolInvocations && message.toolInvocations.length > 0);
  const hasCitations = Boolean(
    (message.vaultCitations && message.vaultCitations.length > 0) ||
      (message.ragCitations && message.ragCitations.length > 0)
  );

  return (
    <div
      data-testid={isUser ? 'structured-user-message' : 'structured-assistant-message'}
      data-schema-version="1.0"
      className={`group rounded-lg border transition-colors overflow-hidden ${
        isUser
          ? 'bg-zinc-900 border-zinc-800 text-stone-100 ml-auto max-w-4xl'
          : 'bg-white dark:bg-zinc-900/90 border-stone-200 dark:border-zinc-800 text-zinc-900 dark:text-stone-100 max-w-4xl'
      }`}
    >
      {/* Message Header Bar */}
      <div
        className={`flex items-center justify-between gap-2 px-4 py-2 border-b text-xs tabular-nums ${
          isUser
            ? 'bg-zinc-950/70 border-zinc-800/80 text-zinc-400'
            : 'bg-stone-50 dark:bg-zinc-950/70 border-stone-200 dark:border-zinc-800/90 text-zinc-500 dark:text-zinc-400'
        }`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={`px-2 py-0.5 rounded text-[11px] font-semibold tracking-wide ${
              isUser
                ? 'bg-accent text-zinc-950'
                : 'bg-zinc-200/80 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200'
            }`}
          >
            {isUser ? 'You' : 'Octopus'}
          </span>
          <span className="truncate text-zinc-500 dark:text-zinc-400">
            {isUser ? 'Prompt' : message.modelId || 'Built-in server'}
          </span>
          {!isUser && (
            <span className="text-xs text-zinc-500 hidden sm:inline tabular-nums">
              · {(responseEnvelope?.metrics.tokens || 0).toLocaleString()} tok
              {message.latencyMs ? ` · ${message.latencyMs.toLocaleString()} ms` : ''}
              {tokPerSec ? ` · ${tokPerSec} tok/s` : ''}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {onEditMessage && !isStreaming && !isEditing && (
            <button
              type="button"
              onClick={handleStartEdit}
              className="p-1 rounded text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
              title={isUser ? 'Edit prompt & resend' : 'Edit assistant response'}
              data-testid="edit-message-btn"
            >
              <Pencil className="w-3 h-3" />
            </button>
          )}

          {!isUser && !isStreaming && cleanContent.trim().length > 0 && onToggleSpeak && (
            <div className="flex items-center gap-1 shrink-0">
              {(ttsStatus === 'loading' || ttsStatus === 'playing') && ttsChunkProgress && (
                <span
                  data-testid="tts-progress-label"
                  className="text-[11px] font-mono text-accent px-1.5 whitespace-nowrap tabular-nums"
                >
                  {ttsStatus === 'loading'
                    ? 'Synthesizing...'
                    : ttsChunkProgress.total > 1
                    ? `Speaking ${ttsChunkProgress.current}/${ttsChunkProgress.total}`
                    : 'Speaking'}
                </span>
              )}
              <button
                type="button"
                onClick={() => onToggleSpeak(message.id, cleanContent)}
                data-testid="tts-speak-btn"
                aria-label={
                  ttsStatus === 'loading' || ttsStatus === 'playing'
                    ? 'Stop reading response'
                    : 'Read response aloud'
                }
                title={
                  ttsStatus === 'loading'
                    ? 'Generating speech...'
                    : ttsStatus === 'playing'
                    ? 'Stop reading aloud'
                    : 'Read response aloud'
                }
                className={`p-1 rounded hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer ${
                  ttsStatus === 'loading' || ttsStatus === 'playing'
                    ? 'text-accent'
                    : 'text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                }`}
              >
                {ttsStatus === 'loading' ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : ttsStatus === 'playing' ? (
                  <Square className="w-3 h-3" />
                ) : (
                  <Volume2 className="w-3 h-3" />
                )}
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => onCopy(message.id, cleanContent)}
            className="p-1 rounded text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
            title="Copy message content"
          >
            {copiedId === message.id ? (
              <Check className="w-3 h-3 text-emerald-400" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>

          {!isUser && onRegenerate && !isStreaming && (
            <button
              type="button"
              onClick={onRegenerate}
              className="p-1 rounded text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
              title="Regenerate response"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          )}

          {!isUser && onSaveMemory && !isStreaming && (
            <button
              type="button"
              onClick={() => onSaveMemory(message)}
              className="p-1 rounded text-zinc-400 hover:text-accent hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
              title="Save this response to Memory"
            >
              <BookmarkPlus className="w-3 h-3" />
            </button>
          )}

          {onFork && !isStreaming && (
            <button
              type="button"
              onClick={() => onFork(message.id)}
              className="p-1 rounded text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
              title="Branch conversation from here"
            >
              <GitBranch className="w-3 h-3" />
            </button>
          )}

          {onDelete && !isStreaming && (
            <button
              type="button"
              onClick={() => onDelete(message)}
              className="p-1 rounded text-zinc-400 hover:text-rose-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
              title="Delete message"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {!isUser && ttsStatus === 'error' && ttsErrorMessage && (
        <div
          role="alert"
          data-testid="tts-error-banner"
          className="px-4 py-2 border-b border-rose-500/30 bg-rose-500/10 text-xs text-rose-300 flex items-center justify-between gap-2"
        >
          <span>{ttsErrorMessage}</span>
          {onDismissTtsError && (
            <button
              type="button"
              onClick={onDismissTtsError}
              aria-label="Dismiss speech error"
              className="p-0.5 rounded text-rose-300 hover:text-rose-100 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Collapsible Reasoning / Thinking Trace */}
      {!isUser && (reasoningContent || (thinkingEnabled !== false && isStreaming && !cleanContent)) && (
        <div className="border-b border-zinc-200 dark:border-zinc-800/80 bg-zinc-50/70 dark:bg-zinc-950/60 px-3.5 py-2">
          <button
            type="button"
            onClick={() => setThinkingExpanded((prev) => !prev)}
            className="flex items-center justify-between w-full text-left text-[11px] font-mono text-accent cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              <Brain className={`w-3.5 h-3.5 ${isStreaming ? 'animate-pulse' : ''}`} />
              <span>
                {isStreaming && !cleanContent
                  ? 'Octopus reasoning (streaming...)'
                  : 'Octopus reasoning'}
              </span>
            </span>
            {thinkingExpanded ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>
          {thinkingExpanded && reasoningContent && (
            <pre className="mt-2 p-2.5 rounded-lg bg-zinc-100 dark:bg-zinc-900/90 border border-zinc-200 dark:border-zinc-800 text-[11px] font-mono text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed">
              {reasoningContent}
            </pre>
          )}
        </div>
      )}

      {/* Executed Tool Call Badges & Citations */}
      {!isUser && (hasTools || hasCitations) && (
        <div className="px-3.5 py-2 border-b border-zinc-200 dark:border-zinc-800/80 bg-zinc-50/40 dark:bg-zinc-950/40 flex flex-wrap items-center gap-1.5">
          {message.toolInvocations?.map((t, i) => (
            <span
              key={`tool_${i}`}
              title={`${t.inputSummary} -> ${t.outputSummary}`}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
            >
              <Wrench className="w-2.5 h-2.5" />
              <span>{t.pluginName}</span>
              <span className="opacity-70">({t.durationMs}ms)</span>
            </span>
          ))}
          {message.vaultCitations?.map((vc, i) => (
            <span
              key={`vc_${i}`}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20"
            >
              <FolderArchive className="w-2.5 h-2.5" />
              <span>{vc.fileName}</span>
            </span>
          ))}
          {message.ragCitations?.map((rc, i) => (
            <span
              key={`rc_${i}`}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded bg-accent-subtle text-accent border border-accent"
            >
              <BookOpen className="w-2.5 h-2.5" />
              <span>{rc.docTitle}</span>
            </span>
          ))}
        </div>
      )}

      {/* Main Message Body: Inline Editor or Human-Readable Markdown */}
      <div className="p-4 sm:p-5">
        {isEditing ? (
          <div className="space-y-2.5" data-testid="inline-message-editor">
            <textarea
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              rows={Math.min(10, Math.max(3, editDraft.split('\n').length + 1))}
              className="w-full p-2.5 rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-accent text-xs font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none leading-relaxed"
              aria-label="Edit message content"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-mono text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200 border border-zinc-300 dark:border-zinc-800 cursor-pointer"
              >
                <X className="w-3 h-3" />
                <span>Cancel</span>
              </button>
              {isUser ? (
                <>
                  <button
                    type="button"
                    onClick={() => handleCommitEdit(false)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-mono text-zinc-700 dark:text-zinc-300 bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 cursor-pointer"
                  >
                    <Check className="w-3 h-3" />
                    <span>Save Only</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCommitEdit(true)}
                    data-testid="save-and-resend-btn"
                    className="inline-flex items-center gap-1 px-3 py-1 rounded text-xs font-mono font-semibold bg-accent text-zinc-950 cursor-pointer"
                  >
                    <Send className="w-3 h-3" />
                    <span>Save &amp; Resend</span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => handleCommitEdit(false)}
                  data-testid="save-assistant-edit-btn"
                  className="inline-flex items-center gap-1 px-3 py-1 rounded text-xs font-mono font-semibold bg-accent text-zinc-950 cursor-pointer"
                >
                  <Check className="w-3 h-3" />
                  <span>Save Response</span>
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="text-sm leading-relaxed">
            <MarkdownContent
              content={
                cleanContent || (isStreaming ? 'Generating response...' : '')
              }
            />
            {!isUser && !isStreaming && (
              <SourceVerificationDrawer
                message={message}
                onVerifyWithWeb={onVerifyWithWeb}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export const StructuredJsonMessage = React.memo(StructuredJsonMessageInner);
