// Hot-Swappable Plugin Registry & Tool Execution Router (4 Consolidated Domain Tools + Aliases)
import type {
  DocumentChunk,
  PluginDefinition,
  RetrievalHit,
  SimilarityMetricId,
  ToolInvocationResult,
  VaultExcerptHit,
  VaultFileEntry
} from '../utils/rag/ragTypes';
import type { CallableToolSchema, HotSwappableToolPlugin, ToolDirectCallContext } from './types';
import { webSearchPlugin } from './plugins/webToolsPlugin';
import { agentFileOpsPlugin } from './plugins/fileAndAgentPlugins';
import { precisionCalculatorPlugin } from './plugins/precisionCalculatorPlugin';
import { systemContextPlugin } from './plugins/systemContextTool';
import {
  sanitizeToolIdentifier,
  invokeToolCallByNameWithRegistry
} from './toolInvoker';

export { sanitizeToolIdentifier };

// Built-in tools with aliases for supported legacy IDs.
const DEFAULT_BUILT_IN_PLUGINS: HotSwappableToolPlugin[] = [
  webSearchPlugin,
  agentFileOpsPlugin,
  systemContextPlugin,
  precisionCalculatorPlugin
];

const pluginRegistryMap = new Map<string, HotSwappableToolPlugin>();
const aliasRegistryMap = new Map<string, string>();

function initializeDefaultPlugins() {
  pluginRegistryMap.clear();
  aliasRegistryMap.clear();
  for (const plugin of DEFAULT_BUILT_IN_PLUGINS) {
    pluginRegistryMap.set(plugin.definition.id, plugin);
    for (const alias of plugin.aliases || []) {
      aliasRegistryMap.set(alias, plugin.definition.id);
    }
  }
}

initializeDefaultPlugins();

export const AVAILABLE_PLUGINS: PluginDefinition[] = [];

function syncAvailablePluginsArray() {
  AVAILABLE_PLUGINS.length = 0;
  for (const plugin of pluginRegistryMap.values()) {
    AVAILABLE_PLUGINS.push(plugin.definition);
  }
}

syncAvailablePluginsArray();

/**
 * Dynamically registers or hot-swaps a modular tool plugin at runtime without restarting the application.
 */
export function registerToolPlugin(plugin: any): PluginDefinition {
  const pluginId = plugin.definition?.id || plugin.id;
  const def: PluginDefinition = plugin.definition || {
    id: pluginId,
    name: plugin.name || pluginId,
    category: plugin.category || 'Custom',
    description: plugin.description || '',
    parameterSummary: plugin.parameterSummary || '',
    triggerKeywords: plugin.triggerKeywords || [],
    version: plugin.version || '1.0.0',
    hotSwappable: true
  };
  const normalized: HotSwappableToolPlugin = {
    definition: def,
    aliases: plugin.aliases || [],
    evaluateForPrompt:
      plugin.evaluateForPrompt ||
      (plugin.canHandlePrompt
        ? (ctx: any) => {
            if (plugin.canHandlePrompt(ctx.prompt)) {
              return plugin.execute ? plugin.execute({ query: ctx.prompt }) : null;
            }
            return null;
          }
        : undefined),
    invokeDirect:
      plugin.invokeDirect ||
      (plugin.execute ? (args: any) => plugin.execute(args) : undefined),
    schema:
      plugin.schema || (plugin.toCallableSchema ? plugin.toCallableSchema() : undefined)
  };
  pluginRegistryMap.set(pluginId, normalized);
  for (const alias of normalized.aliases || []) {
    aliasRegistryMap.set(alias, pluginId);
  }
  syncAvailablePluginsArray();
  return def;
}

/**
 * Hot-swaps an existing tool plugin implementation by ID while preserving its slot and active state.
 */
export function hotSwapToolPlugin(
  pluginOrId: string | any,
  maybePlugin?: any
): { swapped: boolean; previousVersion?: string; currentVersion: string } {
  const nextPlugin =
    typeof pluginOrId === 'object' && pluginOrId !== null ? pluginOrId : maybePlugin || {};
  const pluginId =
    typeof pluginOrId === 'string'
      ? pluginOrId
      : nextPlugin.definition?.id || nextPlugin.id || '';

  const canonicalId = aliasRegistryMap.get(pluginId) || pluginId;
  const existing = pluginRegistryMap.get(canonicalId);
  const previousVersion = existing?.definition.version;
  const def: PluginDefinition = nextPlugin.definition || {
    id: canonicalId,
    name: nextPlugin.name || existing?.definition.name || canonicalId,
    category: nextPlugin.category || existing?.definition.category || 'Custom',
    description: nextPlugin.description || existing?.definition.description || '',
    parameterSummary:
      nextPlugin.parameterSummary || existing?.definition.parameterSummary || '',
    triggerKeywords:
      nextPlugin.triggerKeywords || existing?.definition.triggerKeywords || [],
    version: nextPlugin.version || nextPlugin.definition?.version || 'hot-swap-v2',
    hotSwappable: true
  };
  const normalized: HotSwappableToolPlugin = {
    definition: def,
    aliases: nextPlugin.aliases || existing?.aliases || [],
    evaluateForPrompt:
      nextPlugin.evaluateForPrompt ||
      (nextPlugin.canHandlePrompt
        ? (ctx: any) => {
            if (nextPlugin.canHandlePrompt(ctx.prompt)) {
              return nextPlugin.execute ? nextPlugin.execute({ query: ctx.prompt }) : null;
            }
            return null;
          }
        : existing?.evaluateForPrompt),
    invokeDirect:
      nextPlugin.invokeDirect ||
      (nextPlugin.execute
        ? (args: any) => nextPlugin.execute(args)
        : existing?.invokeDirect),
    schema:
      nextPlugin.schema ||
      (nextPlugin.toCallableSchema ? nextPlugin.toCallableSchema() : existing?.schema)
  };
  pluginRegistryMap.set(canonicalId, normalized);
  syncAvailablePluginsArray();
  return {
    swapped: Boolean(existing),
    previousVersion,
    currentVersion: def.version || 'hot-swap-v2'
  };
}

