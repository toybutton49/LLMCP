// Deterministic Vector Embedding, Chunking, and Hybrid Similarity Search Engine
import { normalizeLineEndings, splitParagraphs, tokenizeWords } from '../structuredParsers';
import type { DocumentChunk, RagDocumentInput, RetrievalHit, SimilarityMetricId } from './ragTypes';
import { ACTIVE_CONTEXT_MESSAGES, DEFAULT_LLAMA_CPP_BASE_URL } from './ragTypes';
import { isBinaryOrImageFile } from './binaryGuards';

export const OCTO_HEART_NEURAL_DIMENSIONS = 768;
export const OCTO_HEART_FALLBACK_DIMENSIONS = 384;

export function selectActiveWindowMessageIds(
  messages: Array<{ id?: string; content?: string; tokenCount?: number }>,
  maxHistoryTokens?: number,
  maxMessages: number = ACTIVE_CONTEXT_MESSAGES
): string[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const countBounded = messages.slice(-Math.max(1, maxMessages));
  const baseIdx = messages.length - countBounded.length;
  if (typeof maxHistoryTokens !== 'number' || !Number.isFinite(maxHistoryTokens) || maxHistoryTokens <= 0) {
    return countBounded.map((m, idx) => m.id || String(baseIdx + idx));
  }
  const selected: string[] = [];
  let accumulatedTokens = 0;
  for (let i = countBounded.length - 1; i >= 0; i--) {
    const msg = countBounded[i];
    const msgTokens = (typeof msg.tokenCount === 'number' && msg.tokenCount > 0)
      ? msg.tokenCount
      : estimateTokenCount(msg.content || '');
    if (selected.length > 0 && accumulatedTokens + msgTokens > maxHistoryTokens) {
      break;
    }
    accumulatedTokens += msgTokens;
    selected.push(msg.id || String(baseIdx + i));
  }
  return selected.reverse();
}

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const punctChars = ',;:{}[]"()-_/<>=+*|\\';
  let digits = 0;
  let punct = 0;
  let otherAscii = 0;
  let nonAscii = 0;
  let words = 0;
  let inWord = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    const code = trimmed.charCodeAt(i);
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      words++;
    }
    if (code > 127) nonAscii++;
    else if (ch >= '0' && ch <= '9') digits++;
    else if (punctChars.includes(ch)) punct++;
    else otherAscii++;
  }
  const wordEstimate = words * 1.33 + nonAscii * 0.5;
  const charDensityEstimate = otherAscii / 4 + digits / 2 + punct * 0.85 + nonAscii * 1.5;
  return Math.max(
    1,
    Math.ceil(trimmed.length / 4),
    Math.ceil(wordEstimate),
    Math.ceil(charDensityEstimate)
  );
}

