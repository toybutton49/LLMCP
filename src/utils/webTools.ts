/**
 * Pure, Deterministic Web Tools Logic for web_search, web_fetch, and web_context (Zero Regex, Zero Emojis, Zero Em-Dashes).
 */

import {
  collapseWhitespace,
  decodeHtmlEntitiesScanner,
  extractHttpUrlsFromText,
  parseHtmlDocumentStateMachine,
  splitLines,
  tokenizeWords,
  validatePublicWebUrl
} from './structuredParsers';

export interface WebSearchResultItem {
  id: string;
  title: string;
  url: string;
  snippet: string;
  source: string;
  score: number;
}

export interface WebFetchResult {
  url: string;
  title: string;
  description: string;
  content: string;
  headings: string[];
  links: Array<{ text: string; href: string }>;
  wordCount: number;
  charCount: number;
  fetchedAt: string;
}

export interface WebContextPassage {
  id: string;
  url: string;
  title: string;
  excerpt: string;
  relevanceScore: number;
  matchedTerms: string[];
}

export interface WebContextResult {
  query: string;
  passages: WebContextPassage[];
  synthesizedSummary: string;
  totalSources: number;
}

/**
 * Validates that a URL is safe to fetch from a web tool (http/https only, blocks private/loopback IP ranges to prevent SSRF).
 */
export function validateSafeWebUrl(rawUrl: string): {
  valid: boolean;
  normalizedUrl: string;
  reason?: string;
} {
  const result = validatePublicWebUrl(rawUrl);
  return {
    valid: result.valid,
    normalizedUrl: result.normalizedUrl,
    reason: result.error
  };
}

/**
 * Decodes HTML entities deterministically without regex.
 */
export function decodeHtmlEntities(input: string): string {
  return decodeHtmlEntitiesScanner(input);
}

/**
 * Strips scripts/styles and converts raw HTML into clean structured Markdown and metadata using a character state machine.
 */
export function parseHtmlToReadableDocument(
  rawHtml: string,
  baseUrl: string,
  maxChars: number = 12000
): WebFetchResult {
  const parsed = parseHtmlDocumentStateMachine(rawHtml, baseUrl);
  const clippedContent = parsed.markdownContent.slice(0, maxChars);
  const words = collapseWhitespace(clippedContent)
    .split(' ')
    .filter(Boolean);

  return {
    url: baseUrl,
    title: parsed.title || baseUrl,
    description: parsed.description || clippedContent.slice(0, 220),
    content: clippedContent,
    headings: parsed.headings.slice(0, 24),
    links: parsed.links.slice(0, 20),
    wordCount: words.length,
    charCount: clippedContent.length,
    fetchedAt: new Date().toISOString()
  };
}

/**
 * Extracts explicit HTTP/HTTPS URLs from a user prompt without regex.
 */
export function extractUrlsFromText(text: string): string[] {
  return extractHttpUrlsFromText(text);
}

/**
 * Ranks and extracts high-signal passages across one or more fetched web documents or search snippets for a given query.
 */
export function buildWebContextFromPages(
  query: string,
  pages: Array<{ url: string; title: string; content: string }>,
  topK: number = 4
): WebContextResult {
  const cleanQuery = (query || '').trim();
  const terms = Array.from(new Set(tokenizeWords(cleanQuery, 3)));

  const passages: WebContextPassage[] = [];

  for (const page of pages) {
    const rawLines = splitLines(page.content || '')
      .map((l) => l.trim())
      .filter((l) => l.length > 20);

    const windowSize = 3;
    for (let i = 0; i < Math.max(1, rawLines.length); i += 2) {
      const slice = rawLines.slice(i, i + windowSize).join('\n').trim();
      if (!slice) continue;
      const lowerSlice = `${page.title} ${slice}`.toLowerCase();
      const matched: string[] = [];
      for (const term of terms) {
        if (lowerSlice.includes(term)) {
          matched.push(term);
        }
      }
      const lexicalRatio = terms.length > 0 ? matched.length / terms.length : 0.35;
      const lengthBonus = Math.min(0.15, slice.length / 2000);
      const relevanceScore = Number(Math.min(0.99, lexicalRatio * 0.82 + lengthBonus + 0.08).toFixed(3));

      passages.push({
        id: `wctx_${passages.length + 1}`,
        url: page.url,
        title: page.title || page.url,
        excerpt: slice.slice(0, 520),
        relevanceScore,
        matchedTerms: matched
      });
    }
  }

  passages.sort((a, b) => b.relevanceScore - a.relevanceScore);
  const topPassages = passages.slice(0, Math.max(1, topK));
  const uniqueUrls = new Set(topPassages.map((p) => p.url));

  const synthesizedSummary =
    topPassages.length > 0
      ? topPassages
          .map(
            (p, idx) =>
              `[Web Source ${idx + 1}: "${p.title}" (${p.url}) · Score ${p.relevanceScore.toFixed(2)}]\n${p.excerpt}`
          )
          .join('\n\n')
      : `No relevant web context passages matched "${cleanQuery}".`;

  return {
    query: cleanQuery,
    passages: topPassages,
    synthesizedSummary,
    totalSources: uniqueUrls.size
  };
}

