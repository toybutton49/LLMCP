// Source Verification, Fact Grounding Classification, and Citation Extraction Engine
import { WorkspaceMessage } from '../data/seedData';
import { extractUrlsFromText } from './webTools';
import { isBinaryOrImageFile } from './rag/binaryGuards';

export type FactGroundingLevel =
  | 'web_context'
  | 'local_repo_context'
  | 'rag_context'
  | 'system_context'
  | 'model_links'
  | 'parametric_model';

export interface ParsedSourceItem {
  id: string;
  title: string;
  url?: string;
  domain?: string;
  excerpt: string;
  score?: number;
  sourceKind: 'web' | 'vault' | 'rag' | 'system' | 'reference';
  lineRange?: string;
  sha256Preview?: string;
  timestamp?: string;
}

export interface FactGroundingAnalysis {
  level: FactGroundingLevel;
  levelLabel: string;
  levelDescription: string;
  badgeVariant: 'emerald' | 'sky' | 'indigo' | 'purple' | 'zinc';
  sources: ParsedSourceItem[];
  hasSources: boolean;
  citationCount: number;
}

function extractDomainFromUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  let cleaned = rawUrl.trim();
  const httpPrefix = 'http://';
  const httpsPrefix = 'https://';
  if (cleaned.startsWith(httpsPrefix)) {
    cleaned = cleaned.slice(httpsPrefix.length);
  } else if (cleaned.startsWith(httpPrefix)) {
    cleaned = cleaned.slice(httpPrefix.length);
  }
  const slashIdx = cleaned.indexOf('/');
  const colonIdx = cleaned.indexOf(':');
  let domainEnd = cleaned.length;
  if (slashIdx !== -1 && colonIdx !== -1) {
    domainEnd = Math.min(slashIdx, colonIdx);
  } else if (slashIdx !== -1) {
    domainEnd = slashIdx;
  } else if (colonIdx !== -1) {
    domainEnd = colonIdx;
  }
  return cleaned.slice(0, domainEnd).toLowerCase();
}

function parseWebToolSources(
  toolInvocations: NonNullable<WorkspaceMessage['toolInvocations']>
): ParsedSourceItem[] {
  const items: ParsedSourceItem[] = [];
  let sourceCounter = 0;

  for (const tool of toolInvocations) {
    const isWeb =
      tool.pluginId === 'web_search' ||
      tool.pluginId === 'web_fetch' ||
      tool.pluginId === 'web_context' ||
      tool.pluginName.toLowerCase().includes('web');

    if (!isWeb) continue;

    const beforeToolItems = items.length;
    const blocks = tool.outputSummary.split('\n\n');
    for (const block of blocks) {
      const trimmedBlock = block.trim();
      if (!trimmedBlock) continue;
      const blockUrls = extractUrlsFromText(trimmedBlock);
      const firstUrl = blockUrls.length > 0 ? blockUrls[0] : undefined;
      const domain = firstUrl ? extractDomainFromUrl(firstUrl) : undefined;

      const lines = trimmedBlock.split('\n').map((l) => l.trim()).filter(Boolean);
      let title = lines[0] || 'Live Web Source';
      if (title.startsWith('[') && title.includes(']')) {
        const closeIdx = title.indexOf(']');
        const tag = title.slice(1, closeIdx).trim();
        const afterTag = title.slice(closeIdx + 1).trim();
        title = afterTag || tag || title;
      }

      sourceCounter++;
      items.push({
        id: `web_src_${sourceCounter}`,
        title,
        url: firstUrl,
        domain,
        excerpt: lines.slice(1).join(' ') || trimmedBlock,
        sourceKind: 'web'
      });
    }

    if (items.length === beforeToolItems && (tool.inputSummary || tool.outputSummary)) {
      const urls = extractUrlsFromText(`${tool.inputSummary} ${tool.outputSummary}`);
      const firstUrl = urls.length > 0 ? urls[0] : undefined;
      sourceCounter++;
      items.push({
        id: `web_src_${sourceCounter}`,
        title: tool.inputSummary || 'Live Web Intelligence',
        url: firstUrl,
        domain: firstUrl ? extractDomainFromUrl(firstUrl) : undefined,
        excerpt: tool.outputSummary.slice(0, 400),
        sourceKind: 'web'
      });
    }
  }

  return items;
}

function extractInlineTextCitations(content: string): ParsedSourceItem[] {
  const items: ParsedSourceItem[] = [];
  if (!content) return items;
  const urls = extractUrlsFromText(content);
  let counter = 0;
  for (const url of urls) {
    counter++;
    const domain = extractDomainFromUrl(url);
    items.push({
      id: `inline_url_${counter}`,
      title: domain ? `Source: ${domain}` : 'Online Reference',
      url,
      domain,
      excerpt: url,
      sourceKind: 'reference'
    });
  }
  return items;
}