export function chunkDocumentText(
  text: string,
  maxChars: number = 420,
  overlapChars: number = 60
): string[] {
  const safeMax = Math.max(80, Math.min(4000, Number(maxChars) || 420));
  const parsedOverlap = Number(overlapChars);
  const safeOverlap = Math.max(0, Math.min(safeMax - 40, Number.isFinite(parsedOverlap) ? parsedOverlap : 60));

  const cleaned = normalizeLineEndings(text).trim();
  if (!cleaned) return [];
  if (cleaned.length <= safeMax) return [cleaned];

  const paragraphs = splitParagraphs(cleaned);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) continue;

    if ((current + '\n\n' + trimmedPara).trim().length <= safeMax) {
      current = current ? `${current}\n\n${trimmedPara}` : trimmedPara;
    } else {
      if (current) {
        chunks.push(current);
      }
      if (trimmedPara.length <= safeMax) {
        current = trimmedPara;
      } else {
        let start = 0;
        while (start < trimmedPara.length) {
          const slice = trimmedPara.slice(start, start + safeMax).trim();
          if (slice) chunks.push(slice);
          if (start + safeMax >= trimmedPara.length) break;
          start += Math.max(1, safeMax - safeOverlap);
        }
        current = '';
      }
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

export function normalizeVector(vec: number[]): number[] {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec.slice();
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

export function computeDeterministicEmbedding(
  text: string,
  dimensions: number = OCTO_HEART_FALLBACK_DIMENSIONS
): number[] {
  const vec = new Array<number>(dimensions).fill(0);
  const tokens = tokenizeWords(text, 1);

  if (tokens.length === 0) {
    return vec;
  }

  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    let h1 = 2166136261;
    let h2 = 16777619;
    for (let i = 0; i < token.length; i++) {
      const code = token.charCodeAt(i);
      h1 ^= code;
      h1 = Math.imul(h1, 16777619);
      h2 = (h2 * 31 + code) | 0;
    }
    const idx1 = Math.abs(h1) % dimensions;
    const idx2 = Math.abs(h2) % dimensions;
    const sign = (h1 & 1) === 0 ? 1 : -1;
    const weight = 1 + Math.min(token.length, 10) * 0.08;
    vec[idx1] += sign * weight;
    vec[idx2] += sign * 0.5 * weight;

    if (t + 1 < tokens.length) {
      const bigram = `${token}_${tokens[t + 1]}`;
      let hb = 5381;
      for (let j = 0; j < bigram.length; j++) {
        hb = ((hb << 5) + hb) ^ bigram.charCodeAt(j);
      }
      const idxB = Math.abs(hb) % dimensions;
      vec[idxB] += 0.65;
    }
  }

  return normalizeVector(vec);
}

export const computeEmbeddingVector = computeDeterministicEmbedding;

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  const len = Math.min(vecA.length, vecB.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return Number((dot / denom).toFixed(4));
}

export function dotProductSimilarity(vecA: number[], vecB: number[]): number {
  const len = Math.min(vecA.length, vecB.length);
  if (len === 0) return 0;
  let dot = 0;
  for (let i = 0; i < len; i++) {
    dot += vecA[i] * vecB[i];
  }
  return Number(dot.toFixed(4));
}

export function euclideanSimilarity(vecA: number[], vecB: number[]): number {
  const len = Math.min(vecA.length, vecB.length);
  if (len === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < len; i++) {
    const diff = vecA[i] - vecB[i];
    sumSq += diff * diff;
  }
  const dist = Math.sqrt(sumSq);
  return Number((1 / (1 + dist)).toFixed(4));
}

export function buildVectorIndex(
  documents: RagDocumentInput[],
  chunkSize: number = 420,
  chunkOverlap: number = 60,
  dimensions: number = OCTO_HEART_FALLBACK_DIMENSIONS,
  normalize: boolean = true
): DocumentChunk[] {
  const safeDims = Math.max(64, Math.min(1536, Math.round(Number(dimensions) || OCTO_HEART_FALLBACK_DIMENSIONS)));
  const index: DocumentChunk[] = [];
  for (const doc of documents) {
    if (
      isBinaryOrImageFile(doc.title, undefined, doc.content) ||
      doc.content.startsWith('[Binary Media:') ||
      doc.content.startsWith('[Attached Binary Media:')
    ) {
      continue;
    }
    const rawChunks = chunkDocumentText(doc.content, chunkSize, chunkOverlap);
    rawChunks.forEach((chunkText, idx) => {
      const compositeText = `${doc.title} (${doc.category}): ${chunkText}`;
      const rawVec = computeDeterministicEmbedding(compositeText, safeDims);
      index.push({
        chunkId: `${doc.id}_c${idx}`,
        docId: doc.id,
        docTitle: doc.title,
        category: doc.category,
        chunkIndex: idx,
        text: chunkText,
        vector: normalize ? rawVec : rawVec.map((v) => Number((v * 2).toFixed(6)))
      });
    });
  }
  return index;
}

export async function fetchOctoHeartEmbedding(
  text: string,
  endpointUrl: string = DEFAULT_LLAMA_CPP_BASE_URL,
  model = '',
  dimensions: number = OCTO_HEART_NEURAL_DIMENSIONS,
  normalize: boolean = true
): Promise<{
  vector: number[];
  dimensions: number;
  model: string;
  source: 'llamacpp-octo-heart';
}> {
  const cleanText = String(text || '').trim();
  const targetModel = String(model || '').trim();
  const safeDims = Math.max(64, Math.min(1536, Math.round(Number(dimensions) || OCTO_HEART_NEURAL_DIMENSIONS)));
  if (!cleanText) throw new Error('Embedding text is required.');
  if (!targetModel) throw new Error('Nomic embedding model is required.');

  let base = endpointUrl.trim();
  while (base.endsWith('/')) base = base.slice(0, -1);
  const url = base.endsWith('/v1/embeddings')
    ? base
    : base.endsWith('/v1')
      ? `${base}/embeddings`
      : `${base}/v1/embeddings`;
  const resp = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(1200),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: targetModel,
      input: cleanText
    })
  });
  if (!resp.ok) throw new Error(`Nomic embedding request failed (HTTP ${resp.status}).`);
  const json = (await resp.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const emb = json.data?.[0]?.embedding;
  if (!Array.isArray(emb) || emb.length < safeDims ||
      !emb.slice(0, safeDims).every((value) => Number.isFinite(value))) {
    throw new Error(`Nomic embedding model returned fewer than ${safeDims} valid dimensions.`);
  }
  const sliced = emb.slice(0, safeDims);
  if (!sliced.some((value) => value !== 0)) throw new Error('Nomic embedding model returned an empty vector.');
  const processed = normalize ? normalizeVector(sliced) : sliced;
  return {
    vector: processed,
    dimensions: processed.length,
    model: targetModel,
    source: 'llamacpp-octo-heart'
  };
}