export interface WebGroundingDecision {
  trigger: boolean;
  reason?: 'correction' | 'factual_inquiry' | 'explicit_search' | 'url_reference';
  suggestedQuery: string;
}

function cleanAlphanumericSearchQuery(term: string): string {
  let cleaned = '';
  const allowed = 'abcdefghijklmnopqrstuvwxyz0123456789 -:';
  for (const ch of term.toLowerCase()) {
    if (allowed.includes(ch)) {
      cleaned += ch;
    } else {
      cleaned += ' ';
    }
  }
  return cleaned
    .split(' ')
    .filter(Boolean)
    .join(' ')
    .trim();
}

/**
 * Strips conversational objection phrases and noise deterministically without regex.
 */
function stripConversationalObjections(rawText: string): string {
  let lower = rawText.toLowerCase().trim();
  const prefixes = [
    'wrong,', 'wrong:', 'wrong', 'incorrect,', 'incorrect:', 'incorrect',
    "that's wrong", 'thats wrong', 'that is wrong', "you're wrong", 'you are wrong',
    'not true', 'not right', 'not correct', "isn't right", 'isnt right', "isn't correct", 'isnt correct',
    "that's not right", 'thats not right', "that's not correct", 'thats not correct',
    "that's false", 'thats false', 'this is false',
    'wait,', 'wait ', 'wait', 'hold on,', 'hold on', 'hold up',
    'actually,', 'actually ', 'actually',
    'are you sure about that', 'are you sure',
    'check again please', 'check again', 'recheck please', 'recheck',
    'verify again', 'verify', 'double check',
    'no, that is not', "no, that's not", 'no thats not',
    "no, that's", 'no thats', 'no it is', "no it's", 'no its',
    'no, they', 'no they', 'no,', 'no ', 'nope,', 'nope',
    'i thought it was', 'i thought', 'i think', 'thought it was',
    'the score was', 'the score is', 'score was', 'score is',
    'it was the', 'it was', "it's", 'its', 'they were', 'they are'
  ];

  let modified = true;
  while (modified) {
    modified = false;
    lower = lower.trim();
    while (lower.startsWith(',') || lower.startsWith(':') || lower.startsWith('.') || lower.startsWith('?')) {
      lower = lower.slice(1).trim();
      modified = true;
    }
    for (const pfx of prefixes) {
      if (lower.startsWith(pfx)) {
        lower = lower.slice(pfx.length).trim();
        modified = true;
        break;
      }
    }
  }

  const suffixes = [
    'check again please', 'check again', 'recheck please', 'recheck',
    'are you sure', 'verify again', 'please', 'right now'
  ];
  for (const s of suffixes) {
    if (lower.endsWith(s)) {
      lower = lower.slice(0, -s.length).trim();
    }
  }

  return cleanAlphanumericSearchQuery(lower);
}

/**
 * Detects whether a user turn requires built-in live search grounding.
 * Triggers on:
 * 1. Explicit URLs or search requests
 * 2. User corrections to prior turns (e.g. "wrong, its 13 to 6", "no, that is incorrect")
 * 3. Live factual inquiries (sports scores, breaking news, live events, real-time facts)
 */
