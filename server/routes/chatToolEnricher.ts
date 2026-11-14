import type { LocalDatabaseSchema } from '../db/localDatabase';
import { RAG_DEFAULTS } from '../../src/data/runtimeDefaults';
import {
  performWebSearch,
  performWebFetch,
  performWebContext
} from '../tools/webSearchAndFetch';
import {
  buildVectorIndex,
  invokeToolCallByName,
  PluginDefinition,
  RagDocumentInput,
  VaultFileEntry
} from '../../src/utils/rag';
import { getSysContextMetadata } from '../../src/tools/plugins/systemContextTool';
import { detectWebGroundingNeed } from '../../src/utils/webTools';

export { extractInlineGgufToolCalls as extractInlineModelToolCalls } from './chatToolDetector';

export interface ChatWebGroundingRequest {
  query: string;
  retrievedAt: string;
  timezone: string;
}

export function prepareChatWebGroundingRequest(
  prompt: string,
  history: Array<{ role: string; content: string }>,
  forced: boolean,
  now: Date
): ChatWebGroundingRequest | null {
  const decision = detectWebGroundingNeed(prompt, history);
  if (!prompt || (!forced && !decision.trigger)) return null;
  const clock = getSysContextMetadata(now);
  const baseQuery = decision.suggestedQuery || prompt;
  const queryLower = baseQuery.toLowerCase();
  const relativeTimeTerms = [
    'today', 'tonight', 'right now', 'currently', 'current', 'latest',
    'this morning', 'this afternoon', 'this evening', 'this week', 'this weekend'
  ];
  const needsDateAnchor = decision.reason === 'factual_inquiry' ||
    decision.reason === 'correction' ||
    relativeTimeTerms.some((term) => queryLower.includes(term));
  return {
    query: needsDateAnchor ? `${baseQuery} (as of ${clock.sys_date}, ${clock.timezone})` : baseQuery,
    retrievedAt: clock.iso_timestamp,
    timezone: clock.timezone
  };
}

export async function executeChatWebGrounding(
  request: ChatWebGroundingRequest,
  runGrounding: typeof performBuiltInWebGrounding = performBuiltInWebGrounding
) {
  const grounding = await runGrounding(request.query);
  if (!grounding || grounding.passages.length === 0) return null;
  return {
    pluginId: 'web_search',
    pluginName: `Live Web Grounding (${grounding.passages.length} sources)`,
    inputSummary: `Query: "${grounding.searchQuery.slice(0, 80)}"`,
    outputSummary: `Retrieved at ${request.retrievedAt} (${request.timezone}).\n${grounding.formattedContext}`,
    durationMs: grounding.durationMs
  };
}

/**
 * Executes built-in live web grounding (search + top page fetch + passage ranking).
 */
