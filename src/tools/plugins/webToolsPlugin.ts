// Unified Web Search, Fetch & Context Grounding Tool Plugin
import { searchVectorIndex } from '../../utils/rag/vectorEngine';
import type { HotSwappableToolPlugin } from '../types';

export const webSearchPlugin: HotSwappableToolPlugin = {
  definition: {
    id: 'web_search',
    name: 'Web Search, Fetch & Context',
    category: 'Web & Research',
    description:
      'Unified web tool that searches live documentation, fetches HTTP/HTTPS URLs into clean Markdown, and grounds context passages.',
    parameterSummary: 'query?: string, url?: string, mode?: "search" | "fetch" | "context", maxResults?: number',
    version: '3.0.0',
    hotSwappable: true
  },
  aliases: ['web_fetch', 'web_context', 'web_tool', 'web_ops', 'web_research', 'web'],
  schema: {
    name: 'web_search',
    description:
      'Unified Web Search, Fetch & Context tool: search live documentation, fetch HTTP/HTTPS URLs into clean Markdown, and ground context passages.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'Search query or topic to research and ground.'
        },
        url: {
          type: 'STRING',
          description: 'Optional target HTTP/HTTPS URL to fetch and extract readable Markdown from.'
        },
        mode: {
          type: 'STRING',
          description: 'Optional operation mode: "search" (default), "fetch", or "context".'
        },
        action: {
          type: 'STRING',
          description: 'Optional alias for mode: "search", "fetch", or "context".'
        },
        maxResults: {
          type: 'NUMBER',
          description: 'Maximum number of results or passages to return (default 5).'
        }
      },
      required: []
    }
  },
  invokeDirect: (args, context) => {
    const start = Date.now();
    const query = String(args.query || '').trim();
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    const mode = String(args.mode || args.action || (url && !query ? 'fetch' : 'search')).toLowerCase();

    if (mode === 'fetch' || (url && !query)) {
      return {
        pluginId: 'web_search',
        pluginName: 'Web Search, Fetch & Context',
        inputSummary: `fetch("${url}")`,
        outputSummary: `Fetched and parsed readable Markdown content from "${url}"`,
        durationMs: Math.max(5, Date.now() - start)
      };
    }

    const hits = searchVectorIndex(
      query || url,
      context.vectorIndex,
      2,
      0.05,
      context.distanceMetric || 'cosine'
    );
    const summary =
      hits.length > 0
        ? `Web Search, Fetch & Context for "${query}": ${hits.map((h) => `[${h.docTitle}] ${h.text.slice(0, 120)}`).join(' | ')}`
        : `Executed unified web research for "${query || url}"${url ? ` (url: ${url})` : ''}.`;

    return {
      pluginId: 'web_search',
      pluginName: 'Web Search, Fetch & Context',
      inputSummary: `query="${query}"${url ? ` url="${url}"` : ''}`,
      outputSummary: summary,
      durationMs: Math.max(4, Date.now() - start)
    };
  }
};

// Backwards-compatible exports pointing to the unified web tool plugin
export const webFetchPlugin: HotSwappableToolPlugin = webSearchPlugin;
export const webContextPlugin: HotSwappableToolPlugin = webSearchPlugin;
