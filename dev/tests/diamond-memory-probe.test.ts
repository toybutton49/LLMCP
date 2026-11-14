import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  MemoryOrchestrator,
  orchestrator
} from '../../src/orchestrators';
import {
  extractDiamondMemoryCandidate,
  synthesizeMemoryKey
} from '../../src/utils/memory/memoryScanner';
import {
  searchMemoriesSemantically,
  selectMemoriesForContext
} from '../../src/utils/memory/memoryVectorEngine';
import {
  probeDatabaseMemory,
  DatabaseMemoryProbeResult
} from '../../src/utils/memory/memoryProbeEngine';
import {
  computeMemoryStats,
  exportMemoriesAsJson,
  parseAndValidateMemoriesJson,
  mergeMemories,
  findDuplicateMemories
} from '../../src/utils/memory/memoryStats';
import {
  createCuid,
  createCuidTag,
  isCuid,
  MasterVectorMap
} from '../../src/utils/memory';
import { OctoVectorDatabase } from '../../src/utils/memory/octoVectorDatabase';
import { invokeToolCallByName } from '../../src/tools';
import type { MemoryFactInput } from '../../src/utils/rag/ragTypes';
import type { WorkspaceMessage, WorkspaceSession } from '../../src/data/seedData';

test('Diamond Memory Scanner: Programmatic Heuristic Fact & Directive Extraction (Zero Regex)', () => {
  // 1. Negative Constraint extraction
  const constraintPrompt = 'Please note: never allow yellow utilities or external wrappers in our code';
  const candConstraint = extractDiamondMemoryCandidate(constraintPrompt);
  assert.ok(candConstraint, 'Candidate constraint extracted');
  assert.equal(candConstraint.candidate.category, 'constraint');
  assert.equal(candConstraint.candidate.pinned, true, 'Constraints default to pinned');
  assert.equal(candConstraint.candidate.importance, 5, 'Constraints have maximum importance');
  assert.ok(candConstraint.confidence >= 0.9, 'Confidence is high for explicit constraint');

  // 2. Architecture Rule extraction
  const archPrompt = 'Remember that our database is SQLite with local atomic file snapshots in .local-data';
  const candArch = extractDiamondMemoryCandidate(archPrompt);
  assert.ok(candArch, 'Candidate architecture extracted');
  assert.equal(candArch.candidate.category, 'architecture');
  assert.ok(candArch.candidate.fact.includes('SQLite'), 'Fact preserves database specification');

  // 3. User Preference extraction
  const prefPrompt = 'I prefer TypeScript strict mode and explicit return types for all suction cups';
  const candPref = extractDiamondMemoryCandidate(prefPrompt);
  assert.ok(candPref, 'Candidate preference extracted');
  assert.equal(candPref.candidate.category, 'preference');
  assert.equal(candPref.candidate.promptType, 'user');

  // 4. Non-directive conversation text rejection
  const genericPrompt = 'Hello, can you help me write a function to format dates today?';
  const candGeneric = extractDiamondMemoryCandidate(genericPrompt);
  assert.equal(candGeneric, null, 'Generic prompts return zero candidate rules');

  assert.equal(extractDiamondMemoryCandidate('From the OCR document in my File Repo, what is the document code?'), null);
  assert.equal(extractDiamondMemoryCandidate('What is in my database?'), null);
  assert.equal(extractDiamondMemoryCandidate('What code is in the image? Answer from the File Repo context.'), null);
  assert.ok(extractDiamondMemoryCandidate('What is in the repo? Always use TypeScript for this project.'));
  assert.ok(extractDiamondMemoryCandidate('Can you remember that our database is SQLite?'));
});

