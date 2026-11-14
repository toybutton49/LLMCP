import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  executeProbeQuery,
  executeSemanticProbe,
  ProbeScopeId
} from '../../src/utils/memory/databaseProbeQuery';
import type { MemoryFactInput } from '../../src/utils/rag/ragTypes';
import type { WorkspaceMessage, WorkspaceSession } from '../../src/data/seedData';

const ROOT_DIR = process.cwd();

test('Database Comparison Cards: Explanations and active highlighting for Probe DB vs Local DB', () => {
  const cardsPath = path.join(
    ROOT_DIR,
    'src',
    'components',
    'database',
    'DatabaseComparisonCards.tsx'
  );
  assert.equal(fs.existsSync(cardsPath), true, 'DatabaseComparisonCards.tsx must exist');

  const content = fs.readFileSync(cardsPath, 'utf-8');
  assert.ok(
    content.includes('Probe DB (Semantic Retrieval)'),
    'Must define Probe DB title'
  );
  assert.ok(
    content.includes('Local Database Query Explorer (Real Disk DB)'),
    'Must define Local Database Query Explorer title'
  );
  assert.ok(
    content.includes('Active View'),
    'Must render Active View badge for currently viewing card'
  );
  assert.ok(
    content.includes('border-accent/40') && content.includes('bg-accent-subtle'),
    'Must style active card with accent border and subtle accent background'
  );

  const dbSettingsContent = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'settings', 'DatabaseQuerySettings.tsx'),
    'utf-8'
  );
  assert.ok(
    dbSettingsContent.includes('DatabaseComparisonCards activeView="local_db"'),
    'DatabaseQuerySettings must embed DatabaseComparisonCards with activeView=local_db'
  );

  const proberContent = fs.readFileSync(
    path.join(ROOT_DIR, 'src', 'components', 'memory', 'DatabaseMemoryProber.tsx'),
    'utf-8'
  );
  assert.ok(
    proberContent.includes('DatabaseComparisonCards activeView="probe"'),
    'DatabaseMemoryProber must embed DatabaseComparisonCards with activeView=probe'
  );
});

test('DatabaseMemoryProber: Normalized design language matches DatabaseQuerySettings', () => {
  const proberPath = path.join(
    ROOT_DIR,
    'src',
    'components',
    'memory',
    'DatabaseMemoryProber.tsx'
  );
  const proberContent = fs.readFileSync(proberPath, 'utf-8');

  // 1. View mode toggle (Cards vs Raw JSON)
  assert.ok(
    proberContent.includes("viewMode === 'cards'"),
    'Must support Cards view mode'
  );
  assert.ok(
    proberContent.includes("viewMode === 'json'"),
    'Must support Raw JSON view mode'
  );

  // 2. Redundant Run Probe button is removed; queries execute reactively and on Enter
  assert.equal(
    proberContent.includes('Run Probe'),
    false,
    'Redundant Run Probe button must be removed'
  );

  // 3. Scope selector pills
  assert.ok(proberContent.includes('All Stores'), 'Must provide All Stores pill');
  assert.ok(proberContent.includes('Directives'), 'Must provide Directives pill');
  assert.ok(proberContent.includes('Chat History'), 'Must provide Chat History pill');
  assert.ok(proberContent.includes('Sessions'), 'Must provide Sessions pill');

  // 4. Query filter controls: Search input, Sort order, and Limit dropdowns
  assert.ok(
    proberContent.includes('aria-label="Filter database records"'),
    'Must provide search filter input'
  );
  assert.ok(
    proberContent.includes('aria-label="Sort order"'),
    'Must provide sort order select'
  );
  assert.ok(
    proberContent.includes('aria-label="Record limit"'),
    'Must provide record limit select'
  );

  // 5. Query metrics header
  assert.ok(
    proberContent.includes('Query execution:'),
    'Must display query execution time in ms'
  );
  assert.ok(
    proberContent.includes('Matched'),
    'Must display matched records count'
  );

  // 6. Card items: copy JSON and expandable raw JSON accordion
  assert.ok(
    proberContent.includes('Copy record JSON'),
    'Must provide Copy record JSON action'
  );
  assert.ok(
    proberContent.includes('Expand full JSON payload'),
    'Must provide accordion chevron to expand raw JSON'
  );
});

