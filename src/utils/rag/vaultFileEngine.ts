// Unified File Repo Storage, Retrieval, Integrity Digest, and Matrix Extraction Engine
import {
  extractEndpointAndRouteTokens,
  extractQuantitativeTokens,
  isAsciiDigit,
  normalizeLineEndings,
  sanitizeFileName,
  scanSecurityPatternsLexical,
  splitLines,
  tokenizeWords
} from '../structuredParsers';
import type { VaultExcerptHit, VaultFileEntry, VaultMatrixColumn, VaultScopeMode } from './ragTypes';
import { isBinaryContent, isBinaryOrImageFile } from './binaryGuards';
import { computeDeterministicEmbedding, cosineSimilarity, estimateTokenCount } from './vectorEngine';

export function computeTextFingerprint(content: string): string {
  let h1 = 0xdeadbeef ^ content.length;
  let h2 = 0x41c6ce57 ^ content.length;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `${hex1}${hex2}`;
}

export function analyzeCodeAndSecurity(snippet: string): {
  lines: number;
  tokens: number;
  findings: string[];
} {
  const lines = splitLines(snippet).length;
  const tokens = estimateTokenCount(snippet);
  const scanned = scanSecurityPatternsLexical(snippet);
  const findings: string[] = [];

  for (const item of scanned) {
    if (item.ruleId === 'SEC-EVAL-01' && !findings.includes('Detected dynamic eval() call')) {
      findings.push('Detected dynamic eval() call');
    } else if (item.ruleId === 'SEC-XSS-02' && !findings.includes('Detected raw HTML injection sink')) {
      findings.push('Detected raw HTML injection sink');
    } else if (item.ruleId === 'SEC-SECRET-04' && !findings.includes('Detected hardcoded API key pattern')) {
      findings.push('Detected hardcoded API key pattern');
    } else if (item.ruleId === 'SEC-HTTP-05' && !findings.includes('Detected non-loopback plaintext HTTP URL')) {
      findings.push('Detected non-loopback plaintext HTTP URL');
    } else if (item.ruleId === 'SEC-CMD-03' && !findings.includes('Detected shell command execution call')) {
      findings.push('Detected shell command execution call');
    }
  }

  return { lines, tokens, findings };
}

