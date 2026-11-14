// State-machine HTML parser and entity decoder without regex
import {
  isWhitespaceChar,
  collapseWhitespace,
  collapseExcessBlankLines,
  splitLines,
  removeHtmlTagWithBody
} from './textScanners';

export interface ParsedHtmlStateResult {
  title: string;
  description: string;
  headings: string[];
  links: Array<{ text: string; href: string }>;
  markdownContent: string;
  plainText: string;
}

const NAMED_HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#x27': "'",
  '#x2F': '/',
  mdash: '-',
  ndash: '-',
  hellip: '...',
  copy: '(c)',
  reg: '(R)'
};

export function decodeHtmlEntitiesScanner(input: string): string {
  if (!input || !input.includes('&')) return input || '';
  let out = '';
  let i = 0;

  while (i < input.length) {
    if (input[i] === '&') {
      const semi = input.indexOf(';', i + 1);
      if (semi !== -1 && semi - i <= 12) {
        const entityBody = input.slice(i + 1, semi);
        const lowerBody = entityBody.toLowerCase();
        if (NAMED_HTML_ENTITIES[lowerBody] !== undefined) {
          out += NAMED_HTML_ENTITIES[lowerBody];
          i = semi + 1;
          continue;
        }
        if (entityBody.startsWith('#x') || entityBody.startsWith('#X')) {
          const hexStr = entityBody.slice(2);
          const code = Number.parseInt(hexStr, 16);
          if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
            if (code === 0x2014 || code === 0x2013) {
              out += '-';
            } else {
              out += String.fromCodePoint(code);
            }
            i = semi + 1;
            continue;
          }
        } else if (entityBody.startsWith('#')) {
          const decStr = entityBody.slice(1);
          const code = Number.parseInt(decStr, 10);
          if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
            if (code === 8212 || code === 8211) {
              out += '-';
            } else {
              out += String.fromCodePoint(code);
            }
            i = semi + 1;
            continue;
          }
        }
      }
    }
    out += input[i];
    i++;
  }
  return out;
}

function parseTagAttributes(tagContent: string): {
  tagName: string;
  attrs: Record<string, string>;
  isClosing: boolean;
  isSelfClosing: boolean;
} {
  let inner = tagContent.trim();
  let isClosing = false;
  let isSelfClosing = false;

  if (inner.startsWith('/')) {
    isClosing = true;
    inner = inner.slice(1).trim();
  }
  if (inner.endsWith('/')) {
    isSelfClosing = true;
    inner = inner.slice(0, -1).trim();
  }

  let i = 0;
  while (i < inner.length && !isWhitespaceChar(inner[i])) {
    i++;
  }
  const tagName = inner.slice(0, i).toLowerCase();
  const attrs: Record<string, string> = {};

  while (i < inner.length) {
    while (i < inner.length && isWhitespaceChar(inner[i])) i++;
    if (i >= inner.length) break;

    const attrStart = i;
    while (i < inner.length && inner[i] !== '=' && !isWhitespaceChar(inner[i])) i++;
    const attrName = inner.slice(attrStart, i).toLowerCase();
    if (!attrName) break;

    while (i < inner.length && isWhitespaceChar(inner[i])) i++;
    if (i < inner.length && inner[i] === '=') {
      i++;
      while (i < inner.length && isWhitespaceChar(inner[i])) i++;
      if (i < inner.length && (inner[i] === '"' || inner[i] === "'")) {
        const quote = inner[i];
        i++;
        const valStart = i;
        while (i < inner.length && inner[i] !== quote) i++;
        attrs[attrName] = inner.slice(valStart, i);
        if (i < inner.length && inner[i] === quote) i++;
      } else {
        const valStart = i;
        while (i < inner.length && !isWhitespaceChar(inner[i])) i++;
        attrs[attrName] = inner.slice(valStart, i);
      }
    } else {
      attrs[attrName] = '';
    }
  }

  return { tagName, attrs, isClosing, isSelfClosing };
}

export function stripHtmlTagsScanner(input: string): string {
  if (!input) return '';
  let out = '';
  let inTag = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '<') {
      inTag = true;
    } else if (ch === '>') {
      inTag = false;
      out += ' ';
    } else if (!inTag) {
      out += ch;
    }
  }
  return collapseWhitespace(decodeHtmlEntitiesScanner(out));
}

