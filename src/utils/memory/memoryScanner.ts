// Diamond Memory Scanner: Pure Programmatic Fact & Directive Analysis
// Zero Regex, Zero Brittle Punctuation Rules, Semantic Directive Density Evaluation
import {
  tokenizeWords,
  collapseWhitespace,
  isAsciiAlpha,
  isAsciiAlphanumeric
} from '../structuredParsers';
import { createCuid, createCuidTag } from './cuid';
import type {
  MemoryFactInput,
  MemoryCategory,
  MemoryCandidateExtraction
} from '../rag/ragTypes';

function resolveProgrammaticCategory(tokens: string[], lowerPrompt = ''): {
  category: MemoryCategory;
  promptType: 'system' | 'user';
  importance: number;
  confidence: number;
} {
  const tokenSet = new Set(tokens);
  const withoutFileRepo = tokenizeWords(lowerPrompt.split('file repo').join(' '), 2);

  // 1. Negative Constraints & Boundary Guardrails
  if (
    tokenSet.has('never') ||
    tokenSet.has('forbidden') ||
    tokenSet.has('prohibited') ||
    (tokenSet.has('must') && tokenSet.has('not')) ||
    (tokenSet.has('do') && tokenSet.has('not')) ||
    tokenSet.has('constraint')
  ) {
    return { category: 'constraint', promptType: 'system', importance: 5, confidence: 0.95 };
  }

  // 2. Architectural & System Stack Specifications
  if (
    tokenSet.has('architecture') ||
    tokenSet.has('database') ||
    tokenSet.has('sqlite') ||
    tokenSet.has('schema') ||
    tokenSet.has('stack') ||
    tokenSet.has('framework') ||
    tokenSet.has('backend')
  ) {
    return { category: 'architecture', promptType: 'system', importance: 4, confidence: 0.92 };
  }

  // 3. User Preferences & Identity Directives
  if (
    tokenSet.has('prefer') ||
    tokenSet.has('preference') ||
    (tokenSet.has('call') && tokenSet.has('me')) ||
    tokenSet.has('identity')
  ) {
    return { category: 'preference', promptType: 'user', importance: 3, confidence: 0.90 };
  }

  // 4. Project & Repository Directives (ignoreLLMCP's own "File Repo" UI label unless 'repo' appears independently)
  if (
    tokenSet.has('project') ||
    withoutFileRepo.includes('repo') ||
    tokenSet.has('repository')
  ) {
    return { category: 'project', promptType: 'user', importance: 3, confidence: 0.88 };
  }

  // 5. Universal Directives & Invariants
  if (
    tokenSet.has('always') ||
    tokenSet.has('rule') ||
    tokenSet.has('directive') ||
    tokenSet.has('standard') ||
    tokenSet.has('remember') ||
    (tokenSet.has('keep') && tokenSet.has('in') && tokenSet.has('mind'))
  ) {
    return { category: 'system_directive', promptType: 'system', importance: 4, confidence: 0.92 };
  }

  return { category: 'preference', promptType: 'user', importance: 2, confidence: 0.5 };
}

function extractCoreSubjectTokens(tokens: string[]): string[] {
  const commonStructural = new Set([
    'the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'at',
    'by', 'with', 'is', 'are', 'was', 'were', 'be', 'this', 'that', 'our',
    'your', 'my', 'we', 'i', 'you', 'it', 'its', 'as'
  ]);
  const subjects: string[] = [];
  for (const t of tokens) {
    if (!commonStructural.has(t) && t.length >= 3 && !subjects.includes(t)) {
      subjects.push(t);
      if (subjects.length >= 4) break;
    }
  }
  return subjects;
}

export function synthesizeMemoryKey(factText: string, category: MemoryCategory): string {
  const tokens = tokenizeWords(factText.toLowerCase(), 2);
  const subjects = extractCoreSubjectTokens(tokens);

  if (subjects.length === 0) {
    return category === 'constraint'
      ? 'Constraint'
      : category === 'architecture'
      ? 'Architecture'
      : 'Directive';
  }

  const capitalized = subjects
    .slice(0, 3)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

  if (category === 'constraint') {
    return `Constraint: ${capitalized}`;
  }
  if (category === 'architecture') {
    return `Arch: ${capitalized}`;
  }
  if (category === 'preference') {
    return `Preference: ${capitalized}`;
  }
  return capitalized;
}