export function createVaultFileEntry(input: {
  id?: string;
  fileName: string;
  relativePath?: string;
  content: string;
  collection?: string;
  mimeType?: string;
  pinnedInChat?: boolean;
  createdAt?: string;
  isBinary?: boolean;
  sizeBytes?: number;
}): VaultFileEntry {
  const cleanName = sanitizeFileName(input.fileName || 'untitled.txt');
  const dotIdx = cleanName.lastIndexOf('.');
  const ext = dotIdx > 0 ? cleanName.slice(dotIdx + 1).toLowerCase() : 'txt';
  const cleanContent = normalizeLineEndings(input.content || '');
  const isBinary = input.isBinary ?? isBinaryOrImageFile(cleanName, input.mimeType, cleanContent);
  const sizeBytes = input.sizeBytes || new TextEncoder().encode(cleanContent).length;
  const now = input.createdAt || new Date().toISOString();

  const isDescriptor =
    cleanContent.startsWith('[Binary Media:') ||
    cleanContent.startsWith('[Attached Binary Media:');
  const effectiveContent = isBinary && !isDescriptor
    ? `[Binary Media: ${cleanName} (${ext.toUpperCase()} · ${sizeBytes} bytes) - Stored in File Repo]`
    : cleanContent;

  return {
    id: input.id || `vfile_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    fileName: cleanName,
    ...(input.relativePath ? { relativePath: input.relativePath } : {}),
    fileExtension: ext,
    mimeType: input.mimeType || (isBinary ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'text/plain'),
    sizeBytes,
    collection: (input.collection || 'General').trim() || 'General',
    content: effectiveContent,
    sha256Preview: computeTextFingerprint(effectiveContent),
    tokenEstimate: isBinary ? 0 : estimateTokenCount(effectiveContent),
    pinnedInChat: input.pinnedInChat ?? true,
    createdAt: now,
    updatedAt: now,
    isBinary
  };
}

export function mutateVaultFile(
  files: VaultFileEntry[],
  id: string,
  updates: Partial<Omit<VaultFileEntry, 'id' | 'createdAt'>>
): VaultFileEntry[] {
  return files.map((file) => {
    if (file.id !== id) return file;
    const nextName =
      typeof updates.fileName === 'string' && updates.fileName.trim()
        ? sanitizeFileName(updates.fileName.trim())
        : file.fileName;
    const dotIdx = nextName.lastIndexOf('.');
    const nextExt = dotIdx > 0 ? nextName.slice(dotIdx + 1).toLowerCase() : file.fileExtension;
    const nextCollection =
      typeof updates.collection === 'string' && updates.collection.trim()
        ? updates.collection.trim()
        : file.collection;
    const rawContent =
      typeof updates.content === 'string'
        ? normalizeLineEndings(updates.content)
        : file.content;
    const nextMime = updates.mimeType || file.mimeType;
    const isBinary = updates.isBinary ?? isBinaryOrImageFile(nextName, nextMime, rawContent);
    const nextSize = updates.sizeBytes || new TextEncoder().encode(rawContent).length;
    const isDescriptor =
      rawContent.startsWith('[Binary Media:') ||
      rawContent.startsWith('[Attached Binary Media:');
    const nextContent = isBinary && !isDescriptor
      ? `[Binary Media: ${nextName} (${nextExt.toUpperCase()} · ${nextSize} bytes) - Stored in File Repo]`
      : rawContent;
    const nextPinned =
      typeof updates.pinnedInChat === 'boolean' ? updates.pinnedInChat : file.pinnedInChat;

    return {
      ...file,
      fileName: nextName,
      fileExtension: nextExt,
      mimeType: nextMime || (isBinary ? `image/${nextExt === 'jpg' ? 'jpeg' : nextExt}` : 'text/plain'),
      collection: nextCollection,
      content: nextContent,
      sizeBytes: nextSize,
      sha256Preview: computeTextFingerprint(nextContent),
      tokenEstimate: isBinary ? 0 : estimateTokenCount(nextContent),
      pinnedInChat: nextPinned,
      updatedAt: new Date().toISOString(),
      isBinary
    };
  });
}

function extractCompoundIdentifiers(text: string): string[] {
  const lower = text.toLowerCase();
  const delimiters = ' \t\r\n,;:()[]{}"\'`!?/|<>=';
  const result: string[] = [];
  let current = '';
  const flush = () => {
    if (current.length >= 4 && (current.includes('_') || current.includes('-')) && !result.includes(current)) {
      result.push(current);
    }
    current = '';
  };
  for (let i = 0; i < lower.length; i++) {
    if (delimiters.includes(lower[i])) flush();
    else current += lower[i];
  }
  flush();
  return result;
}

export function searchVaultFiles(
  query: string,
  files: VaultFileEntry[],
  topK: number = 4,
  scopeMode: VaultScopeMode = 'all',
  collectionFilter?: string,
  fileNameFilter?: string
): VaultExcerptHit[] {
  let candidateFiles =
    scopeMode === 'pinned' ? files.filter((f) => f.pinnedInChat) : files.slice();

  if (collectionFilter && collectionFilter.trim()) {
    const colLower = collectionFilter.trim().toLowerCase();
    candidateFiles = candidateFiles.filter((f) =>
      f.collection.toLowerCase().includes(colLower)
    );
  }
  if (fileNameFilter && fileNameFilter.trim()) {
    const fnLower = fileNameFilter.trim().toLowerCase();
    candidateFiles = candidateFiles.filter((f) =>
      f.fileName.toLowerCase().includes(fnLower)
    );
  }

  if (candidateFiles.length === 0 || topK <= 0) return [];

  const trimmedQuery = query.trim();
  const queryVec = computeDeterministicEmbedding(trimmedQuery || 'summary overview', 64);
  const queryTerms = Array.from(new Set(tokenizeWords(trimmedQuery, 3)));
  const compoundIds = extractCompoundIdentifiers(trimmedQuery);

  const hits: VaultExcerptHit[] = [];

  for (const file of candidateFiles) {
    if (
      file.isBinary ||
      isBinaryOrImageFile(file.fileName, file.mimeType, file.content) ||
      file.content.startsWith('[Binary Media:') ||
      file.content.startsWith('[Attached Binary Media:')
    ) {
      continue;
    }
    const lines = splitLines(file.content);
    const linesPerSegment = 14;
    const step = 10;

    for (let startLine = 0; startLine < Math.max(1, lines.length); startLine += step) {
      const sliceLines = lines.slice(startLine, startLine + linesPerSegment);
      const excerpt = sliceLines.join('\n').trim();
      if (!excerpt) continue;

      const endLine = Math.min(lines.length, startLine + sliceLines.length);
      const lineRange = `L${startLine + 1}-L${endLine}`;
      const composite = `${file.fileName} (${file.collection}): ${excerpt}`;
      const segVec = computeDeterministicEmbedding(composite, 64);
      const denseSim = cosineSimilarity(queryVec, segVec);

      const haystack = composite.toLowerCase();
      let matchedTerms = 0;
      for (const term of queryTerms) {
        if (haystack.includes(term)) matchedTerms++;
      }
      let matchedCompound = 0;
      for (const cid of compoundIds) {
        if (haystack.includes(cid)) matchedCompound++;
      }
      const lexicalScore = queryTerms.length > 0 ? matchedTerms / queryTerms.length : 0.25;
      if (queryTerms.length > 0 && matchedTerms === 0 && matchedCompound === 0) continue;
      const compoundBoost = compoundIds.length > 0 ? (matchedCompound / compoundIds.length) * 0.35 : 0;
      const pinBoost = file.pinnedInChat ? 0.04 : 0;
      const score = Number(
        Math.min(0.99, Math.max(0.05, denseSim * 0.45 + lexicalScore * 0.42 + compoundBoost + pinBoost)).toFixed(4)
      );

      hits.push({
        chunkId: `${file.id}_${lineRange}`,
        fileId: file.id,
        fileName: file.relativePath || file.fileName,
        collection: file.collection,
        lineRange,
        excerpt,
        similarityScore: score,
        sha256Preview: file.sha256Preview
      });

      if (startLine + linesPerSegment >= lines.length) break;
    }
  }

  hits.sort((a, b) => b.similarityScore - a.similarityScore);
  return hits.slice(0, topK);
}

function stripLeadingListMarkers(line: string): string {
  let idx = 0;
  while (
    idx < line.length &&
    (line[idx] === '-' ||
      line[idx] === '*' ||
      line[idx] === '#' ||
      line[idx] === '>' ||
      line[idx] === '.' ||
      isAsciiDigit(line[idx]) ||
      line[idx] === ' ')
  ) {
    idx++;
  }
  return line.slice(idx).trim();
}

export function extractVaultMatrixCell(
  file: VaultFileEntry,
  column: VaultMatrixColumn
): string {
  if (
    file.isBinary ||
    isBinaryOrImageFile(file.fileName, file.mimeType, file.content) ||
    file.content.startsWith('[Binary Media:') ||
    file.content.startsWith('[Attached Binary Media:')
  ) {
    return `${file.fileName} (${file.fileExtension.toUpperCase()} · ${file.sizeBytes} B · Binary Media)`;
  }
  const ruleLower = `${column.header} ${column.extractionRule}`.toLowerCase();
  const lines = splitLines(file.content)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return 'Empty file';

  if (
    ruleLower.includes('quantitative') ||
    ruleLower.includes('metric') ||
    ruleLower.includes('number') ||
    ruleLower.includes('numeric') ||
    ruleLower.includes('limit') ||
    ruleLower.includes('threshold') ||
    ruleLower.includes('budget')
  ) {
    const uniqueQuant = extractQuantitativeTokens(file.content);
    if (uniqueQuant.length > 0) {
      return uniqueQuant.slice(0, 5).join(' · ');
    }
    return `${file.sizeBytes} B · ~${file.tokenEstimate} tokens · ${lines.length} lines`;
  }

  if (
    ruleLower.includes('endpoint') ||
    ruleLower.includes('url') ||
    ruleLower.includes('port') ||
    ruleLower.includes('api') ||
    ruleLower.includes('entity') ||
    ruleLower.includes('entities')
  ) {
    const combined = extractEndpointAndRouteTokens(file.content);
    if (combined.length > 0) {
      return combined.slice(0, 5).join(' · ');
    }
  }

  if (
    ruleLower.includes('security') ||
    ruleLower.includes('risk') ||
    ruleLower.includes('constraint') ||
    ruleLower.includes('policy') ||
    ruleLower.includes('obligation') ||
    ruleLower.includes('audit')
  ) {
    const audit = analyzeCodeAndSecurity(file.content);
    const securityKeywords = [
      'must',
      'never',
      'strictly',
      'block',
      'reject',
      'encrypt',
      'verify',
      'only',
      'require',
      'guard',
      'loopback',
      'pbkdf2',
      'aes'
    ];
    const matchingLines = lines.filter((l) => {
      const lowerLine = l.toLowerCase();
      return securityKeywords.some((kw) => lowerLine.includes(kw));
    });
    if (audit.findings.length > 0) {
      return `Alerts: ${audit.findings.join('; ')}`;
    }
    if (matchingLines.length > 0) {
      return matchingLines
        .slice(0, 2)
        .map((l) => stripLeadingListMarkers(l))
        .join(' | ')
        .slice(0, 220);
    }
  }

  const hits = searchVaultFiles(column.extractionRule || column.header, [file], 1, 'all');
  if (hits.length > 0) {
    const cleanExcerpt = splitLines(hits[0].excerpt)
      .map((l) => stripLeadingListMarkers(l))
      .filter(Boolean)
      .slice(0, 2)
      .join(' - ');
    return `${cleanExcerpt.slice(0, 200)} (${hits[0].lineRange})`;
  }

  return lines[0].slice(0, 180);
}
