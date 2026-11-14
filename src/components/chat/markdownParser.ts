import React from 'react';
import { splitLines } from '../../utils/structuredParsers';

export interface FenceSegment {
  type: 'text' | 'code';
  lang: string;
  body: string;
}

export type TableColumnAlign = 'left' | 'center' | 'right';

export interface MarkdownTableBlock {
  header: string[];
  alignments: TableColumnAlign[];
  rows: string[][];
}

export interface ListItemEntry {
  indentLevel: number;
  orderedPrefix: string | null;
  text: string;
}

export type ParsedMarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'blockquote'; lines: string[]; isCallout: boolean }
  | { kind: 'list'; items: ListItemEntry[] }
  | { kind: 'table'; table: MarkdownTableBlock }
  | { kind: 'hr' };

export interface MarkdownSectionGroup {
  title: string | null;
  isSourcesSection: boolean;
  blocks: ParsedMarkdownBlock[];
}

export function parseFencedSegments(raw: string): FenceSegment[] {
  const segments: FenceSegment[] = [];
  let cursor = 0;

  while (cursor < raw.length) {
    const openFence = raw.indexOf('```', cursor);
    if (openFence === -1) {
      segments.push({ type: 'text', lang: '', body: raw.slice(cursor) });
      break;
    }

    if (openFence > cursor) {
      segments.push({ type: 'text', lang: '', body: raw.slice(cursor, openFence) });
    }

    const lineEnd = raw.indexOf('\n', openFence + 3);
    if (lineEnd === -1) {
      segments.push({ type: 'text', lang: '', body: raw.slice(openFence) });
      break;
    }

    const lang = raw.slice(openFence + 3, lineEnd).trim() || 'code';
    const closeFence = raw.indexOf('```', lineEnd + 1);
    if (closeFence === -1) {
      segments.push({ type: 'code', lang, body: raw.slice(lineEnd + 1) });
      break;
    }

    const rawSlice = raw.slice(lineEnd + 1, closeFence);
    segments.push({
      type: 'code',
      lang,
      body: rawSlice.endsWith('\n') ? rawSlice.slice(0, -1) : rawSlice
    });
    cursor = closeFence + 3;
  }

  return segments;
}

export function stripOuterBoldMarkers(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length > 4 && trimmed.startsWith('**') && trimmed.endsWith('**')) {
    const inner = trimmed.slice(2, -2).trim();
    if (!inner.includes('**')) {
      return inner;
    }
  }
  return trimmed;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isCitationBracketLabel(label: string): boolean {
  const trimmed = label.trim();
  if (trimmed.length < 2 || trimmed.length > 52) return false;
  if (trimmed.includes('\n') || trimmed.includes('[') || trimmed.includes(']')) return false;
  let hasLetter = false;
  for (let i = 0; i < trimmed.length; i++) {
    if (isAsciiLetter(trimmed.charCodeAt(i))) {
      hasLetter = true;
      break;
    }
  }
  return hasLetter;
}

