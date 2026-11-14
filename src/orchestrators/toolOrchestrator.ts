import {
  AVAILABLE_PLUGINS,
  PluginDefinition,
  CallableToolSchema,
  buildCallableToolSchemas,
  invokeToolCallByName,
  buildVectorIndex,
  mutateCustomPlugin
} from '../utils/rag';
import {
  ToolDispatchInput,
  ToolDispatchOutput,
  StageTelemetry
} from './types';

/**
 * Tools orchestrator for tool schemas, hot-swappable plugins, and model-requested execution.
 */
export class ToolOrchestrator {
  public readonly domain = 'tools';
  public readonly suctionCups = [
    'GET /api/tools/registry',
    'POST /api/tools/call',
    'POST /api/tools/execute',
    'POST /api/tools/web-search',
    'POST /api/tools/web-fetch',
    'POST /api/tools/web-context',
    'POST /api/agent/execute'
  ];
  private customPlugins: PluginDefinition[];

  constructor(customPlugins: PluginDefinition[] = []) {
    this.customPlugins = [...customPlugins];
  }

  public setCustomPlugins(plugins: PluginDefinition[]): void {
    this.customPlugins = [...plugins];
  }

  public addCustomPlugin(
    plugins: PluginDefinition[],
    plugin: PluginDefinition
  ): PluginDefinition[] {
    const next = [plugin, ...plugins.filter((p) => p.id !== plugin.id)];
    this.customPlugins = next;
    return next;
  }

  public updateCustomPlugin(
    plugins: PluginDefinition[],
    id: string,
    updates: Partial<Omit<PluginDefinition, 'id'>>
  ): PluginDefinition[] {
    const next = mutateCustomPlugin(plugins, id, updates);
    this.customPlugins = next;
    return next;
  }

  public deleteCustomPlugin(plugins: PluginDefinition[], pluginId: string): PluginDefinition[] {
    const next = plugins.filter((p) => p.id !== pluginId);
    this.customPlugins = next;
    return next;
  }

  public getAllAvailablePlugins(): PluginDefinition[] {
    return [...AVAILABLE_PLUGINS, ...this.customPlugins];
  }

  public getCallableSchemas(enabledPluginIds: string[], webSearchEnabled: boolean = true): CallableToolSchema[] {
    const filtered = enabledPluginIds.filter((id) => webSearchEnabled || (id !== 'web_search' && id !== 'live_search'));
    const engineTools = webSearchEnabled
      ? (filtered.includes('web_search') ? filtered : ['web_search', ...filtered])
      : filtered;
    return buildCallableToolSchemas(engineTools, this.customPlugins);
  }

  /**
   * Prepares enabled tool schemas to send with the prompt to llama.cpp.
   * Does not pre-trigger tools via keywords; the model decides whether to invoke tools.
   */
  public async dispatchForPrompt(input: ToolDispatchInput): Promise<{
    output: ToolDispatchOutput;
    telemetry: StageTelemetry;
  }> {
    const start = performance.now();
    const schemas = this.getCallableSchemas(input.enabledPluginIds || [], input.webSearchEnabled !== false);
    const durationMs = Math.round((performance.now() - start) * 100) / 100;

    return {
      output: {
        results: [],
        totalDurationMs: durationMs,
        executedCount: 0,
        failedCount: 0,
        citationsSummary: ''
      },
      telemetry: {
        stage: 'tool_dispatch',
        label: 'Optional tool schemas',
        status: 'success',
        durationMs,
        summary: `Prepared ${schemas.length} enabled tool schema(s) for model selection.`,
        details: {
          schemaCount: schemas.length,
          activeTools: schemas.map((s) => s.name)
        }
      }
    };
  }

  /**
   * Invokes a specific tool call by name with arguments when requested by the model.
   */
  public async invokeNamedTool(
    toolName: string,
    args: Record<string, unknown>,
    context: {
      vaultFiles?: any[];
      ragDocuments?: any[];
      activeProviderId?: any;
    }
  ): Promise<{ result: string; durationMs: number; error?: string }> {
    const start = performance.now();
    try {
      const vectorIndex = buildVectorIndex(context.ragDocuments || []);
      const output = invokeToolCallByName(toolName, args, {
        vectorIndex,
        vaultFiles: context.vaultFiles || [],
        providerId: context.activeProviderId || 'llamacpp',
        customPlugins: this.customPlugins
      });
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      return { result: output.outputSummary, durationMs };
    } catch (err) {
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      const msg = err instanceof Error ? err.message : 'Unknown tool error';
      return { result: `Tool error: ${msg}`, durationMs, error: msg };
    }
  }
}
