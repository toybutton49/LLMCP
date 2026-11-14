import React, { useEffect, useRef, useState } from 'react';
import {
  Send,
  Square,
  FolderArchive,
  Brain,
  Globe,
  Upload,
  Gauge
} from 'lucide-react';
import { WorkspaceSession } from '../../data/seedData';
import { HARDWARE_DEFAULTS, TELEMETRY_DEFAULTS } from '../../data/runtimeDefaults';
import {
  VaultFileEntry,
  PluginDefinition,
  ReasoningEffortLevel,
  estimateTokenCount
} from '../../utils/rag';
import { uploadAttachment } from '../../utils/attachmentUpload';
import { formatAppError } from '../../utils/appErrors';
import { ChatToolsMenu } from './ChatToolsMenu';

interface ChatComposerProps {
  session: WorkspaceSession;
  inputPrompt: string;
  onChangePrompt: (val: string) => void;
  onSubmitPrompt: (e: React.FormEvent) => void;
  isStreaming: boolean;
  busyInOtherChat?: boolean;
  isPreparing?: boolean;
  onStopStreaming?: () => void;
  onUpdateSession: (updates: Partial<WorkspaceSession>) => void;
  onAddVaultFiles?: (files: VaultFileEntry[]) => void;
  ragLabel?: string;
  allPlugins: PluginDefinition[];
  sessionUsedTokens?: number;
  contextTrimmed?: boolean;
  maxContextTokens?: number;
}

const chipClass = (active: boolean) => `inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
  active
    ? 'bg-accent text-zinc-950 border-accent font-semibold'
    : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-800'
}`;