export function renderInlineTokens(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let plainStart = 0;
  let keyCounter = 0;
  const flushPlain = (end: number) => {
    if (end > plainStart) {
      nodes.push(React.createElement('span', { key: keyCounter++ }, text.slice(plainStart, end)));
    }
  };

  while (i < text.length) {
    if (text[i] === '`') {
      const closeTick = text.indexOf('`', i + 1);
      if (closeTick !== -1) {
        flushPlain(i);
        nodes.push(React.createElement('code', {
          key: keyCounter++,
          className: 'px-1.5 py-0.5 mx-0.5 text-[12px] font-mono rounded-md bg-stone-200/75 dark:bg-zinc-800/90 text-accent border border-stone-300/70 dark:border-zinc-700/70'
        }, text.slice(i + 1, closeTick)));
        i = closeTick + 1;
        plainStart = i;
        continue;
      }
    }

    if (text[i] === '*' && i + 1 < text.length && text[i + 1] === '*') {
      const closeBold = text.indexOf('**', i + 2);
      if (closeBold !== -1) {
        flushPlain(i);
        nodes.push(React.createElement('strong', {
          key: keyCounter++,
          className: 'font-semibold text-zinc-950 dark:text-stone-100'
        }, renderInlineTokens(text.slice(i + 2, closeBold))));
        i = closeBold + 2;
        plainStart = i;
        continue;
      }
    }

    if (text[i] === '*' && i + 1 < text.length && text[i + 1] !== '*' && text[i + 1] !== ' ') {
      let searchFrom = i + 1;
      let closeItalic = -1;
      while (searchFrom < text.length) {
        const candidate = text.indexOf('*', searchFrom);
        if (candidate === -1) break;
        if (candidate + 1 < text.length && text[candidate + 1] === '*') {
          searchFrom = candidate + 2;
          continue;
        }
        if (text[candidate - 1] !== ' ') {
          closeItalic = candidate;
          break;
        }
        searchFrom = candidate + 1;
      }
      if (closeItalic !== -1) {
        flushPlain(i);
        nodes.push(React.createElement('em', {
          key: keyCounter++,
          className: 'italic text-zinc-800 dark:text-stone-200'
        }, renderInlineTokens(text.slice(i + 1, closeItalic))));
        i = closeItalic + 1;
        plainStart = i;
        continue;
      }
    }

    if (text[i] === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket !== -1) {
        const label = text.slice(i + 1, closeBracket);
        if (closeBracket + 1 < text.length && text[closeBracket + 1] === '(') {
          const closeParen = text.indexOf(')', closeBracket + 2);
          if (closeParen !== -1) {
            flushPlain(i);
            const rawHref = text.slice(closeBracket + 2, closeParen).trim();
            const isSafeUrl = rawHref.startsWith('https://') || rawHref.startsWith('http://') || rawHref.startsWith('/') || rawHref.startsWith('#');
            const href = isSafeUrl ? rawHref : '#';
            nodes.push(React.createElement('a', {
              key: keyCounter++,
              href,
              target: href.startsWith('http') ? '_blank' : undefined,
              rel: href.startsWith('http') ? 'noreferrer' : undefined,
              className: 'text-accent underline decoration-current/40 underline-offset-2 hover:opacity-80 font-medium transition-opacity'
            }, label || href));
            i = closeParen + 1;
            plainStart = i;
            continue;
          }
        } else if (isCitationBracketLabel(label)) {
          flushPlain(i);
          nodes.push(React.createElement('span', {
            key: keyCounter++,
            className: 'inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded text-[11px] font-mono font-medium bg-stone-200/75 dark:bg-zinc-800/85 text-zinc-700 dark:text-zinc-300 border border-stone-300/70 dark:border-zinc-700/80 align-baseline leading-none'
          }, label.trim()));
          i = closeBracket + 1;
          plainStart = i;
          continue;
        }
      }
    }

    if (
      (text.startsWith('https://', i) || text.startsWith('http://', i)) &&
      (i === 0 || text[i - 1] === ' ' || text[i - 1] === '(' || text[i - 1] === '\n')
    ) {
      let urlEnd = i + 7;
      while (urlEnd < text.length && !' \n)]"\''.includes(text[urlEnd])) {
        urlEnd++;
      }
      flushPlain(i);
      const rawUrl = text.slice(i, urlEnd);
      nodes.push(React.createElement('a', {
        key: keyCounter++,
        href: rawUrl,
        target: '_blank',
        rel: 'noreferrer',
        className: 'text-accent underline decoration-current/40 underline-offset-2 hover:opacity-80 font-mono text-[11.5px] transition-opacity'
      }, rawUrl));
      i = urlEnd;
      plainStart = i;
      continue;
    }

    i++;
  }

  flushPlain(text.length);
  return nodes;
}

