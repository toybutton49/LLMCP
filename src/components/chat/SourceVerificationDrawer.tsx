import React, { useState } from 'react';
import {
  Globe,
  FolderArchive,
  BookOpen,
  Cpu,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Copy,
  Check,
  Search
} from 'lucide-react';
import { WorkspaceMessage } from '../../data/seedData';
import {
  analyzeMessageFactGrounding,
  ParsedSourceItem
} from '../../utils/sourceVerification';

interface SourceVerificationDrawerProps {
  message: WorkspaceMessage;
  onVerifyWithWeb?: (claimOrPrompt: string) => void;
}

export const SourceVerificationDrawer: React.FC<SourceVerificationDrawerProps> = ({
  message,
  onVerifyWithWeb
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [copiedSourceId, setCopiedSourceId] = useState<string | null>(null);

  const analysis = analyzeMessageFactGrounding(message);

  const handleCopyExcerpt = (item: ParsedSourceItem) => {
    const text = item.url ? `[${item.title}](${item.url})\n${item.excerpt}` : `[${item.title}]\n${item.excerpt}`;
    navigator.clipboard?.writeText(text);
    setCopiedSourceId(item.id);
    setTimeout(() => setCopiedSourceId(null), 1800);
  };

  const getBadgeStyle = () => {
    switch (analysis.badgeVariant) {
      case 'emerald':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
      case 'sky':
        return 'bg-sky-500/10 text-sky-400 border-sky-500/30';
      case 'indigo':
        return 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30';
      case 'purple':
        return 'bg-purple-500/10 text-purple-400 border-purple-500/30';
      default:
        return 'bg-zinc-800 text-zinc-400 border-zinc-700';
    }
  };

  const getSourceIcon = (kind: ParsedSourceItem['sourceKind']) => {
    switch (kind) {
      case 'web':
      case 'reference':
        return <Globe className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
      case 'vault':
        return <FolderArchive className="w-3.5 h-3.5 text-sky-400 shrink-0" />;
      case 'rag':
        return <BookOpen className="w-3.5 h-3.5 text-indigo-400 shrink-0" />;
      case 'system':
        return <Cpu className="w-3.5 h-3.5 text-purple-400 shrink-0" />;
    }
  };

  return (
    <div className="mt-3 pt-2.5 border-t border-zinc-100 dark:border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        {/* Grounding Status Pill */}
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border ${getBadgeStyle()}`}
          >
            <span>{analysis.levelLabel}</span>
          </span>

          {analysis.citationCount > 0 && (
            <span className="text-xs text-zinc-400 tabular-nums">
              {analysis.citationCount} source{analysis.citationCount === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5">
          {onVerifyWithWeb && (
            <button
              type="button"
              onClick={() => onVerifyWithWeb(message.content)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 transition-colors cursor-pointer"
              title="Search the web for this response"
            >
              <Search className="w-3 h-3 text-accent shrink-0" />
              <span>Verify with Web</span>
            </button>
          )}

          {analysis.sources.length > 0 && (
            <button
              type="button"
              onClick={() => setIsOpen((prev) => !prev)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-accent hover:bg-accent-subtle transition-colors cursor-pointer"
            >
              <span>{isOpen ? 'Hide Sources' : 'Inspect Sources'}</span>
              {isOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
        </div>
      </div>

      {/* Expanded Proof Details */}
      {isOpen && analysis.sources.length > 0 && (
        <div className="mt-2.5 p-3 rounded-xl bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800 space-y-2.5 text-xs">
          <div className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-normal">
            {analysis.levelDescription}
          </div>

          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {analysis.sources.map((item) => (
              <div
                key={item.id}
                className="p-2.5 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 space-y-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {getSourceIcon(item.sourceKind)}
                    <span className="font-semibold text-zinc-800 dark:text-zinc-200 truncate">
                      {item.title}
                    </span>
                    {item.domain && (
                      <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
                        {item.domain}
                      </span>
                    )}
                    {item.lineRange && (
                      <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-sky-500/10 text-sky-400 border border-sky-500/20">
                        {item.lineRange}
                      </span>
                    )}
                    {item.sha256Preview && (
                      <span
                        className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-zinc-800 text-zinc-400"
                        title="SHA-256 Document Fingerprint"
                      >
                        sha256:{item.sha256Preview.slice(0, 8)}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {item.url && (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="p-1 rounded text-zinc-400 hover:text-accent hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                        title="Open external source URL in new tab"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => handleCopyExcerpt(item)}
                      className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                      title="Copy citation excerpt"
                    >
                      {copiedSourceId === item.id ? (
                        <Check className="w-3 h-3 text-emerald-400" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="text-[11px] text-zinc-600 dark:text-zinc-300 font-mono leading-relaxed bg-zinc-50 dark:bg-zinc-950 p-2 rounded border border-zinc-100 dark:border-zinc-800 whitespace-pre-wrap max-h-28 overflow-y-auto">
                  {item.excerpt}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