test('Probe DB Capabilities: executeProbeQuery searches both memory directives and past chat conversations', () => {
  const testMemories: MemoryFactInput[] = [
    {
      id: 'mem_sqlite_1',
      key: 'SQLite Database Store',
      fact: 'We store structured metadata in atomic JSON snapshots alongside SQLite tables.',
      category: 'architecture',
      isActive: true,
      pinned: true
    },
    {
      id: 'mem_style_2',
      key: 'Code Style Tabs',
      fact: 'Always format files using standard 2 spaces.',
      category: 'preference',
      isActive: true
    }
  ];

  const testSessions: WorkspaceSession[] = [
    {
      id: 'session_alpha',
      title: 'Database Architecture Review',
      providerId: 'llamacpp',
      modelId: 'qwen2.5',
      temperature: 0.2,
      systemPrompt: '',
      ragEnabled: true,
      vaultEnabled: true,
      vaultScopeMode: 'all',
      memoryEnabled: true,
      enabledPluginIds: [],
      updatedAt: '2026-11-08T12:00:00Z',
      messageCount: 2
    }
  ];

  const testMessages: Record<string, WorkspaceMessage[]> = {
    session_alpha: [
      {
        id: 'msg_alpha_1',
        sessionId: 'session_alpha',
        role: 'user',
        content: 'Should we configure SQLite with WAL mode for our local database?'
      },
      {
        id: 'msg_alpha_2',
        sessionId: 'session_alpha',
        role: 'assistant',
        content: 'Yes, WAL mode enables concurrent reads without locking disk writes.'
      }
    ]
  };

  // Run query across scope 'all' targeting 'sqlite'
  const result = executeProbeQuery({
    scope: 'all',
    filterText: 'sqlite',
    sortOrder: 'desc',
    limit: 25,
    memories: testMemories,
    messagesBySession: testMessages,
    sessions: testSessions
  });

  assert.ok(result.records.length >= 2, 'Must match across both directives and chat history');
  const directiveHit = result.records.find((r) => r.type === 'memory_directive');
  const chatHit = result.records.find((r) => r.type === 'conversation_turn');

  assert.ok(directiveHit, 'Must find memory directive hit');
  assert.ok(directiveHit.snippet.includes('SQLite'), 'Directive hit contains SQLite content');
  assert.ok(chatHit, 'Must find past chat conversation hit');
  assert.ok(chatHit.snippet.includes('SQLite'), 'Chat hit contains SQLite discussion');
});

test('Probe DB Capabilities: Scope-isolated probing (directives only vs conversations only vs sessions)', () => {
  const testMemories: MemoryFactInput[] = [
    {
      id: 'm1',
      key: 'Security Policy',
      fact: 'Snapshot files must be encrypted with PBKDF2.',
      category: 'constraint',
      isActive: true
    }
  ];

  const testSessions: WorkspaceSession[] = [
    {
      id: 's1',
      title: 'Security Sync Session',
      providerId: 'llamacpp',
      modelId: 'qwen2.5',
      temperature: 0.2,
      systemPrompt: '',
      ragEnabled: true,
      vaultEnabled: true,
      vaultScopeMode: 'all',
      memoryEnabled: true,
      enabledPluginIds: [],
      updatedAt: '2026-11-09T10:00:00Z',
      messageCount: 1
    }
  ];

  const testMessages: Record<string, WorkspaceMessage[]> = {
    s1: [
      {
        id: 'msg_sec_1',
        sessionId: 's1',
        role: 'assistant',
        content: 'We implemented AES-256 encryption for user security.'
      }
    ]
  };

  // Scope: memories only
  const memOnly = executeProbeQuery({
    scope: 'memories',
    filterText: 'security',
    sortOrder: 'desc',
    limit: 10,
    memories: testMemories,
    messagesBySession: testMessages,
    sessions: testSessions
  });
  assert.ok(memOnly.records.every((r) => r.type === 'memory_directive'), 'memories scope must only yield directives');

  // Scope: conversations only
  const chatOnly = executeProbeQuery({
    scope: 'conversations',
    filterText: 'security',
    sortOrder: 'desc',
    limit: 10,
    memories: testMemories,
    messagesBySession: testMessages,
    sessions: testSessions
  });
  assert.ok(chatOnly.records.every((r) => r.type === 'conversation_turn'), 'conversations scope must only yield chat turns');

  // Scope: sessions only
  const sessOnly = executeProbeQuery({
    scope: 'sessions',
    filterText: 'security',
    sortOrder: 'desc',
    limit: 10,
    memories: testMemories,
    messagesBySession: testMessages,
    sessions: testSessions
  });
  assert.ok(sessOnly.records.every((r) => r.type === 'session'), 'sessions scope must only yield session records');
});

test('Probe DB Capabilities: Empty filter returns all records in scope up to limit, respecting sort order', () => {
  const testMemories: MemoryFactInput[] = [
    { id: 'm1', key: 'Fact One', fact: 'Alpha rule', category: 'architecture', isActive: true, updatedAt: '2026-11-01T00:00:00Z' },
    { id: 'm2', key: 'Fact Two', fact: 'Beta rule', category: 'preference', isActive: true, updatedAt: '2026-11-02T00:00:00Z' }
  ];

  const resDesc = executeProbeQuery({
    scope: 'memories',
    filterText: '',
    sortOrder: 'desc',
    limit: 25,
    memories: testMemories,
    messagesBySession: {},
    sessions: []
  });

  assert.equal(resDesc.totalCount, 2, 'Total count matches memory total');
  assert.equal(resDesc.matchedCount, 2, 'Empty filter matches all records');
  assert.equal(resDesc.records.length, 2, 'Returns both records');

  // Test limit capping
  const resLimited = executeProbeQuery({
    scope: 'memories',
    filterText: '',
    sortOrder: 'desc',
    limit: 1,
    memories: testMemories,
    messagesBySession: {},
    sessions: []
  });
  assert.equal(resLimited.records.length, 1, 'Limit restricts returned records');
  assert.equal(resLimited.matchedCount, 2, 'Matched count retains total matches');
});