export async function performBuiltInWebGrounding(input: string | {
  query: string;
  reason?: string;
  docsToUse?: RagDocumentInput[];
  vaultToUse?: VaultFileEntry[];
}): Promise<{
  pluginId: 'web_search';
  outputSummary: string;
  searchQuery: string;
  formattedContext: string;
  passages: Array<{ id: string; title: string; url: string; excerpt: string; score: number }>;
  durationMs: number;
} | null> {
  const start = performance.now();
  try {
    const context = await performWebContext({
      query: typeof input === 'string' ? input : input.query,
      topK: 4
    });
    if (!context.passages || context.passages.length === 0) {
      throw new Error('No web passages were available for verification.');
    }

    const formattedLines = context.passages.map(
      (p, i) =>
        `[Web Source ${i + 1}: "${p.title}" (${p.url}) · relevance ${(p.relevanceScore * 100).toFixed(0)}%]\n${p.excerpt}`
    );

    return {
      pluginId: 'web_search',
      outputSummary: formattedLines.join('\n\n'),
      searchQuery: context.query,
      formattedContext: formattedLines.join('\n\n'),
      passages: context.passages.map((p) => ({
        id: p.id,
        title: p.title,
        url: p.url,
        excerpt: p.excerpt,
        score: p.relevanceScore
      })),
      durationMs: Math.max(1, Math.round(performance.now() - start))
    };
  } catch (error) {
    throw new Error(`Built-in web grounding failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export function parseToolArgsObject(rawArgs: string): Record<string, unknown> {
  if (!rawArgs || !rawArgs.trim()) return {};
  try {
    const parsed = JSON.parse(rawArgs);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { input: rawArgs };
  }
}

/**
 * Executes a model-requested tool call on the server, including async web tools.
 */
export async function executeModelToolCallOnServer(
  toolName: string,
  args: Record<string, unknown>,
  customPlugins: PluginDefinition[],
  localDb: LocalDatabaseSchema
): Promise<{
  pluginId: string;
  pluginName: string;
  inputSummary: string;
  outputSummary: string;
  durationMs: number;
}> {
  const start = performance.now();
  const normalizedName = String(toolName || '').trim().toLowerCase();

  try {
    if (
      normalizedName === 'web_search' ||
      normalizedName === 'web_fetch' ||
      normalizedName === 'web_context' ||
      normalizedName === 'live_search'
    ) {
      const mode = String(
        args.mode || (normalizedName === 'live_search' ? 'search' : normalizedName)
      ).toLowerCase();
      const urlArg = String(args.url || '').trim();
      const queryArg = String(args.query || args.input || args.prompt || '').trim();

      if ((mode.includes('fetch') || urlArg.startsWith('http')) && urlArg) {
        const fetched = await performWebFetch(
          urlArg,
          Number(args.maxChars) || 4000
        );
        return {
          pluginId: 'web_search',
          pluginName: 'Live Web Search & Reader',
          inputSummary: `URL: ${fetched.url}`,
          outputSummary: `Title: "${fetched.title}" (${fetched.wordCount} words)\n\n${fetched.content.slice(0, 2400)}`,
          durationMs: Math.max(1, Math.round(performance.now() - start))
        };
      }

      if (mode.includes('search') && !mode.includes('context')) {
        const results = await performWebSearch(
          queryArg || 'local LLM architecture',
          Number(args.maxResults) || 5
        );
        const formatted = results
          .map(
            (r, i) =>
              `${i + 1}. ${r.title} (${r.url}) [${r.source} · score ${r.score.toFixed(2)}]\n   ${r.snippet}`
          )
          .join('\n\n');
        return {
          pluginId: 'web_search',
          pluginName: 'Live Web Search & Reader',
          inputSummary: `Search: "${queryArg}"`,
          outputSummary: formatted || 'No results returned.',
          durationMs: Math.max(1, Math.round(performance.now() - start))
        };
      }

      const ctx = await performWebContext({
        query: queryArg || 'local LLM inference',
        topK: Number(args.maxResults) || 4
      });
      return {
        pluginId: 'web_search',
        pluginName: 'Live Web Search & Reader',
        inputSummary: `Web Context: "${ctx.query}"`,
        outputSummary: ctx.synthesizedSummary,
        durationMs: Math.max(1, Math.round(performance.now() - start))
      };
    }

  } catch (err) {
    return {
      pluginId: normalizedName || 'tool',
      pluginName: toolName,
      inputSummary: JSON.stringify(args).slice(0, 100),
      outputSummary: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Math.max(1, Math.round(performance.now() - start))
    };
  }

  const index = buildVectorIndex(
    localDb.ragDocuments,
    localDb.ragConfig.chunkSize ?? RAG_DEFAULTS.chunkSize,
    localDb.ragConfig.chunkOverlap ?? RAG_DEFAULTS.chunkOverlap,
    localDb.ragConfig.embeddingDimensions,
    localDb.ragConfig.normalizeEmbeddings !== false
  );
  return invokeToolCallByName(toolName, args, {
    vectorIndex: index,
    vaultFiles: localDb.vaultFiles,
    memories: localDb.memories,
    messagesBySession: localDb.messagesBySession,
    sessions: localDb.sessions,
    distanceMetric: localDb.ragConfig.similarityMetric || RAG_DEFAULTS.similarityMetric,
    providerId: 'llamacpp',
    customPlugins
  });
}