export function analyzeMessageFactGrounding(msg: WorkspaceMessage): FactGroundingAnalysis {
  const sources: ParsedSourceItem[] = [];
  let sourceCounter = 0;

  if (Array.isArray(msg.toolInvocations) && msg.toolInvocations.length > 0) {
    const webSources = parseWebToolSources(msg.toolInvocations);
    sources.push(...webSources);

    for (const tool of msg.toolInvocations) {
      if (tool.pluginId === 'sys_context' || tool.pluginId === 'system_context') {
        sourceCounter++;
        sources.push({
          id: `sys_src_${sourceCounter}`,
          title: 'System Environment & Clock Context',
          excerpt: tool.outputSummary.slice(0, 300),
          sourceKind: 'system'
        });
      } else if (tool.pluginId === 'precision_calculator') {
        sourceCounter++;
        sources.push({
          id: `calc_src_${sourceCounter}`,
          title: 'Deterministic Calculator Result',
          excerpt: tool.outputSummary.slice(0, 300),
          sourceKind: 'system'
        });
      } else if (tool.pluginId === 'agent_file_ops' || tool.pluginId === 'file_ops') {
        sourceCounter++;
        sources.push({
          id: `file_ops_src_${sourceCounter}`,
          title: tool.pluginName || 'File Repo & Database Probe',
          excerpt: tool.outputSummary.slice(0, 300),
          sourceKind: 'vault'
        });
      }
    }
  }

  if (Array.isArray(msg.vaultCitations) && msg.vaultCitations.length > 0) {
    for (const v of msg.vaultCitations) {
      if (
        isBinaryOrImageFile(v.fileName, undefined, v.excerpt) ||
        v.excerpt.startsWith('[Binary Media:') ||
        v.excerpt.startsWith('[Attached Binary Media:')
      ) {
        continue;
      }
      sourceCounter++;
      sources.push({
        id: `vault_src_${sourceCounter}`,
        title: v.fileName,
        excerpt: v.excerpt,
        score: v.score,
        lineRange: v.lineRange,
        sha256Preview: v.sha256Preview,
        sourceKind: 'vault'
      });
    }
  }

  if (Array.isArray(msg.ragCitations) && msg.ragCitations.length > 0) {
    for (const r of msg.ragCitations) {
      sourceCounter++;
      sources.push({
        id: `rag_src_${sourceCounter}`,
        title: r.docTitle,
        excerpt: r.excerpt,
        score: r.score,
        sourceKind: 'rag'
      });
    }
  }

  if (sources.length === 0 && msg.content) {
    const inlineCitations = extractInlineTextCitations(msg.content);
    sources.push(...inlineCitations);
  }

  const hasWeb = sources.some((s) => s.sourceKind === 'web');
  const hasVault = sources.some((s) => s.sourceKind === 'vault');
  const hasRag = sources.some((s) => s.sourceKind === 'rag');
  const hasSystem = sources.some((s) => s.sourceKind === 'system');

  if (hasWeb) {
    return {
      level: 'web_context',
      levelLabel: 'Web Tool Context',
      levelDescription: 'Web tool output was available for this response. It does not independently verify the answer.',
      badgeVariant: 'emerald',
      sources,
      hasSources: true,
      citationCount: sources.length
    };
  }

  if (hasVault) {
    return {
      level: 'local_repo_context',
      levelLabel: 'File Repo Context',
      levelDescription: 'File Repo excerpts or tool output were available for this response. They may not support every claim; inspect the sources.',
      badgeVariant: 'sky',
      sources,
      hasSources: true,
      citationCount: sources.length
    };
  }

  if (hasRag) {
    return {
      level: 'rag_context',
      levelLabel: 'Knowledge Base Context',
      levelDescription: 'Knowledge Base passages were available for this response. They may not support every claim; inspect the sources.',
      badgeVariant: 'indigo',
      sources,
      hasSources: true,
      citationCount: sources.length
    };
  }

  if (hasSystem) {
    return {
      level: 'system_context',
      levelLabel: 'System Tool Context',
      levelDescription: 'System or calculator tool output was available for this response. Check it against the answer.',
      badgeVariant: 'purple',
      sources,
      hasSources: true,
      citationCount: sources.length
    };
  }

  if (sources.length > 0) {
    return {
      level: 'model_links',
      levelLabel: 'Model-Provided Links',
      levelDescription: 'These links appeared in the model response and have not been independently checked.',
      badgeVariant: 'zinc',
      sources,
      hasSources: true,
      citationCount: sources.length
    };
  }

  return {
    level: 'parametric_model',
    levelLabel: 'Model Response',
    levelDescription: 'No source or tool output is recorded for this response. Check important claims independently.',
    badgeVariant: 'zinc',
    sources: [],
    hasSources: false,
    citationCount: 0
  };
}