export const ChatComposer: React.FC<ChatComposerProps> = ({
  session,
  inputPrompt,
  onChangePrompt,
  onSubmitPrompt,
  isStreaming,
  busyInOtherChat = false,
  isPreparing = false,
  onStopStreaming,
  onUpdateSession,
  onAddVaultFiles,
  ragLabel = 'File Repo',
  allPlugins,
  sessionUsedTokens = 0,
  contextTrimmed = false,
  maxContextTokens = HARDWARE_DEFAULTS.contextSize
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const thinkingEnabled = session.thinkingEnabled ?? true;
  const reasoningEffort: ReasoningEffortLevel = session.reasoningEffort ?? 'medium';
  const fileRepoOn = Boolean(session.ragEnabled || session.vaultEnabled);
  const memoryOn = Boolean(session.memoryEnabled);
  const webSearchOn = session.webSearchEnabled !== false;

  const draftTokens = inputPrompt.trim() ? estimateTokenCount(inputPrompt) : 0;
  const combinedContextTokens = sessionUsedTokens + draftTokens;
  const safeMaxContext = Math.max(HARDWARE_DEFAULTS.minContextSize, maxContextTokens);
  const contextUsedPct = Math.min(100, Math.round((combinedContextTokens / safeMaxContext) * 1000) / 10);
  const isHighContextPressure =
    (combinedContextTokens / safeMaxContext) * 100 >= TELEMETRY_DEFAULTS.contextPressureThresholdPercent;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(220, Math.max(72, el.scrollHeight))}px`;
  }, [inputPrompt]);

  const uploadFilesBatch = async (files: File[]) => {
    if (!files.length || !onAddVaultFiles) return;
    setUploading(true);
    setUploadError('');
    try {
      const results = await Promise.allSettled(files.map((file) => uploadAttachment(file, 'Chat Drop')));
      const created = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      const errors = results.flatMap((result, index) => result.status === 'rejected'
        ? [`${files[index].name}: ${formatAppError(result.reason)}`] : []);
      if (created.length) {
        onAddVaultFiles(created);
        onUpdateSession({ ragEnabled: true, vaultEnabled: true });
      }
      setUploadError(errors.join(' '));
    } catch (error) {
      setUploadError(formatAppError(error));
    } finally {
      setUploading(false);
    }
  };

  const handleQuickFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    e.target.value = '';
    await uploadFilesBatch(files);
  };

  return (
    <div className="px-4 sm:px-6 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shrink-0">
      <form onSubmit={(event) => {
        if (uploading || isPreparing) { event.preventDefault(); return; }
        onSubmitPrompt(event);
      }} className="max-w-4xl mx-auto">
        {uploadError && <p role="alert" className="mb-2 text-xs text-rose-600 dark:text-rose-400">{uploadError}</p>}
        {uploading && <p role="status" className="mb-2 text-xs">Reading attachments...</p>}
        <div
          data-testid="structured-json-composer"
          data-schema-version="1.0"
          onDragOver={(e) => {
            if (!onAddVaultFiles) return;
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => {
            setIsDragOver(false);
            if (!onAddVaultFiles) return;
            const dropped = Array.from(e.dataTransfer.files || []);
            if (dropped.length > 0) {
              e.preventDefault();
              void uploadFilesBatch(dropped);
            }
          }}
          className={`rounded-lg border bg-white dark:bg-zinc-900 focus-within:border-accent transition-colors ${
            isDragOver ? 'border-accent ring-1 ring-accent/30' : 'border-zinc-300 dark:border-zinc-800'
          }`}
        >
          {/* Prompt Textarea */}
          <div className="px-4 pt-3.5 pb-2">
            <textarea
              ref={textareaRef}
              rows={3}
              value={inputPrompt}
              onChange={(e) => onChangePrompt(e.target.value)}
              onPaste={(e) => {
                if (!onAddVaultFiles) return;
                const pastedFiles = Array.from(e.clipboardData?.files || []);
                if (pastedFiles.length > 0) {
                  e.preventDefault();
                  void uploadFilesBatch(pastedFiles);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (inputPrompt.trim() && !uploading && !isPreparing && !busyInOtherChat && !isStreaming) {
                    onSubmitPrompt(e);
                  }
                }
              }}
              placeholder={isDragOver ? `Drop files to add to ${ragLabel}...` : 'Message Octopus... (Shift+Enter for newline, paste or drop files to attach)'}
              aria-label="Prompt input"
              className="w-full px-1 py-1 text-sm bg-transparent text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none resize-none leading-relaxed max-h-56 overflow-y-auto"
            />
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleQuickFileSelect}
            className="hidden"
          />

          {/* Bottom Controls Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 border-t border-zinc-200/80 dark:border-zinc-800/80 bg-zinc-50 dark:bg-zinc-950/60 rounded-b-lg">
            <div className="flex flex-wrap items-center gap-1.5">
              {/* File Repo context: one toggle that states its state, plus a direct upload */}
              <div className="inline-flex items-center rounded-md overflow-hidden">
                <button
                  type="button"
                  aria-pressed={fileRepoOn}
                  onClick={() => onUpdateSession({ ragEnabled: !fileRepoOn, vaultEnabled: !fileRepoOn })}
                  title={`${ragLabel} context is ${fileRepoOn ? 'on' : 'off'} for this chat. Click to turn it ${fileRepoOn ? 'off' : 'on'}.`}
                  className={`${chipClass(fileRepoOn)} rounded-r-none`}
                >
                  <FolderArchive className="w-3 h-3" />
                  <span>{ragLabel}</span>
                  <span className="font-mono opacity-80">{fileRepoOn ? 'On' : 'Off'}</span>
                </button>
                {onAddVaultFiles && (
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                    title={`Upload files into ${ragLabel} (saved to the Chat Drop collection)`}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-r-md border border-l-0 border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:text-accent disabled:opacity-50 cursor-pointer"
                  >
                    <Upload className="w-3 h-3" />
                    <span>Upload</span>
                  </button>
                )}
              </div>

              {/* Memory toggle */}
              <button
                type="button"
                aria-pressed={memoryOn}
                onClick={() => onUpdateSession({ memoryEnabled: !memoryOn })}
                title={`Saved memories are ${memoryOn ? 'included' : 'excluded'} for this chat`}
                className={chipClass(memoryOn)}
              >
                <Brain className="w-3 h-3" />
                <span>Memory</span>
                <span className="font-mono opacity-80">{memoryOn ? 'On' : 'Off'}</span>
              </button>

              {/* 3. Session reasoning control */}
              <div
                className="inline-flex items-center rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-800/90 px-1.5 py-0.5 gap-1"
                title="Reasoning effort for this session"
              >
                <span className="text-[10px] font-mono text-zinc-500 dark:text-zinc-400 pl-0.5">
                  Reason:
                </span>
                <select
                  aria-label="Reasoning effort level"
                  value={thinkingEnabled ? reasoningEffort : 'off'}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === 'off') {
                      onUpdateSession({ thinkingEnabled: false });
                    } else {
                      onUpdateSession({
                        thinkingEnabled: true,
                        reasoningEffort: val as ReasoningEffortLevel
                      });
                    }
                  }}
                  className="text-[11px] font-mono bg-transparent text-accent font-semibold focus:outline-none cursor-pointer pr-1"
                >
                  <option value="low" className="bg-zinc-900 text-zinc-100">
                    Low
                  </option>
                  <option value="medium" className="bg-zinc-900 text-zinc-100">
                    Med
                  </option>
                  <option value="high" className="bg-zinc-900 text-zinc-100">
                    High
                  </option>
                  <option value="off" className="bg-zinc-900 text-zinc-400">
                    Off
                  </option>
                </select>
              </div>

              <ChatToolsMenu
                allPlugins={allPlugins}
                enabledPluginIds={session.enabledPluginIds ?? []}
                webSearchEnabled={webSearchOn}
                onToggleWebSearch={() => onUpdateSession({ webSearchEnabled: !webSearchOn })}
                onChangePluginIds={(pluginIds) => onUpdateSession({ enabledPluginIds: pluginIds })}
              />

              <button
                type="button"
                aria-pressed={webSearchOn}
                onClick={() => onUpdateSession({ webSearchEnabled: !webSearchOn })}
                title={webSearchOn ? 'Live web search is enabled for this chat (click to disable)' : 'Live web search is disabled for this chat (click to enable)'}
                className={chipClass(webSearchOn)}
              >
                <Globe className="w-3 h-3" />
                <span>Web Search</span>
                <span className="font-mono opacity-80">{webSearchOn ? 'On' : 'Off'}</span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              <div
                role="status"
                aria-label="Active context usage"
                data-testid="composer-context-meter"
                title={
                  isHighContextPressure
                    ? `Context pressure >= ${TELEMETRY_DEFAULTS.contextPressureThresholdPercent}% (${combinedContextTokens.toLocaleString()} / ${safeMaxContext.toLocaleString()} tokens). Older turns will compact and index via Nomic.`
                    : contextTrimmed
                    ? `Context compacted: oldest turns were trimmed from the active window and indexed to the vector DB via Nomic. Active context: ${combinedContextTokens.toLocaleString()} / ${safeMaxContext.toLocaleString()} tokens (${contextUsedPct}%).`
                    : `Estimated active context: ${combinedContextTokens.toLocaleString()} / ${safeMaxContext.toLocaleString()} tokens (${contextUsedPct}%).`
                }
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs tabular-nums border select-none ${
                  isHighContextPressure
                    ? 'bg-rose-500/15 text-rose-400 border-rose-500/40 font-semibold'
                    : contextTrimmed
                    ? 'bg-accent-subtle text-accent border-accent font-medium'
                    : 'bg-zinc-100 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-800'
                }`}
              >
                <Gauge className="w-3 h-3 shrink-0" />
                <span>
                  {combinedContextTokens.toLocaleString()} / {safeMaxContext.toLocaleString()} ({contextUsedPct}%)
                </span>
              </div>
              {isStreaming && onStopStreaming ? (
                <button
                  type="button"
                  onClick={onStopStreaming}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-rose-600 hover:bg-rose-500 text-white transition-colors shadow-xs cursor-pointer"
                >
                  <Square className="w-3 h-3 fill-current" />
                  <span>Stop</span>
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!inputPrompt.trim() || uploading || isPreparing || busyInOtherChat}
                  aria-label="Send prompt"
                  title={busyInOtherChat ? 'Another chat is responding. Wait for it to finish or press Stop there.' : undefined}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-accent text-zinc-950 disabled:opacity-40 disabled:pointer-events-none transition-all shadow-xs cursor-pointer"
                >
                  <span>{busyInOtherChat ? 'Busy elsewhere' : 'Send'}</span>
                  <Send className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
      </form>
    </div>
  );
};
