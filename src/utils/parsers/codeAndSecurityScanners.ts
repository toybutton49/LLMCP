// Lexical Code Symbol, Security, Quantitative, and Hygiene Scanners (Zero Regex)
import {
  isAsciiDigit,
  isAsciiAlphanumeric,
  isIdentifierStart,
  isIdentifierPart,
  isWhitespaceChar,
  collapseWhitespace,
  splitLines
} from './textScanners';
import { extractHttpUrlsFromText } from './urlParsers';

export interface ScannedCodeSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'route' | 'heading' | 'key';
  line: number;
  signature: string;
}

export interface ScannedSecurityFinding {
  line: number;
  severity: 'critical' | 'warning' | 'info';
  ruleId: string;
  description: string;
  remediation: string;
}

function readNextIdentifier(text: string, startIndex: number): { identifier: string; nextIndex: number } {
  let i = startIndex;
  while (i < text.length && isWhitespaceChar(text[i])) i++;
  const start = i;
  if (i < text.length && isIdentifierStart(text[i])) {
    i++;
    while (i < text.length && isIdentifierPart(text[i])) i++;
  }
  return { identifier: text.slice(start, i), nextIndex: i };
}

export function scanCodeSymbolsLexical(content: string, language: string): ScannedCodeSymbol[] {
  const lines = splitLines(content);
  const symbols: ScannedCodeSymbol[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue;
    }

    if (language === 'markdown' || trimmed.startsWith('#')) {
      let hashes = 0;
      while (hashes < trimmed.length && trimmed[hashes] === '#') hashes++;
      if (hashes >= 1 && hashes <= 6 && trimmed[hashes] === ' ') {
        const headingTitle = trimmed.slice(hashes + 1).trim();
        if (headingTitle) {
          symbols.push({
            name: headingTitle.slice(0, 64),
            kind: 'heading',
            line: i + 1,
            signature: trimmed.slice(0, 90)
          });
          continue;
        }
      }
    }

    let cursor = trimmed;
    const modifiers = ['export ', 'default ', 'async '];
    let strippedMod = true;
    while (strippedMod) {
      strippedMod = false;
      for (const mod of modifiers) {
        if (cursor.startsWith(mod)) {
          cursor = cursor.slice(mod.length).trimStart();
          strippedMod = true;
        }
      }
    }

    if (cursor.startsWith('function ') || cursor.startsWith('def ')) {
      const keywordLen = cursor.startsWith('function ') ? 9 : 4;
      const { identifier } = readNextIdentifier(cursor, keywordLen);
      if (identifier) {
        symbols.push({
          name: identifier,
          kind: 'function',
          line: i + 1,
          signature: trimmed.slice(0, 90)
        });
        continue;
      }
    }

    if (cursor.startsWith('class ')) {
      const { identifier } = readNextIdentifier(cursor, 6);
      if (identifier) {
        symbols.push({
          name: identifier,
          kind: 'class',
          line: i + 1,
          signature: trimmed.slice(0, 90)
        });
        continue;
      }
    }

    if (cursor.startsWith('interface ')) {
      const { identifier } = readNextIdentifier(cursor, 10);
      if (identifier) {
        symbols.push({
          name: identifier,
          kind: 'interface',
          line: i + 1,
          signature: trimmed.slice(0, 90)
        });
        continue;
      }
    }

    if (cursor.startsWith('type ')) {
      const { identifier } = readNextIdentifier(cursor, 5);
      if (identifier) {
        symbols.push({
          name: identifier,
          kind: 'type',
          line: i + 1,
          signature: trimmed.slice(0, 90)
        });
        continue;
      }
    }

    const routePrefixes = [
      'app.get(',
      'app.post(',
      'app.put(',
      'app.delete(',
      'app.patch(',
      'router.get(',
      'router.post(',
      'router.put(',
      'router.delete(',
      'router.patch('
    ];
    let matchedRoute = false;
    for (const prefix of routePrefixes) {
      const pos = trimmed.indexOf(prefix);
      if (pos !== -1) {
        const dotIdx = prefix.indexOf('.');
        const method = prefix.slice(dotIdx + 1, prefix.length - 1).toUpperCase();
        const argStart = pos + prefix.length;
        const quoteChar = trimmed[argStart];
        if (quoteChar === "'" || quoteChar === '"' || quoteChar === '`') {
          const quoteEnd = trimmed.indexOf(quoteChar, argStart + 1);
          if (quoteEnd !== -1) {
            const routePath = trimmed.slice(argStart + 1, quoteEnd);
            symbols.push({
              name: `${method} ${routePath}`,
              kind: 'route',
              line: i + 1,
              signature: trimmed.slice(0, 90)
            });
            matchedRoute = true;
            break;
          }
        }
      }
    }
    if (matchedRoute) continue;

    if (cursor.startsWith('const ') || cursor.startsWith('let ')) {
      const kwLen = cursor.startsWith('const ') ? 6 : 4;
      const { identifier } = readNextIdentifier(cursor, kwLen);
      if (identifier && cursor.includes('=')) {
        const eqIdx = cursor.indexOf('=');
        const rhs = cursor.slice(eqIdx + 1).trim();
        const isArrow = rhs.includes('=>');
        symbols.push({
          name: identifier,
          kind: isArrow ? 'function' : 'const',
          line: i + 1,
          signature: trimmed.slice(0, 90)
        });
        continue;
      }
    }

    if (language === 'json' && rawLine.startsWith('  "') && !rawLine.startsWith('    ')) {
      const closeQuote = rawLine.indexOf('"', 3);
      if (closeQuote !== -1 && rawLine.slice(closeQuote + 1).trimStart().startsWith(':')) {
        const keyName = rawLine.slice(3, closeQuote);
        if (keyName) {
          symbols.push({
            name: keyName,
            kind: 'key',
            line: i + 1,
            signature: trimmed.slice(0, 90)
          });
        }
      }
    }
  }

  return symbols;
}

