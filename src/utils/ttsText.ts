// Deterministic, zero-regex Markdown-to-speech normalizer and sentence chunker.
import { TTS_DEFAULTS } from '../data/runtimeDefaults';

export interface TtsVoiceOption {
  id: string;
  name: string;
  accent: string;
  gender: string;
  grade: string;
}

export const KOKORO_VOICES: readonly TtsVoiceOption[] = [
  { id: 'af_heart', name: 'Heart', accent: 'US English', gender: 'Female', grade: 'A' },
  { id: 'af_bella', name: 'Bella', accent: 'US English', gender: 'Female', grade: 'A-' },
  { id: 'af_nicole', name: 'Nicole', accent: 'US English', gender: 'Female', grade: 'B-' },
  { id: 'af_sarah', name: 'Sarah', accent: 'US English', gender: 'Female', grade: 'C+' },
  { id: 'af_kore', name: 'Kore', accent: 'US English', gender: 'Female', grade: 'C+' },
  { id: 'af_aoede', name: 'Aoede', accent: 'US English', gender: 'Female', grade: 'C+' },
  { id: 'af_alloy', name: 'Alloy', accent: 'US English', gender: 'Female', grade: 'C' },
  { id: 'af_nova', name: 'Nova', accent: 'US English', gender: 'Female', grade: 'C' },
  { id: 'af_sky', name: 'Sky', accent: 'US English', gender: 'Female', grade: 'C-' },
  { id: 'am_michael', name: 'Michael', accent: 'US English', gender: 'Male', grade: 'C+' },
  { id: 'am_fenrir', name: 'Fenrir', accent: 'US English', gender: 'Male', grade: 'C+' },
  { id: 'am_puck', name: 'Puck', accent: 'US English', gender: 'Male', grade: 'C+' },
  { id: 'am_echo', name: 'Echo', accent: 'US English', gender: 'Male', grade: 'D' },
  { id: 'am_onyx', name: 'Onyx', accent: 'US English', gender: 'Male', grade: 'D' },
  { id: 'bf_emma', name: 'Emma', accent: 'UK English', gender: 'Female', grade: 'B-' },
  { id: 'bf_isabella', name: 'Isabella', accent: 'UK English', gender: 'Female', grade: 'C' },
  { id: 'bm_george', name: 'George', accent: 'UK English', gender: 'Male', grade: 'C' },
  { id: 'bm_fable', name: 'Fable', accent: 'UK English', gender: 'Male', grade: 'C' },
  { id: 'bm_lewis', name: 'Lewis', accent: 'UK English', gender: 'Male', grade: 'D+' }
] as const;

export function isKnownKokoroVoice(voiceId: string): boolean {
  return KOKORO_VOICES.some((v) => v.id === voiceId);
}

export function clampTtsSpeed(speed: unknown): number {
  if (typeof speed !== 'number' || !Number.isFinite(speed)) {
    return TTS_DEFAULTS.speed;
  }
  const rounded = Math.round(speed * 100) / 100;
  return Math.max(TTS_DEFAULTS.minSpeed, Math.min(TTS_DEFAULTS.maxSpeed, rounded));
}

function stripThinkBlocks(input: string): string {
  let out = '';
  let i = 0;
  const lower = input.toLowerCase();
  while (i < input.length) {
    const start = lower.indexOf('<think>', i);
    if (start === -1) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, start);
    const end = lower.indexOf('</think>', start + 7);
    if (end === -1) {
      break;
    }
    i = end + 8;
  }
  return out;
}

function stripMarkdownLinks(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '!' && line[i + 1] === '[') {
      const closeBracket = line.indexOf(']', i + 2);
      if (closeBracket !== -1 && line[closeBracket + 1] === '(') {
        const closeParen = line.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          out += line.slice(i + 2, closeBracket);
          i = closeParen + 1;
          continue;
        }
      }
    }
    if (line[i] === '[') {
      const closeBracket = line.indexOf(']', i + 1);
      if (closeBracket !== -1 && line[closeBracket + 1] === '(') {
        const closeParen = line.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          out += line.slice(i + 1, closeBracket);
          i = closeParen + 1;
          continue;
        }
      }
    }
    out += line[i];
    i++;
  }
  return out;
}

