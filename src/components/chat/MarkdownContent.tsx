import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import {
  groupBlocksIntoSections,
  MarkdownTableBlock,
  parseFencedSegments,
  parseMarkdownBlocks,
  ParsedMarkdownBlock,
  renderInlineTokens
} from './markdownParser';

interface MarkdownContentProps {
  content: string;
}

function stripLeadingDecorativeGlyphs(raw: string): string {
  let idx = 0;
  while (idx < raw.length) {
    const cp = raw.codePointAt(idx) ?? 0;
    const isDecorative =
      cp === 0xfe0f ||
      cp === 0x200d ||
      (cp >= 0x2600 && cp <= 0x27bf) ||
      (cp >= 0x1f300 && cp <= 0x1faff);
    if (isDecorative) {
      idx += cp > 0xffff ? 2 : 1;
      continue;
    }
    if (raw[idx] === ' ') {
      idx++;
      continue;
    }
    break;
  }
  return raw.slice(idx);
}

function classifyStatusCell(raw: string): { tone: 'verified' | 'caution' | 'negative'; label: string } | null {
  const cleaned = stripLeadingDecorativeGlyphs(raw).trim();
  if (!cleaned || cleaned.length > 36 || cleaned.includes('[') || cleaned.includes('`')) {
    return null;
  }
  const lower = cleaned.toLowerCase();
  if (
    lower === 'verified' ||
    lower === 'confirmed' ||
    lower.startsWith('verified ') ||
    lower.startsWith('confirmed ')
  ) {
    return { tone: 'verified', label: cleaned };
  }
  if (
    lower === 'unconfirmed' ||
    lower === 'reported' ||
    lower === 'plausible' ||
    lower.startsWith('unconfirmed') ||
    lower.startsWith('potentially ') ||
    lower.startsWith('partially ') ||
    lower.includes('no cybersecurity mention')
  ) {
    return { tone: 'caution', label: cleaned };
  }
  if (
    lower === 'disputed' ||
    lower === 'refuted' ||
    lower === 'false' ||
    lower === 'no' ||
    lower.startsWith('no explicit') ||
    lower.startsWith('no specifics') ||
    lower.startsWith('contradicted')
  ) {
    return { tone: 'negative', label: cleaned };
  }
  return null;
}

