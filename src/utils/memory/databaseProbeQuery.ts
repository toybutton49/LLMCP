import { probeDatabaseMemory } from './memoryProbeEngine';
import { readAppError } from '../appErrors';
import type { MemoryFactInput } from '../rag/ragTypes';
import type { WorkspaceMessage, WorkspaceSession } from '../../data/seedData';

export type ProbeScopeId = 'all' | 'memories' | 'conversations' | 'sessions';

export interface ProbeRecord {
  id: string;
  type: 'memory_directive' | 'conversation_turn' | 'file_chunk' | 'session';
  title: string;
  badge: string;
  snippet: string;
  similarityScore?: number;
  timestamp?: string;
  raw: Record<string, unknown>;
}

export interface ProbeQueryResult {
  scope: ProbeScopeId;
  totalCount: number;
  matchedCount: number;
  durationMs?: number;
  records: ProbeRecord[];
}

export interface ExecuteProbeQueryParams {
  scope: ProbeScopeId;
  filterText: string;
  sortOrder: 'asc' | 'desc';
  limit: number;
  memories: MemoryFactInput[];
  messagesBySession: Record<string, WorkspaceMessage[]>;
  sessions: WorkspaceSession[];
}

export async function fetchLocalDbFallback(): Promise<{
  memories: MemoryFactInput[];
  messagesBySession: Record<string, WorkspaceMessage[]>;
  sessions: WorkspaceSession[];
}> {
  try {
    const [memRes, msgRes, sessRes] = await Promise.all([
      fetch('/api/local-db/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'memories', limit: 200 })
      }),
      fetch('/api/local-db/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'messages', limit: 200 })
      }),
      fetch('/api/local-db/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'sessions', limit: 100 })
      })
    ]);

    let memories: MemoryFactInput[] = [];
    let messagesBySession: Record<string, WorkspaceMessage[]> = {};
    let sessions: WorkspaceSession[] = [];

    if (memRes.ok) {
      const data = (await memRes.json()) as { records?: MemoryFactInput[] };
      memories = data.records || [];
    }
    if (msgRes.ok) {
      const data = (await msgRes.json()) as { records?: WorkspaceMessage[] };
      const grouped: Record<string, WorkspaceMessage[]> = {};
      for (const m of data.records || []) {
        const sid = String(m.sessionId || 'default');
        if (!grouped[sid]) grouped[sid] = [];
        grouped[sid].push(m);
      }
      messagesBySession = grouped;
    }
    if (sessRes.ok) {
      const data = (await sessRes.json()) as { records?: WorkspaceSession[] };
      sessions = data.records || [];
    }

    return { memories, messagesBySession, sessions };
  } catch {
    return { memories: [], messagesBySession: {}, sessions: [] };
  }
}