export function searchVectorIndex(
  query: string,
  chunks: DocumentChunk[],
  topK: number = 3,
  minScore: number = 0.45,
  metric: SimilarityMetricId = 'cosine',
  hybridDenseWeight: number = 0.55,
  embedding?: number[]
): RetrievalHit[] {
  const trimmed = query.trim();
  if (!trimmed || chunks.length === 0 || topK <= 0) return [];

  const denseWeight = Math.max(0, Math.min(1, Number(hybridDenseWeight ?? 0.55)));
  const lexicalWeight = Number((1 - denseWeight).toFixed(4));
  const targetDims = chunks[0]?.vector?.length || OCTO_HEART_FALLBACK_DIMENSIONS;
  if (embedding && chunks.some((chunk) => chunk.vector.length !== embedding.length)) {
    throw new Error('Query and document embedding dimensions do not match.');
  }
  const queryVec = embedding ?? computeDeterministicEmbedding(trimmed, targetDims);
  const queryTerms = Array.from(new Set(tokenizeWords(trimmed, 3)));

  const scored: RetrievalHit[] = [];

  for (const chunk of chunks) {
    let denseSim = 0;
    if (metric === 'dotproduct') {
      denseSim = dotProductSimilarity(queryVec, chunk.vector);
    } else if (metric === 'euclidean') {
      denseSim = euclideanSimilarity(queryVec, chunk.vector);
    } else {
      denseSim = cosineSimilarity(queryVec, chunk.vector);
    }

    const haystack = `${chunk.docTitle} ${chunk.category} ${chunk.text}`.toLowerCase();
    let matchedTerms = 0;
    for (const term of queryTerms) {
      if (haystack.includes(term)) {
        matchedTerms += 1;
      }
    }
    const lexicalScore = queryTerms.length > 0 ? matchedTerms / queryTerms.length : 0;
    const hybridScore = Number((denseSim * denseWeight + lexicalScore * lexicalWeight).toFixed(4));

    if (hybridScore >= minScore) {
      scored.push({
        chunkId: chunk.chunkId,
        docId: chunk.docId,
        docTitle: chunk.docTitle,
        category: chunk.category,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        similarityScore: Math.min(0.99, Math.max(0, hybridScore))
      });
    }
  }

  scored.sort((a, b) => b.similarityScore - a.similarityScore);
  return scored.slice(0, topK);
}
