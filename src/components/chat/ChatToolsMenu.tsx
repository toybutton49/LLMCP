import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Wrench } from 'lucide-react';
import { PluginDefinition } from '../../utils/rag';
import { ToolToggleList } from '../tools/ToolToggleList';

interface ChatToolsMenuProps {
  allPlugins: PluginDefinition[];
  enabledPluginIds: string[];
  webSearchEnabled?: boolean;
  onToggleWebSearch?: () => void;
  onChangePluginIds: (pluginIds: string[]) => void;
}

const BUILT_IN_PLUGIN_IDS = new Set(['web_search', 'live_search']);

export const ChatToolsMenu: React.FC<ChatToolsMenuProps> = ({
  allPlugins,
  enabledPluginIds,
  webSearchEnabled = true,
  onToggleWebSearch,
  onChangePluginIds
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const optionalIds = useMemo(
    () => allPlugins.filter((plugin) => !BUILT_IN_PLUGIN_IDS.has(plugin.id)).map((plugin) => plugin.id),
    [allPlugins]
  );
  const enabledOptionalCount = enabledPluginIds.filter((id) => optionalIds.includes(id)).length;

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePointer = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const togglePlugin = (pluginId: string) => {
    onChangePluginIds(
      enabledPluginIds.includes(pluginId)
        ? enabledPluginIds.filter((id) => id !== pluginId)
        : [...enabledPluginIds, pluginId]
    );
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="Choose which optional tools this chat can call"
        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
          enabledOptionalCount > 0
            ? 'border-accent/60 text-accent'
            : 'border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 hover:text-accent'
        }`}
      >
        <Wrench className="w-3 h-3" />
        <span>Tools</span>
        <span className="font-mono">{enabledOptionalCount}/{optionalIds.length}</span>
      </button>
      {open && (
        <ToolToggleList
          allPlugins={allPlugins}
          enabledPluginIds={enabledPluginIds}
          webSearchEnabled={webSearchEnabled}
          onToggleWebSearch={onToggleWebSearch}
          onTogglePlugin={togglePlugin}
          onEnableAll={() => onChangePluginIds([...new Set([...enabledPluginIds, ...optionalIds])])}
          onDisableAll={() => onChangePluginIds(enabledPluginIds.filter((id) => !optionalIds.includes(id)))}
          popupMode
          onClose={() => setOpen(false)}
          className="absolute bottom-full left-0 mb-2 z-20 w-[min(90vw,28rem)]"
        />
      )}
    </div>
  );
};