function hasTokenPrefixPattern(line: string, prefix: string, minAlnumTail: number): boolean {
  let idx = 0;
  while (idx < line.length) {
    const pos = line.indexOf(prefix, idx);
    if (pos === -1) return false;
    let tailCount = 0;
    let cur = pos + prefix.length;
    while (cur < line.length && (isAsciiAlphanumeric(line[cur]) || line[cur] === '_' || line[cur] === '-')) {
      tailCount++;
      cur++;
    }
    if (tailCount >= minAlnumTail) return true;
    idx = pos + prefix.length;
  }
  return false;
}

export function scanSecurityPatternsLexical(content: string): ScannedSecurityFinding[] {
  const lines = splitLines(content);
  const findings: ScannedSecurityFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    if (trimmed.includes('eval(') || trimmed.includes('new Function(')) {
      findings.push({
        line: i + 1,
        severity: 'critical',
        ruleId: 'SEC-EVAL-01',
        description: 'Dynamic code execution via eval() or new Function() detected.',
        remediation: 'Use structured JSON parsing or a deterministic expression parser instead of eval().'
      });
    }

    if (trimmed.includes('dangerouslySetInnerHTML') || trimmed.includes('.innerHTML =') || trimmed.includes('.innerHTML=')) {
      findings.push({
        line: i + 1,
        severity: 'warning',
        ruleId: 'SEC-XSS-02',
        description: 'Direct DOM HTML injection surface detected.',
        remediation: 'Render structured React elements or sanitize HTML before insertion.'
      });
    }

    if (trimmed.includes('child_process') || trimmed.includes('execSync(') || trimmed.includes('spawnSync(')) {
      findings.push({
        line: i + 1,
        severity: 'warning',
        ruleId: 'SEC-CMD-03',
        description: 'Subprocess shell invocation detected.',
        remediation: 'Validate arguments strictly and avoid passing unsanitized strings to shell commands.'
      });
    }

    if (hasTokenPrefixPattern(trimmed, 'sk-', 20) || hasTokenPrefixPattern(trimmed, 'AIza', 20)) {
      findings.push({
        line: i + 1,
        severity: 'critical',
        ruleId: 'SEC-SECRET-04',
        description: 'Potential hardcoded API secret token detected in source text.',
        remediation: 'Move credentials to environment variables and never commit raw tokens.'
      });
    }

    const urls = extractHttpUrlsFromText(trimmed);
    for (const url of urls) {
      if (
        url.startsWith('http://') &&
        !url.startsWith('http://localhost') &&
        !url.startsWith('http://127.0.0.1') &&
        !url.startsWith('http://0.0.0.0')
      ) {
        findings.push({
          line: i + 1,
          severity: 'info',
          ruleId: 'SEC-HTTP-05',
          description: `Unencrypted external HTTP URL detected: ${url}`,
          remediation: 'Use HTTPS for external endpoints or restrict traffic to local loopback.'
        });
      }
    }
  }

  return findings;
}

