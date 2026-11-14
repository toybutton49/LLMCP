import type {
  MemoryFactInput,
  MemoryCategory,
  MemorySearchResult,
  MemoryCandidateExtraction,
  MemoryStatsReport
} from '../utils/rag/ragTypes';
import { mutateMemoryItem } from '../utils/rag/promptAndMutations';
import {
  extractDiamondMemoryCandidate,
  searchMemoriesSemantically,
  selectMemoriesForContext,
  computeMemoryStats,
  exportMemoriesAsJson,
  parseAndValidateMemoriesJson,
  mergeMemories,
  findDuplicateMemories,
  probeDatabaseMemory,
  ProbeDatabaseMemoryParams,
  DatabaseMemoryProbeResult,
  DatabaseMemoryProbeHit,
  createCuid,
  createCuidTag,
  masterVectorMap
} from '../utils/memory';
import { SystemPromptTemplate, INITIAL_PROMPT_TEMPLATES } from '../data/seedData';

/**
 * Diamond Memory & Persona Arm Orchestrator:
 * Single source of truth for persistent memory facts, candidate fact extraction,
 * Octo Heart semantic context circulation, hygiene, analytics, and persona templates.
 */
export class MemoryOrchestrator {
  public readonly domain = 'memory_and_personas';
  public readonly suctionCups = [
    'GET /api/local-db',
    'POST /api/local-db/sync',
    'POST /api/local-db/query',
    'POST /api/memory/probe'
  ];

