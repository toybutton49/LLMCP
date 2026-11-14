// Read-only File Repo Inspector, Code Auditor & Memory Prober Tool
import type { HotSwappableToolPlugin, ToolDirectCallContext } from '../types';
import { collapseWhitespace, scanCodeSymbolsLexical, splitLines } from '../../utils/structuredParsers';
import {
  buildVectorIndex,
  searchVectorIndex
} from '../../utils/rag/vectorEngine';
import { analyzeCodeAndSecurity, searchVaultFiles } from '../../utils/rag/vaultFileEngine';
import { isBinaryOrImageFile } from '../../utils/rag/binaryGuards';
import { probeDatabaseMemory } from '../../utils/memory';
import type { ToolInvocationResult } from '../../utils/rag/ragTypes';

export const agentFileOpsPlugin: HotSwappableToolPlugin = {
  aliases: [
    'filesystem',
    'mcp_filesystem',
    'file_repo_inspector',
    'agent_code_auditor',
    'memory_prober',
    'read_file',
    'list_directory',
    'directory_tree',
    'search_files'
  ],
  definition: {
    id: 'agent_file_ops',
    name: 'File Repo Inspector, Auditor & Memory Prober',
    category: 'File Repo',
    description:
      'Read-only workspace tool: reads, lists, and searches files in File Repo, extracts symbols, audits code security, and probes database memory. It cannot create, modify, or move files.',
    parameterSummary:
      'action?: "read" | "list_directory" | "directory_tree" | "search_files" | "symbols" | "audit" | "probe_memory", query?: string, fileName?: string, code?: string, topK?: number'
  },
  schema: {
    name: 'agent_file_ops',
    description: 'Inspect files, analyze code, or probe workspace memory.',
    parameters: {
    type: 'OBJECT',
    properties: {
      action: {
        type: 'STRING',
        description:
          'Operation: "read"/"list_directory"/"directory_tree"/"search_files" for File Repo, "symbols" or "audit" for code analysis, or "probe_memory" for memory probing. This tool is read-only.'
      },
      query: {
        type: 'STRING',
        description: 'File name, search query, or natural-language memory probe.'
      },
      fileName: {
        type: 'STRING',
        description: 'Target file name in File Repo.'
      },
      code: {
        type: 'STRING',
        description: 'Source code snippet to audit or extract symbols from.'
      },
      scope: {
        type: 'STRING',
        description: 'Memory scope when action is "probe_memory".'
      },
      topK: {
        type: 'NUMBER',
        description: 'Maximum results to return (default 4).'
      }
    },
    required: []
    }
  },
  invokeDirect: (args, ctx) => {
    const start = Date.now();
    return { ...executeFileOps(args, ctx), durationMs: Date.now() - start };
  }
};

function resolveTargetVaultFile(
  vaultFiles: NonNullable<ToolDirectCallContext['vaultFiles']>,
  explicitFileName: string,
  rawQuery: string
): { file?: NonNullable<ToolDirectCallContext['vaultFiles']>[number]; residualQuery: string } {
  if (explicitFileName) {
    const lower = explicitFileName.toLowerCase();
    const exact = vaultFiles.find((f) => f.fileName.toLowerCase() === lower) ||
      vaultFiles.find((f) => f.fileName.toLowerCase().includes(lower));
    const cleaned = exact
      ? rawQuery.split(exact.fileName).join(' ').split(explicitFileName).join(' ').trim()
      : rawQuery;
    return { file: exact, residualQuery: cleaned };
  }
  const lowerQ = rawQuery.toLowerCase();
  const sorted = vaultFiles.slice().sort((a, b) => b.fileName.length - a.fileName.length);
  for (const candidate of sorted) {
    const fnLower = candidate.fileName.toLowerCase();
    const idx = lowerQ.indexOf(fnLower);
    if (idx !== -1) {
      const residual = `${rawQuery.slice(0, idx)} ${rawQuery.slice(idx + candidate.fileName.length)}`.trim();
      return { file: candidate, residualQuery: residual };
    }
  }
  return { file: undefined, residualQuery: rawQuery };
}

function findMatchingLinesInFile(content: string, termsText: string, maxLines = 25): string[] {
  const lines = splitLines(content);
  const rawParts = termsText.toLowerCase().split(' ').map((p) => p.trim()).filter((p) => p.length >= 3);
  if (rawParts.length === 0 || lines.length === 0) return [];
  const compound = rawParts.filter((p) => p.includes('_') || p.includes('-') || p.length >= 5);
  const probes = compound.length > 0 ? compound : rawParts;
  const matched: string[] = [];
  if (lines[0] && (lines[0].includes(',') || lines[0].includes('\t'))) {
    matched.push(`L1 (header): ${lines[0]}`);
  }
  for (let i = 0; i < lines.length; i++) {
    const lowerLine = lines[i].toLowerCase();
    if (probes.some((p) => lowerLine.includes(p))) {
      const entry = `L${i + 1}: ${lines[i]}`;
      if (!matched.includes(entry)) matched.push(entry);
      if (matched.length >= maxLines) break;
    }
  }
  return matched.length > (matched[0]?.startsWith('L1 (header):') ? 1 : 0) ? matched : [];
}

