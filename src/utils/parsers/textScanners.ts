// Deterministic Character Classification & String/Path Scanners (Zero Regex)

export function isAsciiAlpha(ch: string): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

export function isAsciiDigit(ch: string): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return code >= 48 && code <= 57;
}

export function isAsciiAlphanumeric(ch: string): boolean {
  return isAsciiAlpha(ch) || isAsciiDigit(ch);
}

export function isIdentifierStart(ch: string): boolean {
  return isAsciiAlpha(ch) || ch === '_' || ch === '$';
}

export function isIdentifierPart(ch: string): boolean {
  return isAsciiAlphanumeric(ch) || ch === '_' || ch === '$' || ch === '-';
}

export function isWhitespaceChar(ch: string): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 160;
}

export function isControlChar(ch: string): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return code < 32 || code === 127;
}

export function hasControlCharacters(input: string): boolean {
  for (let i = 0; i < input.length; i++) {
    if (isControlChar(input[i])) return true;
  }
  return false;
}

export function normalizeLineEndings(input: string): string {
  if (!input) return '';
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\r') {
      if (i + 1 < input.length && input[i + 1] === '\n') {
        i++;
      }
      out += '\n';
    } else {
      out += ch;
    }
  }
  return out;
}

export function splitLines(input: string): string[] {
  const normalized = normalizeLineEndings(input);
  return normalized.split('\n');
}

export function collapseWhitespace(input: string): string {
  if (!input) return '';
  let out = '';
  let inSpace = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (isWhitespaceChar(ch)) {
      if (!inSpace && out.length > 0) {
        out += ' ';
        inSpace = true;
      }
    } else {
      out += ch;
      inSpace = false;
    }
  }
  return out.trim();
}

export function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) {
    end--;
  }
  return line.slice(0, end);
}

export function collapseExcessBlankLines(input: string, maxConsecutiveNewlines = 2): string {
  const normalized = normalizeLineEndings(input);
  const lines = normalized.split('\n');
  const result: string[] = [];
  let blankCount = 0;

  for (const rawLine of lines) {
    const trimmedRight = trimTrailingSpaces(rawLine);
    if (trimmedRight.trim().length === 0) {
      blankCount++;
      if (blankCount < maxConsecutiveNewlines) {
        result.push('');
      }
    } else {
      blankCount = 0;
      result.push(trimmedRight);
    }
  }
  return result.join('\n').trim();
}

export function splitParagraphs(input: string): string[] {
  const lines = splitLines(input);
  const paragraphs: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.trim().length === 0) {
      if (current.length > 0) {
        paragraphs.push(current.join('\n').trim());
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    paragraphs.push(current.join('\n').trim());
  }
  return paragraphs.filter(Boolean);
}

export function tokenizeWords(input: string, minLength = 1): string[] {
  if (!input) return [];
  const tokens: string[] = [];
  let current = '';
  const lower = input.toLowerCase();

  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (isAsciiAlphanumeric(ch) || ch === '_' || ch === '-') {
      current += ch;
    } else {
      if (current.length >= minLength) {
        tokens.push(current);
      }
      current = '';
    }
  }
  if (current.length >= minLength) {
    tokens.push(current);
  }
  return tokens;
}

export function sanitizeSlugIdentifier(input: string, fallback = 'item', maxLength = 32): string {
  if (!input) return fallback;
  let out = '';
  let lastWasUnderscore = false;
  const lower = input.toLowerCase();

  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (isAsciiAlphanumeric(ch)) {
      out += ch;
      lastWasUnderscore = false;
    } else if (!lastWasUnderscore && out.length > 0) {
      out += '_';
      lastWasUnderscore = true;
    }
    if (out.length >= maxLength) break;
  }
  while (out.endsWith('_')) {
    out = out.slice(0, -1);
  }
  return out || fallback;
}

export function sanitizeFileName(rawName: string): string {
  const trimmed = (rawName || '').trim();
  if (!trimmed) return 'untitled.txt';
  let out = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '/' || ch === '\\' || ch === '\0' || isControlChar(ch)) {
      out += '_';
    } else {
      out += ch;
    }
  }
  while (out.includes('..')) {
    out = out.split('..').join('_');
  }
  return out || 'untitled.txt';
}

export function sanitizeFolderPath(rawFolder: string): string {
  const normalized = (rawFolder || '').trim().split('\\').join('/');
  if (!normalized || normalized === '/') return '/';
  const segments = normalized
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

export function removeHtmlTagWithBody(html: string, tagName: string): string {
  if (!html) return '';
  const lowerTag = tagName.toLowerCase();
  let out = '';
  let idx = 0;
  const lowerHtml = html.toLowerCase();

  while (idx < html.length) {
    const openPos = lowerHtml.indexOf(`<${lowerTag}`, idx);
    if (openPos === -1) {
      out += html.slice(idx);
      break;
    }
    const afterTagChar = lowerHtml[openPos + 1 + lowerTag.length] || '';
    if (afterTagChar && afterTagChar !== '>' && afterTagChar !== '/' && !isWhitespaceChar(afterTagChar)) {
      out += html.slice(idx, openPos + 1 + lowerTag.length);
      idx = openPos + 1 + lowerTag.length;
      continue;
    }

    out += html.slice(idx, openPos);
    const closeTag = `</${lowerTag}`;
    const closePos = lowerHtml.indexOf(closeTag, openPos + 1 + lowerTag.length);
    if (closePos === -1) {
      const openEnd = lowerHtml.indexOf('>', openPos);
      if (openEnd === -1) break;
      idx = openEnd + 1;
    } else {
      const closeEnd = lowerHtml.indexOf('>', closePos);
      idx = closeEnd === -1 ? html.length : closeEnd + 1;
    }
  }
  return out;
}

export function stripDangerousHtmlBlocks(input: string): string {
  if (!input) return '';
  let result = input;
  const blockedTags = ['script', 'iframe', 'object', 'embed'];
  for (const tag of blockedTags) {
    result = removeHtmlTagWithBody(result, tag);
  }
  return result;
}
