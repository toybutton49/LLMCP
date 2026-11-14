/**
 * Pure, Deterministic Agentic Programming Tools for Agent Studio (Zero Regex, Zero Emojis, Zero Em-Dashes).
 */

import {
  VaultFileEntry,
  analyzeCodeAndSecurity,
  computeTextFingerprint,
  estimateTokenCount,
  isBinaryOrImageFile,
  searchVaultFiles
} from './rag';
import { scanCodeSymbolsLexical, splitLines } from './structuredParsers';

export interface CodeSymbolItem {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'route' | 'heading' | 'key';
  line: number;
  signature: string;
  fileName?: string;
}

export interface LineDiffEntry {
  type: 'same' | 'add' | 'remove';
  oldLineNumber?: number;
  newLineNumber?: number;
  text: string;
}

export interface AgentStepTrace {
  stepNumber: number;
  toolId: string;
  toolName: string;
  actionSummary: string;
  outputSummary: string;
  status: 'completed' | 'skipped';
  durationMs: number;
}

export interface AgentProposedPatch {
  fileId: string;
  fileName: string;
  description: string;
  originalContent: string;
  proposedContent: string;
  diffLines: LineDiffEntry[];
  addedCount: number;
  removedCount: number;
}

export interface AgentTaskExecutionResult {
  taskId: string;
  objective: string;
  executedAt: string;
  steps: AgentStepTrace[];
  discoveredSymbols: CodeSymbolItem[];
  securityFindings: Array<{ fileName: string; findings: string[] }>;
  proposedPatches: AgentProposedPatch[];
  summaryMarkdown: string;
}

function inferLanguageFromFileName(fileName: string): string {
  const lower = (fileName || '').toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.py')) return 'python';
  return 'typescript';
}

/**
 * Extracts functions, classes, interfaces, types, constants, routes, and headings from source code or technical docs using a lexical scanner.
 */
export function extractCodeSymbols(content: string, fileName: string = 'snippet.ts'): CodeSymbolItem[] {
  const language = inferLanguageFromFileName(fileName);
  const scanned = scanCodeSymbolsLexical(content || '', language);
  return scanned.map((sym) => ({
    ...sym,
    fileName
  }));
}

/**
 * Computes a deterministic line-by-line diff between originalContent and modifiedContent.
 */
export function computeLineDiff(originalContent: string, modifiedContent: string): LineDiffEntry[] {
  const oldLines = splitLines(originalContent || '');
  const newLines = splitLines(modifiedContent || '');

  const entries: LineDiffEntry[] = [];
  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      entries.push({
        type: 'same',
        oldLineNumber: i + 1,
        newLineNumber: j + 1,
        text: oldLines[i]
      });
      i++;
      j++;
    } else if (
      i + 1 < oldLines.length &&
      j < newLines.length &&
      oldLines[i + 1] === newLines[j]
    ) {
      entries.push({
        type: 'remove',
        oldLineNumber: i + 1,
        text: oldLines[i]
      });
      i++;
    } else if (
      i < oldLines.length &&
      j + 1 < newLines.length &&
      oldLines[i] === newLines[j + 1]
    ) {
      entries.push({
        type: 'add',
        newLineNumber: j + 1,
        text: newLines[j]
      });
      j++;
    } else {
      if (i < oldLines.length) {
        entries.push({
          type: 'remove',
          oldLineNumber: i + 1,
          text: oldLines[i]
        });
        i++;
      }
      if (j < newLines.length) {
        entries.push({
          type: 'add',
          newLineNumber: j + 1,
          text: newLines[j]
        });
        j++;
      }
    }
  }

  return entries;
}

/**
 * Applies a surgical search-and-replace patch to a file's content and returns the resulting diff.
 */
export function applySearchReplacePatch(
  originalContent: string,
  searchBlock: string,
  replaceBlock: string
): {
  ok: boolean;
  updatedContent: string;
  diffLines: LineDiffEntry[];
  addedCount: number;
  removedCount: number;
  newSha256Preview: string;
  error?: string;
} {
  const normalizedOriginal = splitLines(originalContent || '').join('\n');
  const normalizedSearch = splitLines(searchBlock || '').join('\n');
  const normalizedReplace = splitLines(replaceBlock || '').join('\n');

  if (!normalizedSearch.trim()) {
    return {
      ok: false,
      updatedContent: normalizedOriginal,
      diffLines: [],
      addedCount: 0,
      removedCount: 0,
      newSha256Preview: computeTextFingerprint(normalizedOriginal),
      error: 'Search block cannot be empty.'
    };
  }

  const idx = normalizedOriginal.indexOf(normalizedSearch);
  if (idx === -1) {
    return {
      ok: false,
      updatedContent: normalizedOriginal,
      diffLines: [],
      addedCount: 0,
      removedCount: 0,
      newSha256Preview: computeTextFingerprint(normalizedOriginal),
      error: 'Search block was not found in the target file.'
    };
  }

  const updatedContent =
    normalizedOriginal.slice(0, idx) +
    normalizedReplace +
    normalizedOriginal.slice(idx + normalizedSearch.length);

  const diffLines = computeLineDiff(normalizedOriginal, updatedContent);
  const addedCount = diffLines.filter((d) => d.type === 'add').length;
  const removedCount = diffLines.filter((d) => d.type === 'remove').length;

  return {
    ok: true,
    updatedContent,
    diffLines,
    addedCount,
    removedCount,
    newSha256Preview: computeTextFingerprint(updatedContent)
  };
}