function executeFileOps(args: Record<string, unknown>, ctx: ToolDirectCallContext): Omit<ToolInvocationResult, 'durationMs'> {
    const vaultFiles = ctx.vaultFiles || [];
    const vectorIndex = ctx.vectorIndex || [];
    const rawAction = String(args.action || '').toLowerCase();
    const explicitFileName = typeof args.fileName === 'string' ? args.fileName.trim() : '';
    const rawQuery = String(args.query || args.path || args.input || args.prompt || '').trim();
    const query = (rawQuery || explicitFileName).trim();
    const code = (typeof args.code === 'string' ? args.code : typeof args.content === 'string' ? args.content : '').trim();
    const topK = Math.min(8, Math.max(1, Number(args.topK) || 4));

    // 1. Memory Probing Mode
    if (
      rawAction === 'probe_memory' ||
      (rawAction === '' && query.toLowerCase().includes('memory'))
    ) {
      const probeQ = query || 'project architecture directives';
      const scopeRaw = String(args.scope || 'all').toLowerCase();
      const scope =
        scopeRaw === 'memories' || scopeRaw === 'conversations' ? scopeRaw : 'all';
      const result = probeDatabaseMemory({
        query: probeQ,
        memories: ctx.memories || [],
        messagesBySession: ctx.messagesBySession || {},
        sessions: ctx.sessions || [],
        currentSessionId: ctx.currentSessionId,
        scope,
        topK
      });
      const hitSummary =
        result.hits.length > 0
          ? result.hits
              .map(
                (h, i) =>
                  `${i + 1}. ${
                    h.type === 'conversation_turn'
                      ? `[Turn: ${h.sourceSessionTitle}]`
                      : `[Directive: ${h.title}]`
                  } (score ${h.similarityScore.toFixed(2)}): "${h.content.slice(0, 140)}"`
              )
              .join(' | ')
          : `Zero memory hits for "${probeQ}".`;
      return {
        pluginId: 'agent_file_ops',
        pluginName: 'File Repo Inspector, Auditor & Memory Prober',
        inputSummary: `probe_memory("${probeQ.slice(0, 48)}", scope=${scope})`,
        outputSummary: `Scanned ${result.totalRecordsScanned} record(s) in ${result.durationMs}ms -> ${hitSummary}`
      };
    }

    // 2. Code Security Audit or Symbol Extraction Mode. Free-text queries never trigger audits;
    // code is analysed only when explicitly requested or when it is the sole argument.
    if (rawAction === 'audit' || rawAction === 'symbols' || (rawAction === '' && code && !query && !args.fileName)) {
      const selectedName = typeof args.fileName === 'string' ? args.fileName.trim() : query;
      const selectedFile = selectedName
        ? vaultFiles.find((file) => file.fileName.toLowerCase() === selectedName.toLowerCase())
        : undefined;
      const source = code || (selectedFile && !selectedFile.isBinary &&
        !isBinaryOrImageFile(selectedFile.fileName, selectedFile.mimeType, selectedFile.content)
        ? selectedFile.content : '');
      if (!source.trim()) {
        return {
          pluginId: 'agent_file_ops',
          pluginName: 'File Repo Inspector, Auditor & Memory Prober',
          inputSummary: `${rawAction || 'audit'}(${query || 'no source'})`,
          outputSummary: 'No readable source supplied. Provide source code or the exact name of a nonempty text file in File Repo.'
        };
      }
      const symbols = scanCodeSymbolsLexical(source, 'typescript');
      const issues = analyzeCodeAndSecurity(source).findings;
      const symText =
        symbols.length > 0
          ? `Symbols (${symbols.length}): ${symbols
              .slice(0, 8)
              .map((s) => `${s.kind} ${s.name}`)
              .join(', ')}`
          : 'No top-level declarations detected';
      const issueText =
        issues.length > 0
          ? `Security findings from a limited lexical scan (${issues.length}): ${issues.join(' | ')}`
          : 'No known patterns found in this limited lexical scan; this is not a security guarantee';
      return {
        pluginId: 'agent_file_ops',
        pluginName: 'File Repo Inspector, Auditor & Memory Prober',
        inputSummary: `${rawAction || 'audit'}(${code ? 'supplied code' : selectedFile?.fileName}, ${source.length} chars)`,
        outputSummary: `${symText}. ${issueText}.`
      };
    }

    // 3. List Directory / Directory Tree Mode
    if (rawAction === 'list_directory' || rawAction === 'directory_tree') {
      const files = vaultFiles;
      const listing =
        files.length > 0
          ? files
              .map((f) => `${f.fileName} (${f.collection || 'General'}, ${f.sizeBytes}B)`)
              .join(', ')
          : '(File Repo is empty)';
      return {
        pluginId: 'agent_file_ops',
        pluginName: 'File Repo Inspector, Auditor & Memory Prober',
        inputSummary: `${rawAction}("${query || '.local-data/file-repo'}")`,
        outputSummary: `File Repo (${files.length} files): ${listing}`
      };
    }

    // 4. Default: File Repo Read & Search Mode
    const { file: targetFile, residualQuery } = resolveTargetVaultFile(vaultFiles, explicitFileName, rawQuery);
    const searchQ = (residualQuery || query || 'architecture').trim();
    const binaryCheckTarget = targetFile || vaultFiles.find((file) => file.fileName.toLowerCase() === searchQ.toLowerCase());
    if (binaryCheckTarget && (binaryCheckTarget.isBinary || isBinaryOrImageFile(binaryCheckTarget.fileName, binaryCheckTarget.mimeType, binaryCheckTarget.content))) {
      return {
        pluginId: 'agent_file_ops',
        pluginName: 'File Repo Inspector, Auditor & Memory Prober',
        inputSummary: `read("${binaryCheckTarget.fileName}")`,
        outputSummary: `Binary media file "${binaryCheckTarget.fileName}" cannot be displayed as plain text.`
      };
    }

    // Direct whole-file read when a specific readable file is named without narrowing search terms
    if (targetFile && (!residualQuery || rawAction === 'read' && !rawQuery)) {
      const lines = splitLines(targetFile.content);
      const numbered = lines.map((line, idx) => `L${idx + 1}: ${line}`).join('\n');
      const maxReadChars = 2800;
      const body = numbered.length > maxReadChars
        ? `${numbered.slice(0, maxReadChars)}\n... [truncated at ${maxReadChars} of ${numbered.length} chars; pass query terms to filter specific sections/rows]`
        : numbered;
      return {
        pluginId: 'agent_file_ops',
        pluginName: 'File Repo Inspector, Auditor & Memory Prober',
        inputSummary: `read("${targetFile.fileName}", ${lines.length} lines)`,
        outputSummary: `[File: ${targetFile.fileName} (${lines.length} lines)]\n${body}`
      };
    }

    const directLineHits = targetFile && residualQuery
      ? findMatchingLinesInFile(targetFile.content, residualQuery, 15)
      : [];
    const vaultHits = directLineHits.length >= 2 ? [] : searchVaultFiles(
      searchQ,
      vaultFiles,
      topK,
      'all',
      undefined,
      targetFile?.fileName || (explicitFileName || undefined)
    );
    const ragHits = targetFile ? [] : searchVectorIndex(
      searchQ,
      vectorIndex,
      topK,
      0.04,
      ctx.distanceMetric
    );

    const summaries: string[] = [];
    if (directLineHits.length > 0 && targetFile) {
      summaries.push(`[Exact line matches in ${targetFile.fileName}]\n${directLineHits.join('\n')}`);
    }
    for (const vh of vaultHits) {
      summaries.push(
        `[File: ${vh.fileName} · ${vh.lineRange} (score ${vh.similarityScore.toFixed(2)})]\n${vh.excerpt.slice(0, 500)}`
      );
    }
    for (const rh of ragHits) {
      summaries.push(
        `[Note: ${rh.docTitle}#${rh.chunkIndex} (score ${rh.similarityScore.toFixed(2)})] "${collapseWhitespace(rh.text).slice(0, 320)}"`
      );
    }

    const labelTarget = targetFile ? `${targetFile.fileName}: ${residualQuery}` : searchQ;
    const joinedSummary = summaries.slice(0, topK + 1).join('\n---\n');
    const boundedSummary = joinedSummary.length > 2400 ? `${joinedSummary.slice(0, 2400)}\n... [truncated]` : joinedSummary;
    return {
      pluginId: 'agent_file_ops',
      pluginName: 'File Repo Inspector, Auditor & Memory Prober',
      inputSummary: `${rawAction || 'read'}("${labelTarget.slice(0, 56)}", topK=${topK})`,
      outputSummary:
        summaries.length > 0
          ? `Matched ${summaries.length} item(s):\n${boundedSummary}`
          : `File Repo is empty or no matches for "${labelTarget}".`
    };
}

export function createDefaultDiagnosticIndex() {
  return buildVectorIndex([], 420, 60);
}