test('Diamond Memory Scanner: Conflict Detection and Key Synthesis', () => {
  const existing: MemoryFactInput[] = [
    {
      id: 'mem_1',
      key: 'Preference: Indentation Tabs',
      fact: 'Always use tabs for indentation',
      category: 'preference',
      isActive: true
    }
  ];

  // Conflicting polarity directive
  const conflictingPrompt = 'Always use spaces for indentation, never use tabs';
  const extraction = extractDiamondMemoryCandidate(conflictingPrompt, existing);
  assert.ok(extraction, 'Extraction succeeds');
  assert.ok(extraction.conflictWarning, 'Detects polarity conflict with existing memory');

  // Key synthesis test
  const synthesized = synthesizeMemoryKey('keep source files under 600 lines', 'constraint');
  assert.ok(synthesized.startsWith('Constraint:'), 'Synthesizes clean category prefix');
});

test('Octo Heart Semantic Memory Circulation: Vector Search & Relevance Ranking', () => {
  const memories: MemoryFactInput[] = [
    {
      id: 'm1',
      key: 'Vector Dimension',
      fact: 'Octo Heart operates at 768d dense vectors with 384d fallback',
      category: 'architecture',
      isActive: true,
      importance: 4
    },
    {
      id: 'm2',
      key: 'SQLite DB',
      fact: 'Persistence saves to .local-data/llmcp-db.json atomically',
      category: 'architecture',
      isActive: true,
      importance: 3
    },
    {
      id: 'm3',
      key: 'Color Scheme',
      fact: 'Always use signature salmon accent #f27261 and dark zinc surfaces',
      category: 'system_directive',
      isActive: true,
      pinned: true,
      importance: 5
    },
    {
      id: 'm4',
      key: 'Deactivated Rule',
      fact: 'Legacy rule that is currently turned off',
      category: 'preference',
      isActive: false
    }
  ];

  // Search for vector-related memories
  const vectorHits = searchMemoriesSemantically({
    query: 'What vector embedding dimensions does the Octo Heart use?',
    memories,
    topK: 3
  });

  assert.ok(vectorHits.length > 0, 'Returns memory hits');
  // Pinned items float or top hits match
  const topMatch = vectorHits.find((h) => h.memory.id === 'm1');
  assert.ok(topMatch, 'Vector dimension memory found');
  assert.ok(topMatch.similarityScore > 0.2, 'High semantic relevance score');

  // Deactivated memories are excluded by default
  const inactiveHit = vectorHits.find((h) => h.memory.id === 'm4');
  assert.equal(inactiveHit, undefined, 'Inactive memories are excluded');
});

test('Octo Heart Context Selection: Budget Capping and Pinned Priority', () => {
  const memories: MemoryFactInput[] = [
    {
      id: 'pin_1',
      key: 'Critical Guard',
      fact: 'Keep source files at or below 600 lines and prefer modular files',
      category: 'constraint',
      pinned: true,
      isActive: true,
      importance: 5
    },
    {
      id: 'dyn_1',
      key: 'Python Engine',
      fact: 'Use available local tools only when relevant to the request',
      category: 'architecture',
      isActive: true,
      importance: 3
    },
    {
      id: 'dyn_2',
      key: 'Css Layout',
      fact: 'Use comfortable or compact ui density settings',
      category: 'preference',
      isActive: true,
      importance: 2
    }
  ];

  const selection = selectMemoriesForContext({
    userPrompt: 'How do we execute Python code safely?',
    memories,
    maxMemoryTokens: 400
  });

  assert.ok(selection.injectedMemories.length >= 2, 'Injects both pinned and relevant dynamic memories');
  assert.equal(selection.pinnedCount, 1, 'Pinned memory is preserved');
  assert.ok(
    selection.injectedMemories.some((m) => m.id === 'pin_1'),
    'Pinned guardrail is always injected'
  );
  assert.ok(
    selection.injectedMemories.some((m) => m.id === 'dyn_1'),
    'Python memory is semantically retrieved for python prompt'
  );
  assert.ok(selection.memoryTokens <= 400, 'Memory token budget is respected');
});