function isHorizontalRule(trimmed: string): boolean {
  if (trimmed.length < 3) return false;
  const ch = trimmed[0];
  if (ch !== '-' && ch !== '*' && ch !== '_') return false;
  let count = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === ch) count++;
    else if (trimmed[i] !== ' ') return false;
  }
  return count >= 3;
}

function parseListLine(rawLine: string): ListItemEntry | null {
  let spaces = 0;
  while (spaces < rawLine.length && (rawLine[spaces] === ' ' || rawLine[spaces] === '\t')) {
    spaces += rawLine[spaces] === '\t' ? 2 : 1;
  }
  const trimmed = rawLine.slice(spaces).trim();
  const indentLevel = spaces >= 2 ? 1 : 0;

  if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
    return { indentLevel, orderedPrefix: null, text: trimmed.slice(2).trim() };
  }

  let digits = 0;
  while (digits < trimmed.length && trimmed.charCodeAt(digits) >= 48 && trimmed.charCodeAt(digits) <= 57) {
    digits++;
  }
  if (digits > 0 && digits + 1 < trimmed.length && trimmed[digits] === '.' && trimmed[digits + 1] === ' ') {
    return {
      indentLevel,
      orderedPrefix: trimmed.slice(0, digits + 1),
      text: trimmed.slice(digits + 2).trim()
    };
  }
  return null;
}

function splitTableRow(line: string): string[] {
  let inner = line.trim();
  if (inner.startsWith('|')) inner = inner.slice(1);
  if (inner.endsWith('|')) inner = inner.slice(0, -1);
  return inner.split('|').map((cell) => cell.trim());
}

function parseTableSeparatorAlignments(line: string): TableColumnAlign[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('-') || !trimmed.includes('|')) return null;
  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return null;
  const alignments: TableColumnAlign[] = [];
  for (const cell of cells) {
    if (!cell.includes('-') || ![...cell].every((ch) => ch === '-' || ch === ':')) {
      return null;
    }
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    alignments.push(left && right ? 'center' : right ? 'right' : 'left');
  }
  return alignments;
}

function readTableBlock(lines: string[], start: number): { table: MarkdownTableBlock; nextIndex: number } | null {
  const headerLine = lines[start]?.trim() ?? '';
  if (!headerLine.includes('|') || start + 1 >= lines.length) return null;
  const alignments = parseTableSeparatorAlignments(lines[start + 1]);
  if (!alignments) return null;
  const header = splitTableRow(headerLine);
  const rows: string[][] = [];
  let end = start + 2;
  while (end < lines.length && lines[end].trim().includes('|') && lines[end].trim() !== '') {
    rows.push(splitTableRow(lines[end]));
    end++;
  }
  return { table: { header, alignments, rows }, nextIndex: end };
}

function isCalloutQuote(firstLine: string): boolean {
  const lower = stripOuterBoldMarkers(firstLine).toLowerCase();
  const prefixes = [
    'bottom line:',
    '**bottom line:**',
    '**bottom line**:',
    'summary:',
    '**summary:**',
    '**summary**:',
    'key takeaway:',
    '**key takeaway:**',
    'takeaway:',
    '**takeaway:**',
    'verdict:',
    '**verdict:**',
    'conclusion:',
    '**conclusion:**'
  ];
  return prefixes.some((prefix) => lower.startsWith(prefix));
}

