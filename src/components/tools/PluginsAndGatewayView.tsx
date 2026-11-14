import React from 'react';
import {
  AVAILABLE_PLUGINS,
  PluginDefinition
} from '../../utils/rag';
import { ChatToolsTab } from './ChatToolsTab';

interface PluginsAndGatewayViewProps {
  initialSubTab?: 'tools' | 'web_tester';
  chatTitle?: string;
  enabledPluginIds: string[];
  webSearchEnabled?: boolean;
  onToggleWebSearch?: () => void;
  customPlugins: PluginDefinition[];
  onTogglePlugin: (pluginId: string) => void;
  onSetAllPlugins?: (pluginIds: string[]) => void;
  onSetEnabledPlugins?: (pluginIds: string[]) => void;
  onAddCustomPlugin?: (plugin: PluginDefinition) => void;
  onUpdateCustomPlugin?: (
    id: string,
    updates: Partial<Omit<PluginDefinition, 'id'>>
  ) => void;
  onDeleteCustomPlugin?: (pluginId: string) => void;
  onSendContextToChat?: (promptText: string) => void;
  activeProviderId?: string;
  ragDocuments?: unknown[];
}

export const PluginsAndGatewayView: React.FC<PluginsAndGatewayViewProps> = ({
  chatTitle,
  enabledPluginIds,
  webSearchEnabled = true,
  onToggleWebSearch,
  customPlugins = [],
  onTogglePlugin,
  onSetAllPlugins,
  onSetEnabledPlugins,
  onAddCustomPlugin,
  onDeleteCustomPlugin
}) => {
  const allTools = [...AVAILABLE_PLUGINS, ...customPlugins];
  const optionalTools = allTools.filter((t) => t.id !== 'web_search' && t.id !== 'live_search');
  const activeOptionalCount = enabledPluginIds.filter(
    (id) => id !== 'web_search' && id !== 'live_search'
  ).length;

  return (
    <div className="h-full overflow-y-auto bg-zinc-950 p-4 sm:p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 pb-4 border-b border-zinc-800">
          <div>
            <h1 className="text-xl font-heading font-semibold tracking-tight text-zinc-100">
              Tools &amp; Plugins
            </h1>
            <p className="text-sm text-zinc-400 mt-1">
              {chatTitle
                ? <>Active tools for <span className="text-zinc-200 font-medium">&ldquo;{chatTitle}&rdquo;</span>. Web Search starts enabled by default; optional tools start off.</>
                : 'Choose which tools Octopus may call. Web Search starts enabled by default and can be toggled off per chat.'}
            </p>
          </div>
          <span className="text-xs text-zinc-400 shrink-0">
            {activeOptionalCount} of {optionalTools.length} optional active · Web Search {webSearchEnabled ? 'On' : 'Off'}
          </span>
        </div>

        <ChatToolsTab
          enabledPluginIds={enabledPluginIds}
          webSearchEnabled={webSearchEnabled}
          onToggleWebSearch={onToggleWebSearch}
          customPlugins={customPlugins}
          onTogglePlugin={onTogglePlugin}
          onSetAllPlugins={onSetAllPlugins}
          onSetEnabledPlugins={onSetEnabledPlugins}
          onAddCustomPlugin={onAddCustomPlugin}
          onDeleteCustomPlugin={onDeleteCustomPlugin}
        />
      </div>
    </div>
  );
};