export function detectWebGroundingNeed(
  prompt: string,
  history?: Array<{ role: string; content: string }>
): WebGroundingDecision {
  if (!prompt || typeof prompt !== 'string') {
    return { trigger: false, suggestedQuery: '' };
  }

  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    return { trigger: false, suggestedQuery: '' };
  }

  const urls = extractUrlsFromText(trimmedPrompt);
  if (urls.length > 0) {
    return {
      trigger: true,
      reason: 'url_reference',
      suggestedQuery: urls[0]
    };
  }

  const lower = trimmedPrompt.toLowerCase();

  const explicitKeywords = [
    'search the web', 'search web', 'search online', 'search for ', 'look up ',
    'google ', 'bing ', 'browse the web', 'check online', 'find online'
  ];
  for (const kw of explicitKeywords) {
    const idx = lower.indexOf(kw);
    if (idx !== -1) {
      const remainder = lower.slice(idx + kw.length).trim();
      return {
        trigger: true,
        reason: 'explicit_search',
        suggestedQuery: remainder || trimmedPrompt
      };
    }
  }

  const correctionMarkers = [
    'wrong', 'incorrect', "that's wrong", 'thats wrong', "you're wrong", 'you are wrong',
    'not true', 'not right', 'not correct', "isn't right", 'isnt right', "isn't correct", 'isnt correct',
    "that's not right", 'thats not right', "that's not correct", 'thats not correct',
    "that's false", 'thats false', 'this is false', 'check again', 'recheck',
    'verify again', 'double check', 'are you sure', 'actually,', 'actually ',
    'wait,', 'wait ', 'hold on', 'i thought', 'thought it was',
    'the score was', 'the score is', 'score was', 'score is'
  ];

  let isCorrection = false;
  for (const m of correctionMarkers) {
    if (lower.startsWith(m) || lower.includes(` ${m}`) || lower.includes(`${m},`)) {
      isCorrection = true;
      break;
    }
  }
  if (!isCorrection) {
    if (
      lower.startsWith('no,') ||
      lower.startsWith('no ') ||
      lower.startsWith('nope') ||
      lower.startsWith('wait')
    ) {
      isCorrection = true;
    }
  }

  if (!isCorrection && Array.isArray(history) && history.length > 0) {
    if (lower.includes(' to ') || lower.includes('-')) {
      const words = lower.split(' ');
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (w === 'to' && i > 0 && i < words.length - 1) {
          const prevNum = Number(words[i - 1]);
          const nextNum = Number(words[i + 1]);
          if (Number.isFinite(prevNum) && Number.isFinite(nextNum)) {
            isCorrection = true;
            break;
          }
        } else if (w.includes('-')) {
          const parts = w.split('-');
          if (parts.length === 2) {
            const p0 = Number(parts[0]);
            const p1 = Number(parts[1]);
            if (Number.isFinite(p0) && Number.isFinite(p1)) {
              isCorrection = true;
              break;
            }
          }
        }
      }
    }
  }

  if (isCorrection) {
    let prevUserPrompt = '';
    let prevAssistantText = '';
    if (Array.isArray(history) && history.length > 0) {
      for (let i = history.length - 1; i >= 0; i--) {
        const item = history[i];
        if (item.role === 'assistant' && !prevAssistantText) {
          prevAssistantText = item.content || '';
        } else if (
          item.role === 'user' &&
          !prevUserPrompt &&
          item.content.trim() !== trimmedPrompt
        ) {
          prevUserPrompt = item.content.trim();
        }
        if (prevUserPrompt && prevAssistantText) break;
      }
    }

    const cleanClaimWords = stripConversationalObjections(lower);

    if (prevUserPrompt) {
      const combined = cleanClaimWords
        ? `${prevUserPrompt} ${cleanClaimWords}`.trim().slice(0, 200)
        : prevUserPrompt.slice(0, 200);
      return {
        trigger: true,
        reason: 'correction',
        suggestedQuery: combined
      };
    }

    return {
      trigger: true,
      reason: 'correction',
      suggestedQuery: cleanClaimWords || trimmedPrompt
    };
  }

  const factualTerms = [
    'nfl', 'nba', 'mlb', 'nhl', 'mls', 'fifa', 'premier league', 'champions league',
    'super bowl', 'world cup', 'game score', 'game tonights score', 'game today',
    'tonights game', "tonight's game", 'todays game', "today's game",
    "tonight's score", 'tonights score', "today's score", 'todays score',
    'live score', 'current score', 'final score', 'what was the score',
    "what's the score", 'what is the score', 'who won', 'who lost', 'who is winning',
    'score of the game', 'score tonight', 'score today', 'who won tonight', 'who won today',
    'halftime score', 'box score', 'breaking news', 'latest news', 'news today',
    'news tonight', 'headlines today', 'what happened today', 'what happened with',
    'current status of', 'current president', 'current prime minister', 'current ceo',
    'who is currently', 'current champion', 'who holds the record',
    'weather today', 'weather tonight', 'weather in', 'temperature in', 'forecast for',
    'stock price', 'price of bitcoin', 'crypto price', 'is it true that', 'fact check'
  ];

  for (const term of factualTerms) {
    if (lower.includes(term)) {
      return {
        trigger: true,
        reason: 'factual_inquiry',
        suggestedQuery: cleanAlphanumericSearchQuery(trimmedPrompt).slice(0, 200) || trimmedPrompt
      };
    }
  }

  return { trigger: false, suggestedQuery: '' };
}