export function parseMarkdownBlocks(body: string): ParsedMarkdownBlock[] {
  const lines = splitLines(body);
  const blocks: ParsedMarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    const tableMatch = readTableBlock(lines, i);
    if (tableMatch) {
      blocks.push({ kind: 'table', table: tableMatch.table });
      i = tableMatch.nextIndex;
      continue;
    }

    if (isHorizontalRule(trimmed)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    if (trimmed.startsWith('#### ')) {
      blocks.push({ kind: 'heading', level: 4, text: stripOuterBoldMarkers(trimmed.slice(5)) });
      i++;
      continue;
    }
    if (trimmed.startsWith('### ')) {
      blocks.push({ kind: 'heading', level: 3, text: stripOuterBoldMarkers(trimmed.slice(4)) });
      i++;
      continue;
    }
    if (trimmed.startsWith('## ')) {
      blocks.push({ kind: 'heading', level: 2, text: stripOuterBoldMarkers(trimmed.slice(3)) });
      i++;
      continue;
    }
    if (trimmed.startsWith('# ')) {
      blocks.push({ kind: 'heading', level: 1, text: stripOuterBoldMarkers(trimmed.slice(2)) });
      i++;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        const qTrim = lines[i].trim();
        quoteLines.push(qTrim.startsWith('> ') ? qTrim.slice(2) : qTrim.slice(1).trim());
        i++;
      }
      blocks.push({
        kind: 'blockquote',
        lines: quoteLines,
        isCallout: quoteLines.length > 0 && isCalloutQuote(quoteLines[0])
      });
      continue;
    }

    const firstListItem = parseListLine(rawLine);
    if (firstListItem) {
      const items: ListItemEntry[] = [firstListItem];
      i++;
      while (i < lines.length) {
        const nextTrimmed = lines[i].trim();
        if (!nextTrimmed) {
          if (i + 1 < lines.length && parseListLine(lines[i + 1])) {
            i++;
            continue;
          }
          break;
        }
        const nextItem = parseListLine(lines[i]);
        if (!nextItem) break;
        items.push(nextItem);
        i++;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }

    blocks.push({ kind: 'paragraph', text: rawLine });
    i++;
  }

  return blocks;
}

export function groupBlocksIntoSections(blocks: ParsedMarkdownBlock[]): MarkdownSectionGroup[] {
  const groups: MarkdownSectionGroup[] = [];
  let current: MarkdownSectionGroup = { title: null, isSourcesSection: false, blocks: [] };

  const pushCurrent = () => {
    while (current.blocks.length > 0 && current.blocks[0].kind === 'hr') {
      current.blocks.shift();
    }
    while (current.blocks.length > 0 && current.blocks[current.blocks.length - 1].kind === 'hr') {
      current.blocks.pop();
    }
    const trailingAfterSources: ParsedMarkdownBlock[] = [];
    if (current.isSourcesSection) {
      while (current.blocks.length > 1) {
        const last = current.blocks[current.blocks.length - 1];
        if (last.kind !== 'paragraph') break;
        const lower = last.text.trim().toLowerCase();
        if (
          lower.startsWith('**conclusion') ||
          lower.startsWith('conclusion:') ||
          lower.startsWith('**summary') ||
          lower.startsWith('**bottom line')
        ) {
          trailingAfterSources.unshift(current.blocks.pop()!);
        } else {
          break;
        }
      }
    }
    if (current.title !== null || current.blocks.length > 0) {
      groups.push(current);
    }
    if (trailingAfterSources.length > 0) {
      groups.push({
        title: null,
        isSourcesSection: false,
        blocks: trailingAfterSources.map((b) =>
          b.kind === 'paragraph' ? { kind: 'blockquote', lines: [b.text], isCallout: true } : b
        )
      });
    }
  };

  for (const block of blocks) {
    const isSourcesHeading =
      block.kind === 'heading' &&
      (block.level === 2 || block.level === 3) &&
      block.text.toLowerCase().includes('sources') &&
      (block.text.toLowerCase().includes('verif') || block.text.toLowerCase().includes('citation') || block.text.toLowerCase() === 'sources');

    if ((block.kind === 'heading' && (block.level === 1 || block.level === 2)) || isSourcesHeading) {
      pushCurrent();
      current = {
        title: block.text,
        isSourcesSection: isSourcesHeading,
        blocks: []
      };
      continue;
    }
    current.blocks.push(block);
  }

  pushCurrent();
  return groups;
}