  public addMemory(
    memories: MemoryFactInput[],
    input: Omit<MemoryFactInput, 'id'>
  ): MemoryFactInput[] {
    const nowIso = new Date().toISOString();
    const cuid = input.cuid || createCuid();
    const cuidTags = Array.isArray(input.cuidTags) && input.cuidTags.length > 0
      ? input.cuidTags
      : [createCuidTag('rule', input.category || 'directive', cuid)];

    const newMem: MemoryFactInput = {
      id: `mem_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      cuid,
      cuidTags,
      ...input,
      key: input.key.trim(),
      fact: (input.fact || '').trim(),
      category: input.category || 'system_directive',
      promptType: input.promptType || 'system',
      isActive: input.isActive ?? true,
      pinned: input.pinned ?? false,
      importance: typeof input.importance === 'number' ? Math.max(1, Math.min(5, input.importance)) : 3,
      tags: Array.isArray(input.tags) ? input.tags : [],
      source: input.source || 'manual',
      createdAt: input.createdAt || nowIso,
      updatedAt: nowIso,
      accessCount: input.accessCount || 0
    };

    masterVectorMap.indexUnit({
      entityId: newMem.id,
      type: 'persistent_rule',
      content: `${newMem.key}: ${newMem.fact}`,
      cuidTags: newMem.cuidTags,
      vector: newMem.vector
    });

    return [newMem, ...memories];
  }

  public updateMemory(
    memories: MemoryFactInput[],
    id: string,
    updates: Partial<Omit<MemoryFactInput, 'id'>>
  ): MemoryFactInput[] {
    return mutateMemoryItem(memories, id, updates);
  }

  public toggleMemory(memories: MemoryFactInput[], id: string): MemoryFactInput[] {
    return memories.map((m) =>
      m.id === id ? { ...m, isActive: !m.isActive, updatedAt: new Date().toISOString() } : m
    );
  }

  public togglePin(memories: MemoryFactInput[], id: string): MemoryFactInput[] {
    return memories.map((m) =>
      m.id === id ? { ...m, pinned: !m.pinned, updatedAt: new Date().toISOString() } : m
    );
  }

  public setImportance(memories: MemoryFactInput[], id: string, importance: number): MemoryFactInput[] {
    const safeImp = Math.max(1, Math.min(5, Math.round(importance)));
    return memories.map((m) =>
      m.id === id ? { ...m, importance: safeImp, updatedAt: new Date().toISOString() } : m
    );
  }

  public setTags(memories: MemoryFactInput[], id: string, tags: string[]): MemoryFactInput[] {
    return memories.map((m) =>
      m.id === id ? { ...m, tags, updatedAt: new Date().toISOString() } : m
    );
  }

  public deleteMemory(memories: MemoryFactInput[], id: string): MemoryFactInput[] {
    return memories.filter((m) => m.id !== id);
  }

  public bulkToggle(memories: MemoryFactInput[], ids: string[], isActive: boolean): MemoryFactInput[] {
    const idSet = new Set(ids);
    const nowIso = new Date().toISOString();
    return memories.map((m) =>
      idSet.has(m.id) ? { ...m, isActive, updatedAt: nowIso } : m
    );
  }

  public bulkDelete(memories: MemoryFactInput[], ids: string[]): MemoryFactInput[] {
    const idSet = new Set(ids);
    return memories.filter((m) => !idSet.has(m.id));
  }

  public getActiveMemories(memories: MemoryFactInput[]): MemoryFactInput[] {
    return memories.filter((m) => m.isActive);
  }

  public getPinnedMemories(memories: MemoryFactInput[]): MemoryFactInput[] {
    return memories.filter((m) => m.isActive && m.pinned);
  }

  public searchMemories(
    query: string,
    memories: MemoryFactInput[],
    options?: {
      topK?: number;
      minSimilarityScore?: number;
      hybridDenseWeight?: number;
      includeInactive?: boolean;
    }
  ): MemorySearchResult[] {
    return searchMemoriesSemantically({
      query,
      memories,
      topK: options?.topK ?? 5,
      minSimilarityScore: options?.minSimilarityScore ?? 0.08,
      hybridDenseWeight: options?.hybridDenseWeight ?? 0.65,
      includeInactive: options?.includeInactive ?? false
    });
  }

  public selectContextMemories(
    userPrompt: string,
    memories: MemoryFactInput[],
    options?: { maxMemoryTokens?: number; maxMemories?: number }
  ): {
    injectedMemories: MemoryFactInput[];
    pinnedCount: number;
    dynamicCount: number;
    memoryTokens: number;
  } {
    return selectMemoriesForContext({
      userPrompt,
      memories,
      maxMemoryTokens: options?.maxMemoryTokens ?? 800,
      maxMemories: options?.maxMemories ?? 12
    });
  }

  public probeDatabase(
    params: ProbeDatabaseMemoryParams
  ): DatabaseMemoryProbeResult {
    return probeDatabaseMemory(params);
  }

  public recordMemoryAccess(memories: MemoryFactInput[], accessedIds: string[]): MemoryFactInput[] {
    if (accessedIds.length === 0) return memories;
    const idSet = new Set(accessedIds);
    const nowIso = new Date().toISOString();
    return memories.map((m) =>
      idSet.has(m.id)
        ? {
            ...m,
            lastAccessedAt: nowIso,
            accessCount: (m.accessCount || 0) + 1
          }
        : m
    );
  }

  public extractCandidate(
    promptText: string,
    existingMemories: MemoryFactInput[] = []
  ): MemoryCandidateExtraction | null {
    return extractDiamondMemoryCandidate(promptText, existingMemories);
  }

  public extractCandidateFacts(
    promptText: string,
    existingMemories: MemoryFactInput[] = []
  ): Array<Omit<MemoryFactInput, 'id'>> {
    const res = this.extractCandidate(promptText, existingMemories);
    return res ? [res.candidate] : [];
  }

  public getStats(memories: MemoryFactInput[]): MemoryStatsReport {
    return computeMemoryStats(memories);
  }

  public exportJson(memories: MemoryFactInput[]): string {
    return exportMemoriesAsJson(memories);
  }

  public importJson(
    jsonString: string,
    currentMemories: MemoryFactInput[],
    mode: 'merge_skip_duplicates' | 'merge_overwrite' | 'replace_all' = 'merge_skip_duplicates'
  ): {
    success: boolean;
    memories: MemoryFactInput[];
    added: number;
    updated: number;
    skipped: number;
    errors: string[];
  } {
    const parsed = parseAndValidateMemoriesJson(jsonString);
    if (!parsed.valid || parsed.memories.length === 0) {
      return {
        success: false,
        memories: currentMemories,
        added: 0,
        updated: 0,
        skipped: 0,
        errors: parsed.errors
      };
    }
    const mergedResult = mergeMemories(currentMemories, parsed.memories, mode);
    return {
      success: true,
      memories: mergedResult.merged,
      added: mergedResult.added,
      updated: mergedResult.updated,
      skipped: mergedResult.skipped,
      errors: parsed.errors
    };
  }

  public deduplicate(memories: MemoryFactInput[]): {
    cleaned: MemoryFactInput[];
    removedCount: number;
    duplicates: Array<{ original: MemoryFactInput; duplicate: MemoryFactInput; reason: string }>;
  } {
    const dupes = findDuplicateMemories(memories);
    if (dupes.length === 0) {
      return { cleaned: memories, removedCount: 0, duplicates: [] };
    }
    const idsToRemove = new Set(dupes.map((d) => d.duplicate.id));
    const cleaned = memories.filter((m) => !idsToRemove.has(m.id));
    return {
      cleaned,
      removedCount: idsToRemove.size,
      duplicates: dupes
    };
  }

  public getDefaultTemplates(): SystemPromptTemplate[] {
    return [...INITIAL_PROMPT_TEMPLATES];
  }

  public addTemplate(
    templates: SystemPromptTemplate[],
    input: Omit<SystemPromptTemplate, 'id'>
  ): SystemPromptTemplate[] {
    const newTpl: SystemPromptTemplate = {
      id: `tpl_${Date.now()}`,
      name: input.name.trim(),
      category: input.category || 'Custom',
      roleCategory: input.roleCategory || input.category || 'Custom',
      roleBadge: input.roleBadge || 'Custom Persona',
      description: input.description || '',
      systemPrompt: input.systemPrompt,
      defaultTemperature: input.defaultTemperature ?? 0.7
    };
    return [newTpl, ...templates];
  }

  public updateTemplate(
    templates: SystemPromptTemplate[],
    id: string,
    updates: Partial<Omit<SystemPromptTemplate, 'id'>>
  ): SystemPromptTemplate[] {
    return templates.map((t) => (t.id === id ? { ...t, ...updates } : t));
  }

  public deleteTemplate(templates: SystemPromptTemplate[], id: string): SystemPromptTemplate[] {
    return templates.filter((t) => t.id !== id);
  }
}
