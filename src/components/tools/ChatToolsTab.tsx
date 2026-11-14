import React, { useState } from 'react';
import {
  Wrench,
  Globe,
  Plus,
  Trash2,
  FileCode2
} from 'lucide-react';
import {
  AVAILABLE_PLUGINS,
  PluginDefinition
} from '../../utils/rag';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';

interface ChatToolsTabProps {
  enabledPluginIds: string[];
  webSearchEnabled?: boolean;
  onToggleWebSearch?: () => void;
  customPlugins: PluginDefinition[];
  onTogglePlugin: (pluginId: string) => void;
  onSetAllPlugins?: (pluginIds: string[]) => void;
  onSetEnabledPlugins?: (pluginIds: string[]) => void;
  onAddCustomPlugin?: (plugin: PluginDefinition) => void;
  onDeleteCustomPlugin?: (pluginId: string) => void;
}

export const ChatToolsTab: React.FC<ChatToolsTabProps> = ({
  enabledPluginIds,
  webSearchEnabled = true,
  onToggleWebSearch,
  customPlugins,
  onTogglePlugin,
  onSetAllPlugins,
  onSetEnabledPlugins,
  onAddCustomPlugin,
  onDeleteCustomPlugin
}) => {
  const applyPluginList = (ids: string[]) => {
    if (onSetAllPlugins) onSetAllPlugins(ids);
    if (onSetEnabledPlugins) onSetEnabledPlugins(ids);
  };

  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [toolToDelete, setToolToDelete] = useState<PluginDefinition | null>(null);

  const [showCustomToolForm, setShowCustomToolForm] = useState(false);
  const [customToolName, setCustomToolName] = useState('');
  const [customToolDesc, setCustomToolDesc] = useState('');
  const [customToolTemplate, setCustomToolTemplate] = useState(
    'Executed custom tool on input: {{prompt}}'
  );

  const allTools = [...AVAILABLE_PLUGINS, ...customPlugins];
  const categories = ['ALL', ...Array.from(new Set(allTools.map((p) => p.category)))];

  const filteredTools = allTools.filter(
    (tool) => selectedCategory === 'ALL' || tool.category === selectedCategory
  );

  const handleCreateCustomTool = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customToolName.trim() || !onAddCustomPlugin) return;
    const rawLower = customToolName.trim().toLowerCase();
    let slug = '';
    let prevUnderscore = false;
    for (let i = 0; i < rawLower.length; i++) {
      const code = rawLower.charCodeAt(i);
      const isAlphaNum =
        (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
      if (isAlphaNum) {
        slug += rawLower[i];
        prevUnderscore = false;
      } else if (!prevUnderscore && slug.length > 0) {
        slug += '_';
        prevUnderscore = true;
      }
    }
    if (slug.endsWith('_')) slug = slug.slice(0, -1);
    const id = `custom_${slug || 'tool'}`;
    onAddCustomPlugin({
      id,
      name: customToolName.trim(),
      category: 'Utility',
      description:
        customToolDesc.trim() ||
        'Custom tool sent with the prompt when enabled so Octopus can invoke it.',
      parameterSummary: 'input: string',
      responseTemplate: customToolTemplate.trim() || 'Executed custom tool: {{prompt}}',
      isCustom: true
    });
    setCustomToolName('');
    setCustomToolDesc('');
    setShowCustomToolForm(false);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-zinc-800/80">
        <div className="flex flex-wrap items-center gap-1.5">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedCategory(cat)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                selectedCategory === cat
                  ? 'bg-accent text-zinc-950 font-semibold'
                  : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200 border border-zinc-800'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {onAddCustomPlugin && (
            <button
              type="button"
              onClick={() => setShowCustomToolForm((prev) => !prev)}
              className="px-3 py-1.5 rounded-md text-xs font-semibold bg-accent text-zinc-950 inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{showCustomToolForm ? 'Close Builder' : 'Create Custom Tool'}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              applyPluginList(
                allTools
                  .filter((p) => p.id !== 'web_search' && p.id !== 'live_search')
                  .map((p) => p.id)
              )
            }
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-900 border border-zinc-800 text-zinc-300 hover:bg-zinc-800 cursor-pointer"
          >
            Enable All Optional
          </button>
          <button
            type="button"
            onClick={() => applyPluginList([])}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-900 border border-zinc-800 text-zinc-400 hover:bg-zinc-800 cursor-pointer"
          >
            Disable All Optional
          </button>
        </div>
      </div>

      {showCustomToolForm && (
        <form
          onSubmit={handleCreateCustomTool}
          className="p-4 rounded-lg border border-accent bg-zinc-900/70 space-y-3"
        >
          <div className="text-sm font-semibold text-zinc-100">
            Create Custom Tool
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              value={customToolName}
              onChange={(e) => setCustomToolName(e.target.value)}
              placeholder="Tool Name (e.g. SQL Formatter)"
              className="px-3.5 py-2 text-sm rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-100 focus-accent"
            />
            <input
              type="text"
              value={customToolDesc}
              onChange={(e) => setCustomToolDesc(e.target.value)}
              placeholder="Describe when Octopus should use this tool"
              className="px-3.5 py-2 text-sm rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-100 focus-accent"
            />
          </div>
          <div className="flex items-center gap-2.5">
            <input
              type="text"
              value={customToolTemplate}
              onChange={(e) => setCustomToolTemplate(e.target.value)}
              placeholder="Output template (use {{prompt}})"
              className="flex-1 px-3.5 py-2 text-sm font-mono rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-100 focus-accent"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-accent text-zinc-950 text-xs font-semibold cursor-pointer"
            >
              Save Tool
            </button>
          </div>
        </form>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filteredTools.map((tool) => {
          const isBuiltInWeb = tool.id === 'web_search' || tool.id === 'live_search';
          const isEnabled = isBuiltInWeb ? Boolean(webSearchEnabled) : enabledPluginIds.includes(tool.id);
          const isWeb = tool.category === 'Web & Research';
          const isRepo = tool.category === 'File Repo';

          return (
            <div
              key={tool.id}
              data-testid={`tool-card-${tool.id}`}
              data-enabled={isEnabled ? 'true' : 'false'}
              className={`p-4 rounded-lg border transition-colors flex flex-col justify-between ${
                isEnabled
                  ? 'bg-white dark:bg-zinc-900 border-accent'
                  : 'bg-zinc-100/60 dark:bg-zinc-900/40 border-zinc-200 dark:border-zinc-800/80 opacity-75'
              }`}
            >
              <div>
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    {isWeb ? (
                      <Globe className="w-4 h-4 text-accent shrink-0" />
                    ) : isRepo ? (
                      <FileCode2 className="w-4 h-4 text-accent shrink-0" />
                    ) : (
                      <Wrench className="w-4 h-4 text-accent shrink-0" />
                    )}
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {tool.name}
                      </h3>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        {tool.category} · <span className="font-mono text-[11px]">{tool.id}</span>
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {isBuiltInWeb ? (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={Boolean(webSearchEnabled)}
                        onClick={() => onToggleWebSearch?.()}
                        aria-label={`Toggle ${tool.name}`}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                          webSearchEnabled
                            ? 'bg-accent text-zinc-950 font-semibold'
                            : 'bg-zinc-200 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                        }`}
                      >
                        {webSearchEnabled ? 'Enabled (Default)' : 'Disabled'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onTogglePlugin(tool.id)}
                        aria-label={`Toggle ${tool.name}`}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                          isEnabled
                            ? 'bg-accent text-zinc-950 font-semibold'
                            : 'bg-zinc-200 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                        }`}
                      >
                        {isEnabled ? 'Enabled' : 'Off'}
                      </button>
                    )}
                    {tool.isCustom && onDeleteCustomPlugin && (
                      <button
                        type="button"
                        onClick={() => setToolToDelete(tool)}
                        aria-label={`Delete ${tool.name}`}
                        title={`Delete ${tool.name}`}
                        className="p-1 text-zinc-400 hover:text-rose-500 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  {tool.description}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDeleteModal
        isOpen={!!toolToDelete}
        onClose={() => setToolToDelete(null)}
        onConfirm={() => {
          if (toolToDelete && onDeleteCustomPlugin) {
            onDeleteCustomPlugin(toolToDelete.id);
            setToolToDelete(null);
          }
        }}
        title="Delete Custom Tool?"
        description="Are you sure you want to delete this custom tool? It will be removed from your active plugins."
        itemName={toolToDelete?.name}
        confirmLabel="Delete"
      />
    </div>
  );
};