const MarkdownTable: React.FC<{ table: MarkdownTableBlock }> = ({ table }) => {
  const { header, alignments, rows } = table;
  const alignClass = (index: number) => {
    const align = alignments[index] || 'left';
    if (align === 'center') return 'text-center';
    if (align === 'right') return 'text-right';
    return 'text-left';
  };

  return (
    <div
      data-testid="markdown-structured-table"
      className="my-3.5 overflow-x-auto rounded-xl border border-stone-200/90 dark:border-zinc-800 bg-white dark:bg-zinc-950/75 shadow-xs"
    >
      <table className="min-w-full border-collapse text-[13px] leading-snug tabular-nums">
        <thead className="bg-stone-100/95 dark:bg-zinc-900/95">
          <tr>
            {header.map((cell, index) => (
              <th
                key={index}
                className={`px-3.5 py-2.5 font-heading text-[11px] font-semibold uppercase tracking-[0.07em] text-zinc-600 dark:text-zinc-300 border-b border-stone-200 dark:border-zinc-800 ${alignClass(index)}`}
              >
                {renderInlineTokens(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-200/80 dark:divide-zinc-800/85">
          {rows.map((row, rowIndex) => (
            <tr
              key={rowIndex}
              className="even:bg-stone-50/65 dark:even:bg-zinc-900/35 hover:bg-stone-100/60 dark:hover:bg-zinc-900/75 transition-colors"
            >
              {header.map((_, cellIndex) => {
                const rawCell = row[cellIndex] ?? '';
                const statusBadge = cellIndex > 0 ? classifyStatusCell(rawCell) : null;
                return (
                  <td
                    key={cellIndex}
                    className={`px-3.5 py-2.5 align-top ${alignClass(cellIndex)} ${
                      cellIndex === 0
                        ? 'font-medium text-zinc-900 dark:text-stone-100 whitespace-normal sm:min-w-[140px]'
                        : 'text-zinc-700 dark:text-stone-300'
                    }`}
                  >
                    {statusBadge ? (
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-mono font-medium border ${
                          statusBadge.label.length <= 26 ? 'whitespace-nowrap' : ''
                        } ${
                          statusBadge.tone === 'verified'
                            ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                            : statusBadge.tone === 'caution'
                              ? 'bg-accent-subtle text-accent border-accent'
                              : 'bg-zinc-200/70 dark:bg-zinc-800/90 text-zinc-700 dark:text-zinc-300 border-zinc-300 dark:border-zinc-700'
                        }`}
                      >
                        {statusBadge.label}
                      </span>
                    ) : (
                      renderInlineTokens(stripLeadingDecorativeGlyphs(rawCell))
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

function renderBlock(block: ParsedMarkdownBlock, key: number): React.ReactNode {
  if (block.kind === 'table') {
    return <MarkdownTable key={key} table={block.table} />;
  }

  if (block.kind === 'hr') {
    return (
      <hr
        key={key}
        className="my-4 border-0 h-px bg-stone-200 dark:bg-zinc-800/90"
      />
    );
  }

  if (block.kind === 'heading') {
    if (block.level === 4) {
      return (
        <h5
          key={key}
          className="pt-2 font-heading text-[11.5px] font-semibold uppercase tracking-[0.08em] text-zinc-600 dark:text-zinc-400"
        >
          {renderInlineTokens(block.text)}
        </h5>
      );
    }
    return (
      <h4
        key={key}
        className="pt-2 font-heading text-[14.5px] font-semibold tracking-tight text-zinc-900 dark:text-stone-100"
      >
        {renderInlineTokens(block.text)}
      </h4>
    );
  }

  if (block.kind === 'blockquote') {
    if (block.isCallout) {
      return (
        <aside
          key={key}
          data-testid="markdown-summary-callout"
          className="my-2.5 rounded-xl border border-accent bg-accent-subtle px-4 py-3 space-y-1.5"
        >
          {block.lines.map((line, i) => (
            <p key={i} className="text-[14px] leading-relaxed text-zinc-900 dark:text-stone-100">
              {renderInlineTokens(line)}
            </p>
          ))}
        </aside>
      );
    }
    return (
      <blockquote
        key={key}
        className="my-2.5 border-l-2 border-accent pl-4 pr-3 py-2 rounded-r-xl bg-stone-100/80 dark:bg-zinc-950/75 font-editorial text-[14.5px] leading-relaxed text-zinc-800 dark:text-stone-200 space-y-1"
      >
        {block.lines.map((line, i) => (
          <p key={i}>{renderInlineTokens(line)}</p>
        ))}
      </blockquote>
    );
  }

  if (block.kind === 'list') {
    return (
      <div key={key} className="space-y-2 py-0.5">
        {block.items.map((item, idx) => (
          <div
            key={idx}
            className={`flex items-start gap-2.5 ${item.indentLevel > 0 ? 'pl-6' : 'pl-0.5'}`}
          >
            {item.orderedPrefix ? (
              <span className="font-mono text-[12px] font-semibold text-accent mt-0.5 min-w-[20px] select-none">
                {item.orderedPrefix}
              </span>
            ) : (
              <span
                aria-hidden="true"
                className={`mt-2.5 shrink-0 rounded-full ${
                  item.indentLevel > 0
                    ? 'w-1.5 h-1.5 border border-zinc-400 dark:border-zinc-500'
                    : 'w-1.5 h-1.5 bg-accent'
                }`}
              />
            )}
            <div className="flex-1 min-w-0 leading-[1.68] text-zinc-800 dark:text-stone-200">
              {renderInlineTokens(item.text)}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <p key={key} className="leading-[1.72] text-zinc-800 dark:text-stone-200">
      {renderInlineTokens(block.text)}
    </p>
  );
}

const MarkdownContentInner: React.FC<MarkdownContentProps> = ({ content }) => {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  if (!content) return null;

  const segments = parseFencedSegments(content);

  const handleCopyCode = (code: string, idx: number) => {
    navigator.clipboard?.writeText(code);
    setCopiedIndex(idx);
    setTimeout(() => setCopiedIndex(null), 1800);
  };

  return (
    <div className="prose-response space-y-4 break-words">
      {segments.map((seg, idx) => {
        if (seg.type === 'code') {
          return (
            <div
              key={idx}
              className="my-3 rounded-xl overflow-hidden border border-stone-200 dark:border-zinc-800 bg-zinc-950 text-zinc-100 shadow-xs"
            >
              <div className="flex items-center justify-between px-3.5 py-2 bg-zinc-900/95 border-b border-zinc-800 text-[11px] font-mono text-zinc-400">
                <span className="uppercase tracking-[0.08em]">{seg.lang}</span>
                <button
                  type="button"
                  onClick={() => handleCopyCode(seg.body, idx)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  {copiedIndex === idx ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span className="text-emerald-400">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="p-3.5 text-[12.5px] font-mono overflow-x-auto leading-relaxed text-zinc-100">
                <code>{seg.body}</code>
              </pre>
            </div>
          );
        }

        const blocks = parseMarkdownBlocks(seg.body);
        const sections = groupBlocksIntoSections(blocks);

        return (
          <div key={idx} className="space-y-4">
            {sections.map((section, secIdx) => {
              if (section.title === null) {
                return (
                  <div key={secIdx} className="space-y-2.5">
                    {section.blocks.map((block, bIdx) => renderBlock(block, bIdx))}
                  </div>
                );
              }

              if (section.isSourcesSection) {
                return (
                  <section
                    key={secIdx}
                    data-response-section="sources"
                    className="mt-4 rounded-xl border border-stone-200 dark:border-zinc-800/90 bg-stone-50/80 dark:bg-zinc-950/65 p-3.5 sm:p-4 space-y-2.5"
                  >
                    <h3 className="font-heading text-[11.5px] font-semibold uppercase tracking-[0.1em] text-accent flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                      <span>{renderInlineTokens(section.title)}</span>
                    </h3>
                    <div className="space-y-2.5">
                      {section.blocks.map((block, bIdx) => renderBlock(block, bIdx))}
                    </div>
                  </section>
                );
              }

              return (
                <section
                  key={secIdx}
                  data-response-section="analysis"
                  className={
                    secIdx > 0
                      ? 'pt-3.5 border-t border-stone-200/80 dark:border-zinc-800/85 space-y-2.5'
                      : 'space-y-2.5'
                  }
                >
                  <h3 className="font-heading text-[15.5px] sm:text-[16px] font-semibold tracking-tight text-zinc-950 dark:text-stone-100 border-l-2 border-accent pl-2.5 leading-snug">
                    {renderInlineTokens(section.title)}
                  </h3>
                  <div className="space-y-2.5">
                    {section.blocks.map((block, bIdx) => renderBlock(block, bIdx))}
                  </div>
                </section>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

export const MarkdownContent = React.memo(MarkdownContentInner);

