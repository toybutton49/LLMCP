import React, { useMemo } from 'react';
import {
  Wrench,
  Globe,
  HardDrive,
  Cpu,
  Calculator,
  ShieldCheck,
  Brain,
  Activity,
  X
} from 'lucide-react';
import { PluginDefinition } from '../../utils/rag';

interface ToolToggleListProps {
  allPlugins: PluginDefinition[];
  enabledPluginIds: string[];
  webSearchEnabled?: boolean;
  onToggleWebSearch?: () => void;
  onTogglePlugin: (pluginId: string) => void;
  onEnableAll?: () => void;
  onDisableAll?: () => void;
  compact?: boolean;
  popupMode?: boolean;
  className?: string;
  onClose?: () => void;
}

export const ToolToggleList: React.FC<ToolToggleListProps> = ({
  allPlugins,
  enabledPluginIds,
  webSearchEnabled = true,
  onToggleWebSearch,
  onTogglePlugin,
  onEnableAll,
  onDisableAll,
  compact = false,
  popupMode = false,
  className = '',
  onClose
}) => {
  // Web search is built-in and always active; optional tools are toggled here
  const optionalPlugins = useMemo(() => {
    return allPlugins.filter(
      (p) => p.id !== 'web_search' && p.id !== 'live_search'
    );
  }, [allPlugins]);

  const activeCount = enabledPluginIds.filter((id) =>
    optionalPlugins.some((p) => p.id === id)
  ).length;

  const getCategoryIcon = (category: string) => {
    switch (category.toLowerCase()) {
      case 'file repo':
      case 'file & code':
        return <HardDrive className="w-3.5 h-3.5 text-accent shrink-0" />;
      case 'agentic coding':
      case 'system':
        return <Cpu className="w-3.5 h-3.5 text-sky-500 shrink-0" />;
      case 'web & research':
        return <Globe className="w-3.5 h-3.5 text-emerald-500 shrink-0" />;
      case 'computation':
        return <Calculator className="w-3.5 h-3.5 text-indigo-500 shrink-0" />;
      case 'security':
        return <ShieldCheck className="w-3.5 h-3.5 text-rose-500 shrink-0" />;
      case 'memory':
        return <Brain className="w-3.5 h-3.5 text-violet-500 shrink-0" />;
      case 'diagnostics':
        return <Activity className="w-3.5 h-3.5 text-accent shrink-0" />;
      default:
        return <Wrench className="w-3.5 h-3.5 text-zinc-400 shrink-0" />;
    }
  };

  return (
    <div
      role={popupMode ? 'dialog' : undefined}
      aria-label={popupMode ? 'Optional tools and built-in web search' : undefined}
      data-testid={popupMode ? 'tools-popup-window' : 'tools-toggle-list'}
      className={`rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xl ${className}`}
    >
      {/* Header Bar */}
      <div className="px-3.5 py-2.5 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Wrench className="w-3.5 h-3.5 text-accent shrink-0" />
          <span className="text-xs font-semibold tracking-tight text-zinc-900 dark:text-zinc-100 truncate">
            Tools
          </span>
          <span className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400 shrink-0">
            · {activeCount}/{optionalPlugins.length} Active
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {onEnableAll && (
            <button
              type="button"
              onClick={onEnableAll}
              className="text-[11px] font-medium text-accent hover:underline cursor-pointer"
            >
              All On
            </button>
          )}
          {onDisableAll && (
            <button
              type="button"
              onClick={onDisableAll}
              className="text-[11px] font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 cursor-pointer"
            >
              All Off
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close tools popup"
              className="p-1 rounded-md text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Built-in Web Search Toggle Banner */}
      <div
        onClick={onToggleWebSearch}
        className={`px-3 py-2.5 border-b flex items-center justify-between gap-2.5 text-xs transition-colors ${
          onToggleWebSearch ? 'cursor-pointer select-none' : ''
        } ${
          webSearchEnabled
            ? 'border-accent bg-accent-subtle text-zinc-900 dark:text-zinc-100'
            : 'border-zinc-200 dark:border-zinc-800 bg-zinc-100/70 dark:bg-zinc-950/60 text-zinc-500 dark:text-zinc-400'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Globe className={`w-3.5 h-3.5 shrink-0 ${webSearchEnabled ? 'text-accent' : 'text-zinc-400'}`} />
          <span className="font-semibold truncate">
            Live Web Search &amp; Grounding ({webSearchEnabled ? 'Enabled' : 'Disabled'})
          </span>
        </div>
        {onToggleWebSearch && (
          <button
            type="button"
            role="switch"
            aria-checked={webSearchEnabled}
            aria-label="Toggle Live Web Search & Grounding"
            onClick={(e) => {
              e.stopPropagation();
              onToggleWebSearch();
            }}
            className={`relative inline-flex h-4 w-8 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-150 ease-in-out focus:outline-none ${
              webSearchEnabled ? 'bg-accent' : 'bg-zinc-300 dark:bg-zinc-700'
            }`}
          >
            <span className="sr-only">Toggle Live Web Search &amp; Grounding</span>
            <span
              aria-hidden="true"
              className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow-xs ring-0 transition duration-150 ease-in-out ${
                webSearchEnabled ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        )}
      </div>

      {/* Simplified Tool List */}
      <div
        className={`p-2 grid ${
          popupMode ? 'grid-cols-1 max-h-72' : compact ? 'grid-cols-1 sm:grid-cols-2 max-h-64' : 'grid-cols-1 sm:grid-cols-2 max-h-80'
        } gap-1.5 overflow-y-auto`}
      >
        {optionalPlugins.length === 0 ? (
          <div className="col-span-full py-4 text-center text-xs text-zinc-400">
            No optional tools available.
          </div>
        ) : (
          optionalPlugins.map((plugin) => {
            const isEnabled = enabledPluginIds.includes(plugin.id);

            return (
              <div
                key={plugin.id}
                onClick={() => onTogglePlugin(plugin.id)}
                title={plugin.description}
                className={`relative flex items-center justify-between gap-2.5 rounded-xl px-3 py-2 border transition-colors cursor-pointer select-none ${
                  isEnabled
                    ? 'border-accent bg-accent-subtle'
                    : 'border-zinc-200 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/50 opacity-80 hover:opacity-100'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  {getCategoryIcon(plugin.category)}
                  <div className="min-w-0 flex-1">
                    <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate block">
                      {plugin.name}
                    </span>
                    <p className="text-[10px] text-zinc-500 dark:text-zinc-400 truncate">
                      {plugin.description}
                    </p>
                  </div>
                </div>

                {/* Toggle Switch */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={isEnabled}
                  aria-label={`Toggle ${plugin.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePlugin(plugin.id);
                  }}
                  className={`relative inline-flex h-4 w-8 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-150 ease-in-out focus:outline-none ${
                    isEnabled ? 'bg-accent' : 'bg-zinc-300 dark:bg-zinc-700'
                  }`}
                  title={isEnabled ? `Disable ${plugin.name}` : `Enable ${plugin.name}`}
                >
                  <span className="sr-only">Toggle {plugin.name}</span>
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow-xs ring-0 transition duration-150 ease-in-out ${
                      isEnabled ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Simplified Footer Bar */}
      <div className="px-3 py-1.5 border-t border-zinc-100 dark:border-zinc-800/80 bg-stone-50/70 dark:bg-zinc-950/60 rounded-b-2xl flex items-center justify-between text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
        <span className="truncate">
          {optionalPlugins.length} Optional Domain Tools · Built-in inference server
        </span>
      </div>
    </div>
  );
};