test('Database Memory Probing Engine: Probes Live Context Stores Across Past Chats & Rules', () => {
  const memories: MemoryFactInput[] = [
    {
      id: 'mem_arch_1',
      key: 'Encrypted DB Snapshots',
      fact: 'Snapshots use PBKDF2 with 100,000 iterations and AES-256-GCM',
      category: 'architecture',
      isActive: true,
      pinned: true
    }
  ];

  const sessions: WorkspaceSession[] = [
    {
      id: 'session_past_1',
      title: 'Database Architecture Review',
      providerId: 'llamacpp',
      modelId: 'test-model',
      temperature: 0.3,
      systemPrompt: '',
      ragEnabled: true,
      vaultEnabled: true,
      vaultScopeMode: 'all',
      memoryEnabled: true,
      enabledPluginIds: [],
      updatedAt: '2026-11-05T12:00:00Z',
      messageCount: 2
    }
  ];

  const messagesBySession: Record<string, WorkspaceMessage[]> = {
    session_past_1: [
      {
        id: 'msg_1',
        sessionId: 'session_past_1',
        role: 'user',
        content: 'How should we configure the SQLite database schema and persistence?'
      },
      {
        id: 'msg_2',
        sessionId: 'session_past_1',
        role: 'assistant',
        content: 'We decided on localDatabase.ts storing atomic JSON in .local-data/llmcp-db.json with PBKDF2 encryption.'
      }
    ]
  };

  const probeRes: DatabaseMemoryProbeResult = probeDatabaseMemory({
    query: 'What encryption and database scheme did we decide in earlier chats?',
    memories,
    sessions,
    messagesBySession,
    scope: 'all',
    topK: 4
  });

  assert.ok(probeRes.hits.length >= 2, 'Probed hits retrieved from both memories and past chats');
  assert.ok(probeRes.totalRecordsScanned >= 2, 'Scanned database context stores');
  assert.ok(probeRes.contextSnippet.length > 0, 'Context snippet generated');
  assert.ok(
    probeRes.contextSnippet.includes('PBKDF2') || probeRes.contextSnippet.includes('SQLite'),
    'Relevant previous info extracted from database'
  );

  // Check specific turn citation
  const chatHit = probeRes.hits.find((h) => h.type === 'conversation_turn');
  assert.ok(chatHit, 'Past chat hit identified');
  assert.equal(chatHit.sourceSessionTitle, 'Database Architecture Review');
});

test('Memory Arm Orchestrator: Complete Lifecycle & Hygiene Management', () => {
  const memoryOrch = new MemoryOrchestrator();

  let memList = memoryOrch.addMemory([], {
    key: 'Test Rule',
    fact: 'Always test edge cases thoroughly',
    category: 'system_directive',
    isActive: true,
    importance: 4
  });
  assert.equal(memList.length, 1);
  assert.equal(memList[0].importance, 4);

  // Pin toggle
  memList = memoryOrch.togglePin(memList, memList[0].id);
  assert.equal(memList[0].pinned, true);

  // Importance update
  memList = memoryOrch.setImportance(memList, memList[0].id, 5);
  assert.equal(memList[0].importance, 5);

  // Tags update
  memList = memoryOrch.setTags(memList, memList[0].id, ['testing', 'quality']);
  assert.deepEqual(memList[0].tags, ['testing', 'quality']);

  // Access recording
  memList = memoryOrch.recordMemoryAccess(memList, [memList[0].id]);
  assert.equal(memList[0].accessCount, 1);
  assert.ok(memList[0].lastAccessedAt, 'Records access timestamp');

  // Analytics computation
  const stats = memoryOrch.getStats(memList);
  assert.equal(stats.total, 1);
  assert.equal(stats.active, 1);
  assert.equal(stats.pinned, 1);
  assert.equal(stats.avgImportance, 5);

  // Export JSON
  const exportedJson = memoryOrch.exportJson(memList);
  assert.ok(exportedJson.includes('Test Rule'));

  // Import JSON with duplicate detection
  const importRes = memoryOrch.importJson(exportedJson, memList, 'merge_skip_duplicates');
  assert.equal(importRes.success, true);
  assert.equal(importRes.skipped, 1, 'Duplicate was skipped safely');

  // Bulk toggle and delete
  memList = memoryOrch.bulkToggle(memList, [memList[0].id], false);
  assert.equal(memList[0].isActive, false);

  memList = memoryOrch.bulkDelete(memList, [memList[0].id]);
  assert.equal(memList.length, 0);
});