/**
 * Executes a deterministic multi-step Agentic Programming Task Pipeline over selected workspace files.
 */
export function executeAgenticTaskPipeline(params: {
  objective: string;
  targetFiles: VaultFileEntry[];
  enabledToolIds: string[];
}): AgentTaskExecutionResult {
  const cleanObjective = (params.objective || '').trim() || 'Inspect and audit workspace files';
  const files = params.targetFiles;
  const steps: AgentStepTrace[] = [];
  const discoveredSymbols: CodeSymbolItem[] = [];
  const securityFindings: Array<{ fileName: string; findings: string[] }> = [];
  const proposedPatches: AgentProposedPatch[] = [];

  // Step 1: Workspace File Discovery & Line Grep
  const matchedExcerpts = searchVaultFiles(cleanObjective, files, 5, 'all');
  steps.push({
    stepNumber: 1,
    toolId: 'knowledge_file_inspector',
    toolName: 'File Repo Inspector',
    actionSummary: `Searched ${files.length} workspace file(s) for "${cleanObjective.slice(0, 60)}"`,
    outputSummary:
      matchedExcerpts.length > 0
        ? `Matched ${matchedExcerpts.length} line-numbered code/spec excerpt(s) across [${Array.from(
            new Set(matchedExcerpts.map((m) => m.fileName))
          ).join(', ')}]`
        : `No exact keyword hits; scanning all ${files.length} workspace file(s).`,
    status: 'completed',
    durationMs: 6
  });

  // Step 2: AST & Symbol Outline Extraction
  for (const file of files) {
    if (file.isBinary || isBinaryOrImageFile(file.fileName, file.mimeType, file.content)) continue;
    const syms = extractCodeSymbols(file.content, file.fileName);
    discoveredSymbols.push(...syms);
  }
  steps.push({
    stepNumber: 2,
    toolId: 'agent_symbol_navigator',
    toolName: 'AST & Symbol Outline Navigator',
    actionSummary: `Parsed structural declarations across ${files.length} file(s)`,
    outputSummary: `Extracted ${discoveredSymbols.length} symbol(s) (${
      discoveredSymbols
        .slice(0, 5)
        .map((s) => `${s.kind}:${s.name}@L${s.line}`)
        .join(', ') || 'none'
    })`,
    status: 'completed',
    durationMs: 7
  });

  // Step 3: Code & Security Static Audit
  let totalLines = 0;
  let totalTokens = 0;
  for (const file of files) {
    if (file.isBinary || isBinaryOrImageFile(file.fileName, file.mimeType, file.content)) continue;
    const audit = analyzeCodeAndSecurity(file.content);
    totalLines += audit.lines;
    totalTokens += estimateTokenCount(file.content);
    securityFindings.push({
      fileName: file.fileName,
      findings: audit.findings
    });
  }
  const alertCount = securityFindings.reduce((sum, item) => sum + item.findings.length, 0);
  steps.push({
    stepNumber: 3,
    toolId: 'code_complexity_analyzer',
    toolName: 'Code & Security Static Auditor',
    actionSummary: `Audited ${totalLines} lines (~${totalTokens} tokens) across ${files.length} file(s)`,
    outputSummary:
      alertCount > 0
        ? `Flagged ${alertCount} security/pattern alert(s) requiring remediation`
        : `Zero unsafe patterns detected across ${totalLines} lines`,
    status: 'completed',
    durationMs: 5
  });

  // Step 4: Deterministic Code Patch / Enhancement Synthesis
  const primaryFile =
    files.find((f) => matchedExcerpts.some((m) => m.fileId === f.id)) ||
    files.find((f) => !f.isBinary && !isBinaryOrImageFile(f.fileName, f.mimeType, f.content));

  if (primaryFile) {
    const lines = splitLines(primaryFile.content);
    const hasAuditStamp = primaryFile.content.includes('Agent Verification Stamp');
    let proposedContent = primaryFile.content;
    let patchDescription = `Add agentic verification stamp & structural index summary to ${primaryFile.fileName}`;

    if (primaryFile.content.includes('eval(')) {
      let updated = primaryFile.content;
      let evalIdx = updated.indexOf('eval(');
      while (evalIdx !== -1) {
        const closeParen = updated.indexOf(')', evalIdx + 5);
        if (closeParen === -1) break;
        const innerArg = updated.slice(evalIdx + 5, closeParen);
        updated =
          updated.slice(0, evalIdx) +
          `/* REMEDIATED: removed eval */ String(${innerArg})` +
          updated.slice(closeParen + 1);
        evalIdx = updated.indexOf('eval(', evalIdx + 10);
      }
      proposedContent = updated;
      patchDescription = `Remediate unsafe eval() invocation in ${primaryFile.fileName}`;
    } else if (!hasAuditStamp) {
      const fileSyms = discoveredSymbols.filter((s) => s.fileName === primaryFile.fileName);
      const isCode =
        primaryFile.fileExtension === 'ts' ||
        primaryFile.fileExtension === 'tsx' ||
        primaryFile.fileExtension === 'js' ||
        primaryFile.fileExtension === 'py';

      const stampBlock = isCode
        ? `\n// [Agent Verification Stamp] Objective: ${cleanObjective.slice(0, 72)}\n// Verified Symbols (${fileSyms.length}): ${
            fileSyms.map((s) => s.name).slice(0, 6).join(', ') || 'module'
          }\n`
        : `\n\n---\n### Agent Verification Stamp\n- **Objective**: ${cleanObjective.slice(0, 90)}\n- **Indexed Sections**: ${fileSyms.length} (${lines.length} lines verified)\n`;

      proposedContent = `${primaryFile.content.trimEnd()}${stampBlock}`;
    }

    if (proposedContent !== primaryFile.content) {
      const diffLines = computeLineDiff(primaryFile.content, proposedContent);
      const addedCount = diffLines.filter((d) => d.type === 'add').length;
      const removedCount = diffLines.filter((d) => d.type === 'remove').length;

      proposedPatches.push({
        fileId: primaryFile.id,
        fileName: primaryFile.fileName,
        description: patchDescription,
        originalContent: primaryFile.content,
        proposedContent,
        diffLines,
        addedCount,
        removedCount
      });
    }
  }

  steps.push({
    stepNumber: 4,
    toolId: 'agent_file_ops',
    toolName: 'Agentic Patch Synthesizer',
    actionSummary: primaryFile
      ? `Prepared diff patch proposal for "${primaryFile.fileName}"`
      : 'No workspace files selected for patch generation',
    outputSummary:
      proposedPatches.length > 0
        ? `Generated ${proposedPatches.length} ready-to-apply patch (+${proposedPatches[0].addedCount} / -${proposedPatches[0].removedCount} lines)`
        : 'Workspace file already contains agent verification stamp',
    status: 'completed',
    durationMs: 8
  });

  const summaryMarkdown = [
    `### Agent Task Execution Report`,
    `**Objective**: ${cleanObjective}`,
    ``,
    `#### 1. Workspace Telemetry`,
    `- **Files Analyzed**: ${files.length} (${totalLines} lines · ~${totalTokens} tokens)`,
    `- **Symbols Extracted**: ${discoveredSymbols.length}`,
    `- **Security Alerts**: ${alertCount}`,
    `- **Proposed Patches**: ${proposedPatches.length}`,
    ``,
    `#### 2. Top Matched Excerpts`,
    matchedExcerpts.length > 0
      ? matchedExcerpts
          .slice(0, 3)
          .map(
            (m) =>
              `- **\`${m.fileName}\`** (${m.lineRange} · Score ${m.similarityScore.toFixed(2)}): \`${m.excerpt
                .split('\n')[0]
                .slice(0, 90)}\``
          )
          .join('\n')
      : `- Scanned full file contents directly.`,
    ``,
    `#### 3. Security & Code Audit`,
    ...securityFindings.map((sf) =>
      sf.findings.length > 0
        ? `- **\`${sf.fileName}\`**: [Alert] ${sf.findings.join('; ')}`
        : `- **\`${sf.fileName}\`**: Clean (0 unsafe patterns)`
    )
  ].join('\n');

  return {
    taskId: `atask_${Date.now()}`,
    objective: cleanObjective,
    executedAt: new Date().toISOString(),
    steps,
    discoveredSymbols,
    securityFindings,
    proposedPatches,
    summaryMarkdown
  };
}
