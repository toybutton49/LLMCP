// Balanced JSON Block Extractor & Pratt Arithmetic Parser (Zero Regex)
import { isAsciiDigit, isWhitespaceChar } from './textScanners';

export function extractBalancedJsonBlock(text: string): string | null {
  if (!text) return null;

  const lower = text.toLowerCase();
  const fenceStart = lower.indexOf('```json');
  if (fenceStart !== -1) {
    const contentStart = fenceStart + 7;
    const fenceEnd = text.indexOf('```', contentStart);
    if (fenceEnd !== -1) {
      const candidate = text.slice(contentStart, fenceEnd).trim();
      if (candidate) return candidate;
    }
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' || ch === '[') {
      const extracted = scanBalancedBracketSlice(text, i);
      if (extracted) return extracted;
    }
  }
  return null;
}

function scanBalancedBracketSlice(text: string, startIndex: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let escapeNext = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      stack.push('}');
    } else if (ch === '[') {
      stack.push(']');
    } else if (ch === '}' || ch === ']') {
      const expected = stack.pop();
      if (expected !== ch) return null;
      if (stack.length === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }
  return null;
}

export function extractArithmeticExpressionFromText(prompt: string): string | null {
  if (!prompt) return null;
  let bestCandidate = '';

  let current = '';
  let hasOperator = false;
  let digitCount = 0;

  const isMathChar = (ch: string) =>
    isAsciiDigit(ch) ||
    ch === '.' ||
    ch === '+' ||
    ch === '-' ||
    ch === '*' ||
    ch === '/' ||
    ch === '%' ||
    ch === '(' ||
    ch === ')' ||
    ch === ' ';

  for (let i = 0; i < prompt.length; i++) {
    const ch = prompt[i];
    if (isMathChar(ch)) {
      current += ch;
      if (isAsciiDigit(ch)) digitCount++;
      if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%') {
        hasOperator = true;
      }
    } else {
      const trimmed = current.trim();
      if (hasOperator && digitCount >= 2 && trimmed.length > bestCandidate.length) {
        bestCandidate = trimmed;
      }
      current = '';
      hasOperator = false;
      digitCount = 0;
    }
  }

  const trimmed = current.trim();
  if (hasOperator && digitCount >= 2 && trimmed.length > bestCandidate.length) {
    bestCandidate = trimmed;
  }

  return bestCandidate || null;
}

export function evaluateArithmeticPratt(expression: string): number | null {
  if (!expression) return null;
  const tokens: Array<{ type: 'num'; value: number } | { type: 'op'; value: string }> = [];
  let i = 0;

  while (i < expression.length) {
    const ch = expression[i];
    if (isWhitespaceChar(ch)) {
      i++;
      continue;
    }
    if (isAsciiDigit(ch) || ch === '.') {
      let numStr = '';
      let dotCount = 0;
      while (i < expression.length && (isAsciiDigit(expression[i]) || expression[i] === '.')) {
        if (expression[i] === '.') dotCount++;
        if (dotCount > 1) return null;
        numStr += expression[i];
        i++;
      }
      const parsed = Number(numStr);
      if (!Number.isFinite(parsed)) return null;
      tokens.push({ type: 'num', value: parsed });
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%' || ch === '(' || ch === ')') {
      if (ch === '*' && i + 1 < expression.length && expression[i + 1] === '*') {
        tokens.push({ type: 'op', value: '**' });
        i += 2;
      } else {
        tokens.push({ type: 'op', value: ch });
        i++;
      }
      continue;
    }
    return null;
  }

  if (tokens.length === 0) return null;
  let pos = 0;

  function parseExpression(): number | null {
    let left = parseTerm();
    if (left === null) return null;
    while (pos < tokens.length && tokens[pos].type === 'op' && (tokens[pos].value === '+' || tokens[pos].value === '-')) {
      const op = tokens[pos].value;
      pos++;
      const right = parseTerm();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number | null {
    let left = parsePower();
    if (left === null) return null;
    while (
      pos < tokens.length &&
      tokens[pos].type === 'op' &&
      (tokens[pos].value === '*' || tokens[pos].value === '/' || tokens[pos].value === '%')
    ) {
      const op = tokens[pos].value;
      pos++;
      const right = parsePower();
      if (right === null) return null;
      if ((op === '/' || op === '%') && right === 0) return null;
      if (op === '*') left = left * right;
      else if (op === '/') left = left / right;
      else left = left % right;
    }
    return left;
  }

  function parsePower(): number | null {
    let base = parseUnary();
    if (base === null) return null;
    if (pos < tokens.length && tokens[pos].type === 'op' && tokens[pos].value === '**') {
      pos++;
      const exp = parseUnary();
      if (exp === null) return null;
      base = Math.pow(base, exp);
    }
    return base;
  }

  function parseUnary(): number | null {
    if (pos < tokens.length && tokens[pos].type === 'op' && (tokens[pos].value === '+' || tokens[pos].value === '-')) {
      const op = tokens[pos].value;
      pos++;
      const val = parseUnary();
      if (val === null) return null;
      return op === '-' ? -val : val;
    }
    return parsePrimary();
  }

  function parsePrimary(): number | null {
    if (pos >= tokens.length) return null;
    const tok = tokens[pos];
    if (tok.type === 'num') {
      pos++;
      return tok.value;
    }
    if (tok.type === 'op' && tok.value === '(') {
      pos++;
      const inner = parseExpression();
      if (inner === null) return null;
      if (pos >= tokens.length || tokens[pos].type !== 'op' || tokens[pos].value !== ')') {
        return null;
      }
      pos++;
      return inner;
    }
    return null;
  }

  const result = parseExpression();
  if (result === null || pos !== tokens.length || !Number.isFinite(result)) {
    return null;
  }
  return Number(result.toFixed(8));
}
