// Diamond Memory Analytics, Hygiene & Import/Export Engine
import { tokenizeWords } from '../structuredParsers';
import { estimateTokenCount } from '../rag/vectorEngine';
import type {
  MemoryFactInput,
  MemoryCategory,
  MemoryStatsReport
} from '../rag/ragTypes';

export function computeMemoryStats(memories: MemoryFactInput[]): MemoryStatsReport {
  const byCategory: Record<MemoryCategory, number> = {
    preference: 0,
    architecture: 0,
    project: 0,
    constraint: 0,
    system_directive: 0,
    user_prompt: 0,
    workflow: 0
  };

  let active = 0;
  let pinned = 0;
  let totalTokens = 0;
  let importanceSum = 0;
  const tagCounts = new Map<string, number>();

  for (const m of memories) {
    if (m.isActive) active++;
    if (m.pinned) pinned++;

    const cat = m.category in byCategory ? m.category : 'preference';
    byCategory[cat]++;

    totalTokens += estimateTokenCount(`${m.key}: ${m.fact}`);
    importanceSum += typeof m.importance === 'number' ? m.importance : 3;

    for (const tag of m.tags || []) {
      const cleanTag = tag.trim().toLowerCase();
      if (cleanTag) {
        tagCounts.set(cleanTag, (tagCounts.get(cleanTag) || 0) + 1);
      }
    }
  }

  const topTags = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const avgImportance =
    memories.length > 0 ? Number((importanceSum / memories.length).toFixed(1)) : 3.0;

  return {
    total: memories.length,
    active,
    pinned,
    byCategory,
    totalTokens,
    avgImportance,
    topTags
  };
}

export function exportMemoriesAsJson(memories: MemoryFactInput[]): string {
  const payload = {
    exportVersion: 'llmcp-memory-v1',
    exportedAt: new Date().toISOString(),
    totalCount: memories.length,
    memories
  };
  return JSON.stringify(payload, null, 2);
}

export function parseAndValidateMemoriesJson(jsonString: string): {
  valid: boolean;
  memories: MemoryFactInput[];
  errors: string[];
} {
  const errors: string[] = [];
  if (!jsonString || typeof jsonString !== 'string') {
    return { valid: false, memories: [], errors: ['Empty or non-string input.'] };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err: any) {
    return { valid: false, memories: [], errors: [`Invalid JSON: ${err?.message || 'parse error'}`] };
  }

  const list: any[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.memories)
      ? parsed.memories
      : [];

  if (list.length === 0) {
    return { valid: false, memories: [], errors: ['No memory objects found in JSON.'] };
  }

  const validated: MemoryFactInput[] = [];

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') {
      errors.push(`Item ${i + 1} is not a valid object.`);
      continue;
    }
    const key = String(item.key || '').trim();
    const fact = String(item.fact || '').trim();
    if (!key || !fact) {
      errors.push(`Item ${i + 1} is missing key or fact.`);
      continue;
    }

    const category: MemoryCategory = [
      'preference', 'architecture', 'project', 'constraint',
      'system_directive', 'user_prompt', 'workflow'
    ].includes(item.category)
      ? item.category
      : 'preference';

    const promptType: 'system' | 'user' =
      item.promptType === 'user' ? 'user' : 'system';

    const mem: MemoryFactInput = {
      id: typeof item.id === 'string' && item.id ? item.id : `mem_${Date.now()}_${i}`,
      key,
      fact,
      category,
      promptType,
      isActive: item.isActive !== false,
      pinned: Boolean(item.pinned),
      importance: typeof item.importance === 'number' ? Math.max(1, Math.min(5, item.importance)) : 3,
      tags: Array.isArray(item.tags) ? item.tags.map(String).filter(Boolean) : [],
      source: 'import',
      sourceSessionId: item.sourceSessionId ? String(item.sourceSessionId) : undefined,
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      accessCount: typeof item.accessCount === 'number' ? item.accessCount : 0
    };
    validated.push(mem);
  }

  return {
    valid: validated.length > 0,
    memories: validated,
    errors
  };
}

export function mergeMemories(
  existing: MemoryFactInput[],
  incoming: MemoryFactInput[],
  mode: 'merge_skip_duplicates' | 'merge_overwrite' | 'replace_all'
): {
  merged: MemoryFactInput[];
  added: number;
  updated: number;
  skipped: number;
} {
  if (mode === 'replace_all') {
    return {
      merged: incoming,
      added: incoming.length,
      updated: 0,
      skipped: 0
    };
  }

  const existingMap = new Map<string, MemoryFactInput>();
  for (const m of existing) {
    existingMap.set(m.key.toLowerCase(), m);
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const inc of incoming) {
    const keyLower = inc.key.toLowerCase();
    const match = existingMap.get(keyLower);

    if (match) {
      if (mode === 'merge_overwrite') {
        existingMap.set(keyLower, {
          ...match,
          ...inc,
          id: match.id,
          updatedAt: new Date().toISOString()
        });
        updated++;
      } else {
        skipped++;
      }
    } else {
      existingMap.set(keyLower, {
        ...inc,
        id: inc.id || `mem_${Date.now()}_${Math.floor(Math.random() * 1000)}`
      });
      added++;
    }
  }

  return {
    merged: Array.from(existingMap.values()),
    added,
    updated,
    skipped
  };
}

export function findDuplicateMemories(
  memories: MemoryFactInput[]
): Array<{ original: MemoryFactInput; duplicate: MemoryFactInput; reason: string }> {
  const duplicates: Array<{ original: MemoryFactInput; duplicate: MemoryFactInput; reason: string }> = [];

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i];
      const b = memories[j];

      if (a.key.toLowerCase() === b.key.toLowerCase()) {
        duplicates.push({ original: a, duplicate: b, reason: 'Identical topic key' });
        continue;
      }

      const tokensA = new Set(tokenizeWords(a.fact.toLowerCase(), 2));
      const tokensB = new Set(tokenizeWords(b.fact.toLowerCase(), 2));
      let intersection = 0;
      for (const t of tokensA) {
        if (tokensB.has(t)) intersection++;
      }
      const union = tokensA.size + tokensB.size - intersection;
      const jaccard = union > 0 ? intersection / union : 0;

      if (jaccard > 0.8) {
        duplicates.push({ original: a, duplicate: b, reason: 'High lexical content overlap (>80%)' });
      }
    }
  }

  return duplicates;
}