export function extractQuantitativeTokens(content: string): string[] {
  const words = collapseWhitespace(content).split(' ');
  const matches: string[] = [];
  const units = ['%', 'ms', 's', 'mb', 'gb', 'kb', 'tb', 'tokens', 'chars', 'lines', 'port', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6'];

  for (let i = 0; i < words.length; i++) {
    const raw = words[i].replaceAll(',', '').replaceAll(';', '').replaceAll(')', '').replaceAll('(', '');
    if (!raw) continue;
    let hasDigit = false;
    for (let c = 0; c < raw.length; c++) {
      if (isAsciiDigit(raw[c])) {
        hasDigit = true;
        break;
      }
    }
    if (!hasDigit) continue;

    const lower = raw.toLowerCase();
    const nextWord = (words[i + 1] || '').toLowerCase().replaceAll(',', '').replaceAll('.', '');
    if (units.some((u) => lower.endsWith(u))) {
      matches.push(raw);
    } else if (units.includes(nextWord)) {
      matches.push(`${raw} ${words[i + 1].replaceAll(',', '').replaceAll('.', '')}`);
    } else if (raw.startsWith('$') || raw.endsWith('%') || raw.includes('.')) {
      matches.push(raw);
    }
  }
  return Array.from(new Set(matches)).slice(0, 6);
}

export function extractEndpointAndRouteTokens(content: string): string[] {
  const results: string[] = [];
  const urls = extractHttpUrlsFromText(content);
  for (const u of urls) results.push(u);

  const lines = splitLines(content);
  for (const line of lines) {
    let idx = 0;
    while (idx < line.length) {
      const apiPos = line.indexOf('/api/', idx);
      const v1Pos = line.indexOf('/v1/', idx);
      const pos = apiPos !== -1 && (v1Pos === -1 || apiPos < v1Pos) ? apiPos : v1Pos;
      if (pos === -1) break;
      let end = pos;
      while (
        end < line.length &&
        !isWhitespaceChar(line[end]) &&
        line[end] !== '"' &&
        line[end] !== "'" &&
        line[end] !== '`' &&
        line[end] !== ')' &&
        line[end] !== ','
      ) {
        end++;
      }
      const route = line.slice(pos, end);
      if (route.length > 4) results.push(route);
      idx = end + 1;
    }
  }
  return Array.from(new Set(results)).slice(0, 5);
}

export function containsEmojiOrEmDash(text: string): {
  hasEmDash: boolean;
  hasEmoji: boolean;
  firstOffendingChar?: string;
  codePointHex?: string;
} {
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    if (code === 0x2014) {
      return {
        hasEmDash: true,
        hasEmoji: false,
        firstOffendingChar: ch,
        codePointHex: 'U+2014'
      };
    }
    if ((code >= 0x1f300 && code <= 0x1faff) || (code >= 0x2600 && code <= 0x27bf)) {
      return {
        hasEmDash: false,
        hasEmoji: true,
        firstOffendingChar: ch,
        codePointHex: `U+${code.toString(16).toUpperCase()}`
      };
    }
  }
  return { hasEmDash: false, hasEmoji: false };
}