test('Tool Probing: AI Brain Probes Database Memory via agent_file_ops Tool Call', () => {
  const toolResult = invokeToolCallByName(
    'agent_file_ops',
    {
      action: 'probe_memory',
      query: 'What database do we use?'
    },
    {
      vectorIndex: [],
      vaultFiles: [],
      providerId: 'llamacpp',
      memories: [
        {
          id: 'mem_db',
          key: 'Database Architecture',
          fact: 'The application uses an embedded SQLite database with local atomic file backups',
          category: 'architecture',
          isActive: true
        }
      ],
      messagesBySession: {
        session_1: [
          {
            id: 'm_1',
            role: 'assistant',
            content: 'We set up SQLite for high-performance zero-config storage.'
          }
        ]
      }
    } as any
  );

  assert.equal(toolResult.pluginId, 'agent_file_ops');
  assert.ok(
    toolResult.outputSummary.includes('SQLite') || toolResult.outputSummary.includes('Database Architecture'),
    'Tool returns probed context from application database'
  );
});

test('Robust CUID Tag Engine: Generation, Validation, and Scoped Entity Tagging', () => {
  const cuid1 = createCuid();
  const cuid2 = createCuid();

  assert.notEqual(cuid1, cuid2, 'CUIDs are unique and collision resistant');
  assert.equal(isCuid(cuid1), true, 'cuid1 is a valid CUID');
  assert.equal(isCuid(cuid2), true, 'cuid2 is a valid CUID');
  assert.equal(cuid1.startsWith('c'), true, 'CUID starts with c prefix');

  const tagged = createCuidTag('chat', 'baseball');
  assert.ok(tagged.startsWith('cuid:chat:baseball:c'), 'Produces scoped entity CUID tag');
});

test('Master Vector Map Cross-Session Retrieval: Mark (Baseball) vs Steve (Cars) vs Joe (Baseball)', () => {
  const map = new MasterVectorMap();

  // Day 1: User talks to Mark about baseball scores in Chat 1
  map.indexUnit({
    entityId: 'msg_mark_1',
    sessionId: 'session_mark',
    sessionTitle: 'Chat with Mark',
    type: 'conversation_turn',
    role: 'user',
    content: 'Did you catch the baseball score last night? The Yankees won 6 to 3.',
    cuidTags: ['tag:mark', 'tag:baseball', 'tag:sports']
  });

  // Day 2: User talks to Steve about cars in Chat 2 (New Chat)
  // The probe queries the master vector map for car context
  const steveProbe = map.probe({
    queryText: 'Hey Steve, what do you think about electric sports cars and battery range?',
    minCosineScore: 0.35
  });

  // Since baseball is completely unrelated to electric cars, the baseball context is NOT returned!
  assert.equal(
    steveProbe.hits.length,
    0,
    'Baseball context is completely ignored when talking about cars'
  );
  assert.equal(
    steveProbe.contextSnippet,
    '',
    'Context snippet is empty, saving precious VRAM headroom'
  );

  // Day 3: User talks to Joe about baseball scores in Chat 3 (New Chat)
  const joeProbe = map.probe({
    queryText: 'Joe, what was that baseball score from earlier this week with the Yankees?',
    minCosineScore: 0.30
  });

  // The probe finds the earlier separate chat with Mark on the fly!
  assert.ok(joeProbe.hits.length > 0, 'Finds Mark baseball chat on the fly for Joe');
  const matchedMarkChat = joeProbe.hits.find((h) => h.unit.sessionId === 'session_mark');
  assert.ok(matchedMarkChat, 'Mark baseball chat retrieved for Joe chat');
  assert.ok(
    matchedMarkChat.unit.content.includes('baseball score') && matchedMarkChat.unit.content.includes('Yankees'),
    'Content contains the exact baseball scores from the earlier separate chat'
  );
  assert.ok(joeProbe.contextSnippet.includes('Yankees won 6 to 3'));
});