function stripInlineFormatting(line: string): string {
  const withoutLinks = stripMarkdownLinks(line);
  let out = '';
  for (let i = 0; i < withoutLinks.length; i++) {
    const ch = withoutLinks[i];
    if (ch === '`' || ch === '*' || ch === '~') {
      continue;
    }
    if (ch === '_' && (i === 0 || withoutLinks[i - 1] === ' ' || i === withoutLinks.length - 1 || withoutLinks[i + 1] === ' ')) {
      continue;
    }
    out += ch;
  }
  return out;
}

function isTableSeparatorLine(trimmed: string): boolean {
  if (!trimmed.includes('-')) return false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c !== '|' && c !== '-' && c !== ':' && c !== ' ') {
      return false;
    }
  }
  return true;
}

function stripOrderedPrefix(trimmed: string): string {
  let i = 0;
  while (i < trimmed.length && trimmed.charCodeAt(i) >= 48 && trimmed.charCodeAt(i) <= 57) {
    i++;
  }
  if (i > 0 && (trimmed[i] === '.' || trimmed[i] === ')') && trimmed[i + 1] === ' ') {
    return trimmed.slice(i + 2);
  }
  return trimmed;
}

function collapseSpaces(text: string): string {
  let out = '';
  let lastWasSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isSpace = ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
    if (isSpace) {
      if (!lastWasSpace && out.length > 0) {
        out += ' ';
      }
      lastWasSpace = true;
    } else {
      out += ch;
      lastWasSpace = false;
    }
  }
  return out.trim();
}

export function prepareTextForSpeech(rawMarkdown: string): string {
  const withoutThink = stripThinkBlocks(String(rawMarkdown || ''));
  const rawLines = withoutThink.split('\n');
  const spokenLines: string[] = [];
  let inCodeFence = false;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      if (!inCodeFence) {
        inCodeFence = true;
        spokenLines.push('Code block omitted.');
      } else {
        inCodeFence = false;
      }
      continue;
    }
    if (inCodeFence) continue;
    if (!trimmed) continue;

    // Skip horizontal rules
    if (trimmed === '---' || trimmed === '***' || trimmed === '___') continue;
    // Skip markdown table alignment rows
    if (trimmed.startsWith('|') && isTableSeparatorLine(trimmed)) continue;

    let line = trimmed;
    while (line.startsWith('#')) line = line.slice(1);
    line = line.trim();
    if (line.startsWith('>')) {
      while (line.startsWith('>')) line = line.slice(1);
      line = line.trim();
    }
    if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('+ ')) {
      line = line.slice(2).trim();
    } else {
      line = stripOrderedPrefix(line).trim();
    }

    if (line.includes('|')) {
      const cells = line
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      line = cells.join(', ');
    }

    const cleaned = collapseSpaces(stripInlineFormatting(line));
    if (!cleaned) continue;

    const lastChar = cleaned[cleaned.length - 1];
    if (lastChar !== '.' && lastChar !== '!' && lastChar !== '?' && lastChar !== ':' && lastChar !== ';') {
      spokenLines.push(`${cleaned}.`);
    } else {
      spokenLines.push(cleaned);
    }
  }

  return collapseSpaces(spokenLines.join(' '));
}

export function splitSpeechChunks(
  cleanText: string,
  maxChunkChars: number = TTS_DEFAULTS.chunkTargetChars
): string[] {
  const normalized = collapseSpaces(cleanText);
  if (!normalized) return [];
  const target = Math.max(80, Math.min(600, Math.round(maxChunkChars)));

  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    const next = normalized[i + 1];
    const isSentenceEnd =
      (ch === '.' || ch === '!' || ch === '?') &&
      (next === undefined || next === ' ');
    if (isSentenceEnd) {
      const piece = normalized.slice(start, i + 1).trim();
      if (piece) sentences.push(piece);
      start = i + 1;
    }
  }
  const tail = normalized.slice(start).trim();
  if (tail) sentences.push(tail);

  const chunks: string[] = [];
  let current = '';

  const pushOversized = (text: string) => {
    const words = text.split(' ').filter(Boolean);
    let buf = '';
    for (const word of words) {
      const candidate = buf ? `${buf} ${word}` : word;
      if (candidate.length > target && buf) {
        chunks.push(buf);
        buf = word;
      } else {
        buf = candidate;
      }
    }
    if (buf) chunks.push(buf);
  };

  for (const sentence of sentences) {
    if (sentence.length > target) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      pushOversized(sentence);
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > target && current) {
      chunks.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}