export function parseHtmlDocumentStateMachine(rawHtml: string, baseUrl: string): ParsedHtmlStateResult {
  if (!rawHtml) {
    return {
      title: baseUrl,
      description: '',
      headings: [],
      links: [],
      markdownContent: '',
      plainText: ''
    };
  }

  let cleaned = '';
  let cursor = 0;
  while (cursor < rawHtml.length) {
    const commentStart = rawHtml.indexOf('<!--', cursor);
    if (commentStart === -1) {
      cleaned += rawHtml.slice(cursor);
      break;
    }
    cleaned += rawHtml.slice(cursor, commentStart);
    const commentEnd = rawHtml.indexOf('-->', commentStart + 4);
    if (commentEnd === -1) break;
    cursor = commentEnd + 3;
  }

  const strippedTags = ['script', 'style', 'noscript', 'svg', 'iframe', 'template'];
  for (const tag of strippedTags) {
    cleaned = removeHtmlTagWithBody(cleaned, tag);
  }

  let title = '';
  let description = '';
  const headings: string[] = [];
  const links: Array<{ text: string; href: string }> = [];
  const seenLinks = new Set<string>();

  let mdOut = '';
  let plainOut = '';
  let inTitle = false;
  let titleBuf = '';
  let activeHeadingLevel = 0;
  let headingBuf = '';
  let inAnchor = false;
  let anchorHref = '';
  let anchorBuf = '';

  let idx = 0;
  while (idx < cleaned.length) {
    const lt = cleaned.indexOf('<', idx);
    if (lt === -1) {
      const textChunk = decodeHtmlEntitiesScanner(cleaned.slice(idx));
      mdOut += textChunk;
      plainOut += textChunk;
      if (inTitle) titleBuf += textChunk;
      if (activeHeadingLevel > 0) headingBuf += textChunk;
      if (inAnchor) anchorBuf += textChunk;
      break;
    }

    if (lt > idx) {
      const textChunk = decodeHtmlEntitiesScanner(cleaned.slice(idx, lt));
      if (!inTitle) {
        mdOut += textChunk;
        plainOut += textChunk;
      }
      if (inTitle) titleBuf += textChunk;
      if (activeHeadingLevel > 0) headingBuf += textChunk;
      if (inAnchor) anchorBuf += textChunk;
    }

    const gt = cleaned.indexOf('>', lt + 1);
    if (gt === -1) break;

    const rawTag = cleaned.slice(lt + 1, gt);
    idx = gt + 1;

    if (rawTag.startsWith('!')) continue;

    const { tagName, attrs, isClosing } = parseTagAttributes(rawTag);
    if (!tagName) continue;

    if (tagName === 'title') {
      if (!isClosing) {
        inTitle = true;
        titleBuf = '';
      } else {
        inTitle = false;
        if (!title && titleBuf.trim()) title = collapseWhitespace(titleBuf);
      }
      continue;
    }

    if (tagName === 'meta' && !isClosing) {
      const metaName = (attrs.name || attrs.property || '').toLowerCase();
      const content = attrs.content || '';
      if (
        !description &&
        content &&
        (metaName === 'description' || metaName === 'og:description' || metaName === 'twitter:description')
      ) {
        description = collapseWhitespace(decodeHtmlEntitiesScanner(content));
      }
      continue;
    }

    if (tagName === 'h1' || tagName === 'h2' || tagName === 'h3' || tagName === 'h4') {
      const level = Number(tagName[1]);
      if (!isClosing) {
        activeHeadingLevel = level;
        headingBuf = '';
        mdOut += `\n\n${'#'.repeat(level)} `;
        plainOut += '\n';
      } else {
        const cleanHeading = collapseWhitespace(headingBuf);
        if (cleanHeading && headings.length < 25) headings.push(cleanHeading);
        activeHeadingLevel = 0;
        headingBuf = '';
        mdOut += '\n\n';
        plainOut += '\n';
      }
      continue;
    }

    if (tagName === 'a') {
      if (!isClosing) {
        inAnchor = true;
        anchorHref = (attrs.href || '').trim();
        anchorBuf = '';
      } else {
        inAnchor = false;
        const cleanAnchorText = collapseWhitespace(anchorBuf);
        if (
          cleanAnchorText &&
          anchorHref &&
          !anchorHref.startsWith('#') &&
          !anchorHref.toLowerCase().startsWith('javascript:')
        ) {
          try {
            const resolved = new URL(anchorHref, baseUrl).toString();
            if ((resolved.startsWith('http://') || resolved.startsWith('https://')) && !seenLinks.has(resolved)) {
              seenLinks.add(resolved);
              if (links.length < 30) {
                links.push({ text: cleanAnchorText.slice(0, 120), href: resolved });
              }
            }
          } catch {
            // Ignore invalid relative href
          }
        }
        anchorHref = '';
        anchorBuf = '';
      }
      continue;
    }

    if (tagName === 'li' && !isClosing) {
      mdOut += '\n- ';
      plainOut += '\n- ';
      continue;
    }

    if (tagName === 'br') {
      mdOut += '\n';
      plainOut += '\n';
      continue;
    }

    if (
      tagName === 'p' ||
      tagName === 'div' ||
      tagName === 'section' ||
      tagName === 'article' ||
      tagName === 'header' ||
      tagName === 'footer' ||
      tagName === 'tr' ||
      tagName === 'blockquote' ||
      tagName === 'pre'
    ) {
      mdOut += '\n\n';
      plainOut += '\n';
      continue;
    }

    if (tagName === 'code') {
      mdOut += '`';
    }
  }

  const normalizedLines = splitLines(mdOut).map((line) => collapseWhitespace(line));
  const finalMarkdown = collapseExcessBlankLines(normalizedLines.join('\n'), 2);
  const finalPlain = collapseWhitespace(plainOut);

  return {
    title: title || headings[0] || baseUrl,
    description: description || finalPlain.slice(0, 220),
    headings,
    links,
    markdownContent: finalMarkdown,
    plainText: finalPlain
  };
}