test('Dedicated Octo Vector Database: Persistence, CUID Tag Indexing, and Disk Reload', async (t) => {
  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'octo-persistence-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tmpDbPath = path.join(dir, 'vectors.json');

  const vdb = new OctoVectorDatabase({ filePath: tmpDbPath });
  assert.equal(vdb.getAllRecords().length, 0);

  // 1. Embed and write a baseball chat turn
  const markRec = await vdb.embedAndWrite({
    sourceKey: 'turn_mark_01',
    recordType: 'conversation_turn',
    title: 'Mark Sports Chat',
    sessionId: 'session_mark',
    sessionTitle: 'Mark Sports Chat',
    role: 'user',
    text: 'Did you catch the baseball score last night? The Yankees won 6 to 3 against the Red Sox.'
  });

  assert.ok(markRec);
  assert.ok(isCuid(markRec.cuid), 'CUID is generated');
  assert.equal(markRec.recordType, 'conversation_turn');
  assert.equal(vdb.getAllRecords().length, 1);
  vdb.persistToDisk();

  // 2. Probe for cars -> Should return 0 hits (cars != baseball)
  const carsProbe = await vdb.probe({
    query: 'What is the top speed of modern electric sports cars?',
    minCosineScore: 0.35
  });
  assert.equal(carsProbe.hits.length, 0, 'Zero hits for cars');
  assert.equal(carsProbe.formattedContext, '', 'Zero context tokens loaded');

  // 3. Probe for baseball -> Returns Mark baseball turn
  const baseballProbe = await vdb.probe({
    query: 'Who won the Yankees baseball score last night?',
    minCosineScore: 0.28
  });
  assert.ok(baseballProbe.hits.length > 0, 'Retrieved baseball record');
  assert.equal(baseballProbe.hits[0].cuid, markRec.cuid);
  assert.ok(baseballProbe.formattedContext.includes('Yankees won 6 to 3'));

  // 4. Persistence verification: Fresh OctoVectorDatabase loads from disk
  const reloadedVdb = new OctoVectorDatabase({ filePath: tmpDbPath });
  assert.equal(reloadedVdb.getAllRecords().length, 1, 'Reloaded vector count matches');
  const loadedRec = reloadedVdb.getAllRecords().find((record) => record.cuid === markRec.cuid);
  assert.ok(loadedRec, 'Reloaded record exists by CUID');
  assert.equal(loadedRec.cuid, markRec.cuid);
  assert.equal(loadedRec.text, markRec.text);
});

test('Dedicated Octo Vector Database: corrupt storage is reported without overwriting it', () => {
  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'octo-corrupt-test-'));
  const dbPath = path.join(dir, 'vectors.json');
  try {
    fs.writeFileSync(dbPath, '{invalid');
    const db = new OctoVectorDatabase({ filePath: dbPath });
    const isLoadError = (error: unknown) =>
      error instanceof Error && error.message.includes('Failed to load vector database');
    assert.throws(() => db.getAllRecords(), isLoadError);
    assert.throws(() => db.getAllRecords(), isLoadError);
    assert.equal(fs.readFileSync(dbPath, 'utf8'), '{invalid');
  } finally {
    fs.unlinkSync(dbPath);
    fs.rmdirSync(dir);
  }
});


