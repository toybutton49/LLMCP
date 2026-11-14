import React from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { LlmcpLogo } from '../layout/LlmcpLogo';

interface QuickStartModalProps {
  isOpen: boolean;
  onClose: () => void;
  ragLabel: string;
}

export const QuickStartModal: React.FC<QuickStartModalProps> = ({
  isOpen,
  onClose,
  ragLabel
}) => {
  React.useEffect(() => {
    if (!isOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="quickstart-modal-title"
      className="absolute inset-0 z-40 bg-zinc-950/80 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="w-full max-w-2xl rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 bg-stone-50 dark:bg-zinc-950">
          <div className="flex items-center gap-3">
            <LlmcpLogo variant="mark" size="md" />
            <div>
              <h2 id="quickstart-modal-title" className="text-base font-bold">
                Quick Start Guide
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Offline inference with zero cloud telemetry.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Quick Start Guide"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-stone-50/70 dark:bg-zinc-950/60 space-y-2">
              <span className="inline-block px-2 py-0.5 rounded bg-accent-subtle text-accent text-[11px] font-bold">
                Step 1: Chat model
              </span>
              <h3 className="text-xs font-bold text-zinc-900 dark:text-white">
                Place .GGUF in ./models
              </h3>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                Drop quantized <code className="text-accent font-mono">.gguf</code> chat models into <code className="text-accent font-mono">./models</code>; they are auto-discovered and selectable in <strong>Settings &gt; Model</strong>.
              </p>
            </div>

            <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-stone-50/70 dark:bg-zinc-950/60 space-y-2">
              <span className="inline-block px-2 py-0.5 rounded bg-accent-subtle text-accent text-[11px] font-bold">
                Step 2: Embedding and OCR models
              </span>
              <h3 className="text-xs font-bold text-zinc-900 dark:text-white">
                Discovered CPU auxiliary models
              </h3>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                A selected Nomic embedding model vectorizes memories, files, prompts and responses on demand. A discovered GLM-OCR model and matching projector transcribe PDFs and images into text. Select or inspect discovered models in <strong>Settings &gt; Knowledge</strong> (run <code className="text-accent font-mono">git lfs pull</code> if restoring Git LFS weights).
              </p>
            </div>

            <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-stone-50/70 dark:bg-zinc-950/60 space-y-2">
              <span className="inline-block px-2 py-0.5 rounded bg-accent-subtle text-accent text-[11px] font-bold">
                Step 3: Link {ragLabel}
              </span>
              <h3 className="text-xs font-bold text-zinc-900 dark:text-white">
                Sync Files in {ragLabel}
              </h3>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                Open <strong>{ragLabel}</strong> to link a local folder or upload files so Octopus can read and cite them. Stored data is added to a prompt only when its similarity score is high enough.
              </p>
            </div>

            <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-stone-50/70 dark:bg-zinc-950/60 space-y-2">
              <span className="inline-block px-2 py-0.5 rounded bg-accent-subtle text-accent text-[11px] font-bold">
                Step 4: Callable Tools
              </span>
              <h3 className="text-xs font-bold text-zinc-900 dark:text-white">
                AI Decides Tool Usage
              </h3>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                Built-in <strong>Web Search</strong> starts enabled by default and can be toggled off per chat. Open <strong>Tools</strong> beside the prompt to toggle optional tools; Octopus decides when to call enabled tools.
              </p>
            </div>
          </div>

          <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-stone-50 dark:bg-zinc-950 space-y-2">
            <div className="text-xs font-bold text-zinc-900 dark:text-white">
              Productivity Shortcuts &amp; Architecture
            </div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                <span>
                  <strong>Ctrl+B / Ctrl+K / Ctrl+,</strong>: Toggle sidebar, search chats, or open Settings
                </span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                <span>
                  <strong>Alt+N &amp; Drag/Paste</strong>: Start a new chat or drop/paste files into the prompt
                </span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                <span>
                  <strong>Context Pressure (&gt;= 90%)</strong>: Compacts prompt budget and indexes older turns via Nomic
                </span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                <span>
                  <strong>Offline inference</strong>: Chat, OCR and embedding run on this computer; only web tools contact external URLs
                </span>
              </li>
            </ul>
          </div>
        </div>

        <div className="flex items-center justify-between px-6 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-stone-50 dark:bg-zinc-950">
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Zero cloud telemetry. Chats, files, memory and settings are stored in your local database.
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-accent text-xs font-medium cursor-pointer"
          >
            Got It
          </button>
        </div>
      </div>
    </div>
  );
};