export function executeProbeQuery(params: ExecuteProbeQueryParams): ProbeQueryResult {
  const {
    scope,
    filterText,
    sortOrder,
    limit,
    memories,
    messagesBySession,
    sessions
  } = params;

  const totalMemCount = memories.length;
  const totalMsgCount = Object.values(messagesBySession).reduce(
    (sum, list) => sum + list.length,
    0
  );
  const totalSessCount = sessions.length;

  let totalCount = 0;
  if (scope === 'all') totalCount = totalMemCount + totalMsgCount;
  else if (scope === 'memories') totalCount = totalMemCount;
  else if (scope === 'conversations') totalCount = totalMsgCount;
  else if (scope === 'sessions') totalCount = totalSessCount;

  const q = filterText.trim().toLowerCase();
  let matchedRecords: ProbeRecord[] = [];

  const sessionTitleMap = new Map<string, string>();
  for (const s of sessions) {
    sessionTitleMap.set(s.id, s.title || 'Chat');
  }

  if (scope === 'sessions') {
    const filteredSessions = q
      ? sessions.filter((s) => {
          const title = String(s.title || '').toLowerCase();
          const id = String(s.id || '').toLowerCase();
          const model = String(s.modelId || '').toLowerCase();
          return title.includes(q) || id.includes(q) || model.includes(q);
        })
      : sessions.slice();

    matchedRecords = filteredSessions.map((s) => ({
      id: s.id,
      type: 'session',
      title: s.title || 'Untitled Session',
      badge: s.modelId || 'llama.cpp',
      snippet: `Messages: ${s.messageCount ?? (messagesBySession[s.id]?.length || 0)}`,
      timestamp: s.updatedAt || '',
      raw: s as unknown as Record<string, unknown>
    }));
  } else if (!q) {
    if (scope === 'all' || scope === 'memories') {
      for (const m of memories) {
        matchedRecords.push({
          id: m.id,
          type: 'memory_directive',
          title: m.key || 'Memory Directive',
          badge: m.category || 'directive',
          snippet: m.fact || '',
          timestamp: m.updatedAt || m.createdAt || '',
          raw: m as unknown as Record<string, unknown>
        });
      }
    }
    if (scope === 'all' || scope === 'conversations') {
      for (const [sessionId, msgList] of Object.entries(messagesBySession)) {
        const sTitle = sessionTitleMap.get(sessionId) || 'Chat';
        for (let i = 0; i < msgList.length; i++) {
          const msg = msgList[i];
          if (!msg || !msg.content) continue;
          const roleStr = String(msg.role || 'user').toUpperCase();
          matchedRecords.push({
            id: msg.id || `${sessionId}_${i}`,
            type: 'conversation_turn',
            title: `${sTitle} (${roleStr})`,
            badge: roleStr,
            snippet: String(msg.content).slice(0, 140),
            timestamp: msg.createdAt || msg.timestamp || '',
            raw: { ...msg, sessionId, sessionTitle: sTitle } as unknown as Record<string, unknown>
          });
        }
      }
    }
  } else {
    const engineScope = scope === 'all' ? 'all' : scope;
    const probeResult = probeDatabaseMemory({
      query: filterText,
      memories,
      messagesBySession,
      sessions,
      scope: engineScope,
      topK: 150
    });

    const seenIds = new Set<string>();
    for (const hit of probeResult.hits) {
      seenIds.add(hit.id);
      matchedRecords.push({
        id: hit.id,
        type: hit.type === 'conversation_turn' ? 'conversation_turn' : 'memory_directive',
        title: hit.title,
        badge:
          hit.type === 'conversation_turn'
            ? `${(hit.role || 'user').toUpperCase()} · Score: ${hit.similarityScore.toFixed(2)}`
            : `${hit.category || 'directive'} · Score: ${hit.similarityScore.toFixed(2)}`,
        snippet: hit.content,
        similarityScore: hit.similarityScore,
        timestamp: hit.timestamp || '',
        raw: hit as unknown as Record<string, unknown>
      });
    }

    if (scope === 'all' || scope === 'memories') {
      for (const m of memories) {
        if (seenIds.has(m.id)) continue;
        const fullText = `${m.key} ${m.fact} ${(m.tags || []).join(' ')}`.toLowerCase();
        if (fullText.includes(q)) {
          seenIds.add(m.id);
          matchedRecords.push({
            id: m.id,
            type: 'memory_directive',
            title: m.key || 'Memory Directive',
            badge: `${m.category || 'directive'} · Keyword`,
            snippet: m.fact || '',
            similarityScore: 0.8,
            timestamp: m.updatedAt || m.createdAt || '',
            raw: m as unknown as Record<string, unknown>
          });
        }
      }
    }

    if (scope === 'all' || scope === 'conversations') {
      for (const [sessionId, msgList] of Object.entries(messagesBySession)) {
        const sTitle = sessionTitleMap.get(sessionId) || 'Chat';
        for (let i = 0; i < msgList.length; i++) {
          const msg = msgList[i];
          if (!msg || !msg.content) continue;
          const msgId = msg.id || `${sessionId}_${i}`;
          if (seenIds.has(msgId)) continue;
          const contentLower = String(msg.content).toLowerCase();
          if (contentLower.includes(q)) {
            seenIds.add(msgId);
            const roleStr = String(msg.role || 'user').toUpperCase();
            matchedRecords.push({
              id: msgId,
              type: 'conversation_turn',
              title: `${sTitle} (${roleStr})`,
              badge: `${roleStr} · Keyword`,
              snippet: String(msg.content).slice(0, 140),
              similarityScore: 0.8,
              timestamp: msg.createdAt || msg.timestamp || '',
              raw: { ...msg, sessionId, sessionTitle: sTitle } as unknown as Record<string, unknown>
            });
          }
        }
      }
    }
  }

  if (sortOrder === 'asc') {
    matchedRecords = matchedRecords.slice().reverse();
  }

  return {
    scope,
    totalCount,
    matchedCount: matchedRecords.length,
    records: matchedRecords.slice(0, limit)
  };
}

interface SemanticProbeHit {
  id: string;
  type: 'conversation_turn' | 'file_chunk' | 'memory_rule';
  title: string;
  role?: string;
  content: string;
  similarityScore: number;
  timestamp?: string;
}

/** Ranks stored items with the selected Nomic embedding model; failures are thrown, never approximated. */
export async function executeSemanticProbe(params: {
  query: string;
  scope: Exclude<ProbeScopeId, 'sessions'>;
  limit: number;
  signal?: AbortSignal;
}): Promise<ProbeQueryResult> {
  const response = await fetch('/api/memory/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: params.signal,
    body: JSON.stringify({
      query: params.query,
      scope: params.scope,
      topK: Math.min(params.limit, 20),
      maxTokens: 4000
    })
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(readAppError(data, `Memory probe returned HTTP ${response.status}.`));
  const payload = data as { hits?: SemanticProbeHit[]; totalRecordsScanned?: number; durationMs?: number } | null;
  if (!payload || !Array.isArray(payload.hits)) throw new Error('Memory probe returned malformed results.');
  const records: ProbeRecord[] = payload.hits.map((hit) => {
    const type = hit.type === 'memory_rule' ? 'memory_directive' : hit.type;
    const kind = type === 'conversation_turn' ? String(hit.role || 'user').toUpperCase()
      : type === 'file_chunk' ? 'FILE' : 'DIRECTIVE';
    return {
      id: hit.id,
      type,
      title: hit.title,
      badge: `${kind} · Score: ${hit.similarityScore.toFixed(2)}`,
      snippet: hit.content,
      similarityScore: hit.similarityScore,
      timestamp: hit.timestamp,
      raw: hit as unknown as Record<string, unknown>
    };
  });
  return {
    scope: params.scope,
    totalCount: payload.totalRecordsScanned ?? records.length,
    matchedCount: records.length,
    durationMs: payload.durationMs,
    records
  };
}