test('MemoryAndPromptsView integrates Probe DB tab and allows direct navigation', () => {
  const viewPath = path.join(ROOT_DIR, 'src', 'components', 'MemoryAndPromptsView.tsx');
  const viewContent = fs.readFileSync(viewPath, 'utf-8');

  assert.ok(
    viewContent.includes("setActiveTab('probe_db')"),
    'Must provide tab switch button to probe_db'
  );
  assert.ok(
    viewContent.includes("activeTab === 'probe_db'"),
    'Must render DatabaseMemoryProber when probe_db is active'
  );
  assert.ok(
    viewContent.includes('DatabaseMemoryProber'),
    'Must import and use DatabaseMemoryProber'
  );
});

test('Normalized Data Rendering: getRecordSummary produces uniform summary format', async () => {
  const { getRecordSummary } = await import(
    '../../src/components/database/databaseFormatters'
  );

  const sessionSummary = getRecordSummary(
    { title: 'Test Session', modelId: 'llama-3.2-3b', messages: [1, 2, 3] },
    'sessions'
  );
  assert.equal(sessionSummary.title, 'Test Session');
  assert.equal(sessionSummary.badge, 'llama-3.2-3b');
  assert.equal(sessionSummary.snippet, 'Messages: 3');

  const msgSummary = getRecordSummary(
    { role: 'user', content: 'How do I query SQLite WAL mode?', sessionId: 'session_123' },
    'messages'
  );
  assert.ok(msgSummary.title.includes('USER Message'));
  assert.equal(msgSummary.badge, 'USER');
  assert.ok(msgSummary.snippet.includes('SQLite WAL'));

  const memSummary = getRecordSummary(
    { key: 'WAL Persistence', fact: 'Enable WAL mode for concurrency', category: 'architecture' },
    'memories'
  );
  assert.equal(memSummary.title, 'WAL Persistence');
  assert.equal(memSummary.badge, 'architecture');
  assert.equal(memSummary.snippet, 'Enable WAL mode for concurrency');

  const fileSummary = getRecordSummary(
    { fileName: 'schema.sql', chunkCount: 4, collection: 'default', sha256Preview: 'ab12cd' },
    'vaultFiles'
  );
  assert.equal(fileSummary.title, 'schema.sql');
  assert.equal(fileSummary.badge, '4 chunks');
  assert.ok(fileSummary.snippet.includes('SHA: ab12cd'));
});

test('Both Database Views normalize navigation and allow seamless switching', () => {
  const proberPath = path.join(ROOT_DIR, 'src', 'components', 'memory', 'DatabaseMemoryProber.tsx');
  const proberContent = fs.readFileSync(proberPath, 'utf-8');

  const settingsPath = path.join(ROOT_DIR, 'src', 'components', 'settings', 'DatabaseQuerySettings.tsx');
  const settingsContent = fs.readFileSync(settingsPath, 'utf-8');

  assert.ok(
    proberContent.includes("activeView === 'probe'") && proberContent.includes('setActiveView'),
    'DatabaseMemoryProber must support toggling between probe and local_db views'
  );
  assert.ok(
    settingsContent.includes("activeView === 'local_db'") && settingsContent.includes('setActiveView'),
    'DatabaseQuerySettings must support toggling between local_db and probe views'
  );

  assert.ok(
    proberContent.includes('getRecordSummary') && settingsContent.includes('getRecordSummary'),
    'Both database views must use normalized getRecordSummary for identical data formatting'
  );
});

test('Semantic probe ranks with the embedding endpoint and reports failures instead of approximating', async (t) => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (calls.length === 1) {
      return Response.json({
        totalRecordsScanned: 5, durationMs: 12,
        hits: [{ id: 'cabc', type: 'memory_rule', title: 'Coffee', content: 'Oat milk.', similarityScore: 0.56 }]
      });
    }
    return Response.json({ error: 'Nomic memory retrieval failed: model missing' }, { status: 503 });
  });
  const ok = await executeSemanticProbe({ query: 'morning brew', scope: 'all', limit: 50 });
  assert.equal(calls[0].url, '/api/memory/probe');
  assert.equal(calls[0].body.topK, 20, 'topK is capped at the endpoint maximum');
  assert.equal(ok.totalCount, 5);
  assert.equal(ok.records[0].type, 'memory_directive');
  assert.equal(ok.records[0].badge, 'DIRECTIVE · Score: 0.56');
  await assert.rejects(
    executeSemanticProbe({ query: 'morning brew', scope: 'memories', limit: 10 }),
    /model missing/
  );
});