/**
 * Unregisters a dynamic tool plugin by ID.
 */
export function unregisterToolPlugin(pluginId: string): boolean {
  const deleted = pluginRegistryMap.delete(pluginId);
  syncAvailablePluginsArray();
  return deleted;
}

/**
 * Resets the hot-swappable plugin registry back to the built-in tools.
 */
export function resetDefaultToolPlugins(): void {
  initializeDefaultPlugins();
  syncAvailablePluginsArray();
}

export function getRegisteredToolPlugins(): Array<
  HotSwappableToolPlugin & { id: string; name: string }
> {
  return Array.from(pluginRegistryMap.values()).map((p) => ({
    ...p,
    id: p.definition.id,
    name: p.definition.name
  }));
}

/**
 * Pre-prompt keyword tool activation is disabled by design.
 * Enabled tools are sent as callable schemas with the prompt to the model (llama.cpp),
 * which decides whether and when to invoke them via invokeToolCallByName.
 */
export function executePluginsForPrompt(
  _prompt: string,
  _enabledPluginIds: string[],
  _ragHits: RetrievalHit[],
  _providerId: string = 'llamacpp',
  _customPlugins: PluginDefinition[] = [],
  _vaultHits: VaultExcerptHit[] = []
): ToolInvocationResult[] {
  return [];
}

export function buildCallableToolSchemas(
  enabledPluginIds: string[],
  customPlugins: PluginDefinition[] = []
): CallableToolSchema[] {
  const schemas: CallableToolSchema[] = [];
  const addedNames = new Set<string>();

  for (const plugin of pluginRegistryMap.values()) {
    const id = plugin.definition.id;
    const hasDirect = enabledPluginIds.includes(id);
    const matchedAlias = (plugin.aliases || []).find((a) => enabledPluginIds.includes(a));
    if ((hasDirect || matchedAlias) && plugin.schema) {
      const schemaName = hasDirect ? plugin.schema.name : matchedAlias || plugin.schema.name;
      if (!addedNames.has(schemaName)) {
        schemas.push({
          ...plugin.schema,
          name: schemaName
        });
        addedNames.add(schemaName);
      }
    }
  }

  if (enabledPluginIds.includes('vector_rag_search') && !addedNames.has('vector_rag_search')) {
    schemas.push({
      name: 'vector_rag_search',
      description:
        'Search the local File Repo for relevant technical documents and passages.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: 'The search query to run against local indexed documents.'
          },
          topK: {
            type: 'NUMBER',
            description: 'Maximum number of matching passages to return (default 3).'
          }
        },
        required: ['query']
      }
    });
  }

  if (enabledPluginIds.includes('memory_extractor') && !addedNames.has('memory_extractor')) {
    schemas.push({
      name: 'memory_extractor',
      description:
        'Save or synthesize a durable cross-session architectural decision or preference.',
      parameters: {
        type: 'OBJECT',
        properties: {
          utterance: {
            type: 'STRING',
            description: 'The statement or fact to record into persistent local memory.'
          }
        },
        required: ['utterance']
      }
    });
  }

  if (
    enabledPluginIds.includes('http_status_inspector') &&
    !addedNames.has('http_status_inspector')
  ) {
    schemas.push({
      name: 'http_status_inspector',
      description: 'Inspect local llama.cpp inference engine status and loopback health.',
      parameters: {
        type: 'OBJECT',
        properties: {
          providerId: {
            type: 'STRING',
            description: 'Local provider identifier (llamacpp).'
          }
        },
        required: ['providerId']
      }
    });
  }

  for (const custom of customPlugins) {
    if (!enabledPluginIds.includes(custom.id)) continue;
    const safeName = sanitizeToolIdentifier(custom.id);
    if (addedNames.has(safeName)) continue;
    schemas.push({
      name: safeName,
      description: custom.description || `Execute custom local tool: ${custom.name}`,
      parameters: {
        type: 'OBJECT',
        properties: {
          input: {
            type: 'STRING',
            description: 'Input text or parameters passed by the local AI model to this tool.'
          }
        },
        required: ['input']
      }
    });
    addedNames.add(safeName);
  }

  return schemas;
}

export function invokeToolCallByName(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolDirectCallContext
): ToolInvocationResult {
  return invokeToolCallByNameWithRegistry(
    toolName,
    args,
    context,
    pluginRegistryMap,
    aliasRegistryMap
  );
}