function splitDirectiveSentences(rawPrompt: string): string[] {
  const sentences: string[] = [];
  let current = '';
  for (let i = 0; i < rawPrompt.length; i++) {
    const ch = rawPrompt[i];
    const next = i + 1 < rawPrompt.length ? rawPrompt[i + 1] : '';
    if (ch === '\n' || ch === '\r') {
      if (current.trim()) sentences.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
    if ((ch === '.' || ch === '!' || ch === '?') && (next === '' || next === ' ' || next === '\t')) {
      // Avoid splitting decimal numbers like 4.85 or file extensions like .pdf
      const prev = i > 0 ? rawPrompt[i - 1] : '';
      const isDecimal = ch === '.' && prev >= '0' && prev <= '9' && i + 2 < rawPrompt.length && rawPrompt[i + 2] >= '0' && rawPrompt[i + 2] <= '9';
      if (!isDecimal && current.trim()) {
        sentences.push(current.trim());
        current = '';
      }
    }
  }
  if (current.trim()) sentences.push(current.trim());
  return sentences;
}

function findDirectiveCoreClause(prompt: string): string {
  const sentences = splitDirectiveSentences(prompt);
  let target = collapseWhitespace(prompt).trim();
  if (sentences.length > 1) {
    for (const sentence of sentences) {
      const sClean = collapseWhitespace(sentence).trim();
      const sTokens = tokenizeWords(sClean.toLowerCase(), 2);
      if (sTokens.length >= 3 && resolveProgrammaticCategory(sTokens, sClean.toLowerCase()).confidence >= 0.8) {
        target = sClean;
        break;
      }
    }
  }
  const clean = target;
  // If colon exists, e.g. "Note: never use yellow" or "Architecture: SQLite with atomic files"
  const colonIdx = clean.indexOf(':');
  if (colonIdx !== -1 && colonIdx < 35 && colonIdx + 1 < clean.length) {
    const afterColon = clean.slice(colonIdx + 1).trim();
    if (afterColon.length >= 10) {
      return afterColon;
    }
  }
  return clean;
}

function checkLexicalOverlap(textA: string, textB: string): number {
  const tokensA = new Set(tokenizeWords(textA.toLowerCase(), 2));
  const tokensB = new Set(tokenizeWords(textB.toLowerCase(), 2));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function detectMemoryConflict(
  candidateFact: string,
  existing: MemoryFactInput
): string | undefined {
  const candTokens = tokenizeWords(candidateFact.toLowerCase(), 2);
  const existTokens = tokenizeWords(existing.fact.toLowerCase(), 2);

  const candHasNeg = candTokens.includes('never') || (candTokens.includes('must') && candTokens.includes('not'));
  const existHasNeg = existTokens.includes('never') || (existTokens.includes('must') && existTokens.includes('not'));

  if (candHasNeg !== existHasNeg) {
    const overlap = checkLexicalOverlap(candidateFact, existing.fact);
    if (overlap > 0.35) {
      return `Potential polarity conflict with existing directive "${existing.key}"`;
    }
  }
  return undefined;
}

export function extractDiamondMemoryCandidate(
  prompt: string,
  existingMemories: MemoryFactInput[] = []
): MemoryCandidateExtraction | null {
  if (!prompt || typeof prompt !== 'string') return null;

  const rawClean = collapseWhitespace(prompt).trim();
  if (rawClean.length < 12) return null;

  const tokens = tokenizeWords(rawClean.toLowerCase(), 2);
  if (tokens.length < 3) return null;

  const lowerPrompt = rawClean.toLowerCase();
  const explicitMemory = lowerPrompt.includes('remember that ') ||
    lowerPrompt.includes('remember to ') || lowerPrompt.includes('keep in mind ');
  const questionIndex = lowerPrompt.indexOf('?');
  const questionStarters = ['what', 'when', 'where', 'which', 'who', 'why', 'how', 'can', 'could', 'would', 'should', 'does', 'do', 'did', 'is', 'are', 'will'];
  const trailingTokens = questionIndex >= 0 ? tokenizeWords(lowerPrompt.slice(questionIndex + 1), 2) : [];
  const trailingDirective = ['always', 'never', 'must', 'prefer', 'remember', 'directive'].some((word) => trailingTokens.includes(word));
  if (!explicitMemory && (rawClean.endsWith('?') ||
      (questionIndex >= 0 && questionStarters.includes(tokens[0]) && !trailingDirective))) {
    return null;
  }
  const queryLeadPrefixes = ['using my ', 'according to ', 'based on ', 'from my ', 'from the ', 'in my ', 'check my '];
  const hasExplicitDirectiveVerb = tokens.includes('always') || tokens.includes('never') ||
    tokens.includes('must') || tokens.includes('prefer') || explicitMemory;
  if (!hasExplicitDirectiveVerb && queryLeadPrefixes.some((prefix) => lowerPrompt.startsWith(prefix))) {
    return null;
  }

  const { category, promptType, importance, confidence } = resolveProgrammaticCategory(tokens, lowerPrompt);
  // If no directive intent tokens are present, ignore
  if (confidence < 0.8) {
    return null;
  }

  const coreClause = findDirectiveCoreClause(rawClean);
  let extractedFact = coreClause;
  while (extractedFact.endsWith('.') || extractedFact.endsWith(';') || extractedFact.endsWith('!')) {
    extractedFact = extractedFact.slice(0, -1).trim();
  }
  if (extractedFact.length > 280) {
    extractedFact = extractedFact.slice(0, 280).trim();
  }

  const key = synthesizeMemoryKey(extractedFact, category);
  const cuid = createCuid();
  const cuidTags: string[] = [createCuidTag('rule', category)];

  for (const word of extractCoreSubjectTokens(tokens)) {
    cuidTags.push(`tag:${word}`);
  }

  let isDuplicate = false;
  let existingMemoryId: string | undefined;
  let conflictWarning: string | undefined;

  for (const existing of existingMemories) {
    const overlap = checkLexicalOverlap(extractedFact, existing.fact);
    if (overlap >= 0.85) {
      isDuplicate = true;
      existingMemoryId = existing.id;
      break;
    }
    const conflict = detectMemoryConflict(extractedFact, existing);
    if (conflict) {
      conflictWarning = conflict;
    }
  }

  const candidate: Omit<MemoryFactInput, 'id'> = {
    key,
    fact: extractedFact,
    category,
    promptType,
    isActive: true,
    pinned: category === 'constraint' || category === 'system_directive',
    importance,
    tags: cuidTags,
    source: 'extracted',
    confidence,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  return {
    candidate,
    confidence,
    triggerPhrase: tokens.slice(0, 3).join(' '),
    isDuplicate,
    existingMemoryId,
    conflictWarning
  };
}
