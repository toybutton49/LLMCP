import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVectorIndex,
  searchVectorIndex,
  searchVaultFiles,
  composeSystemInstruction,
  sanitizeLoopbackEndpoint,
  sanitizeJsonObject,
  createVaultFileEntry,
  deduplicateModelIds,
  isNomicEmbeddingModel,
  resolveCanonicalModelId,
  getModelComparisonStem,
  fetchOctoHeartEmbedding,
  OCTO_HEART_FALLBACK_DIMENSIONS
} from '../../src/utils/rag';
import {
  hashPassphrase,
  verifyPassphrase,
  encryptVaultSnapshot,
  decryptVaultSnapshot,
  normalizeProviderId,
  normalizeSimilarityMetric
} from '../../server-db';
import { analyzeMessageFactGrounding } from '../../src/utils/sourceVerification';

test('llama.cpp GGUF Model Deduplication and Auxiliary Artifact Filtering', () => {
  const rawModels = [
    'qwen/qwen3.5-2b',
    'google/gemma-4-e2b',
    'text-embedding-nomic-embed-text-v1.5',
    'gemma-4-E2B-it-Q4_K_M',
    'mmproj-gemma-4-E2B-it-BF16',
    'mmproj-Qwen3.5-2B-BF16',
    'Qwen3.5-2B-Q8_0'
  ];

  const deduped = deduplicateModelIds(rawModels);
  assert.deepEqual(deduped, [
    'qwen/qwen3.5-2b',
    'google/gemma-4-e2b'
  ]);

  const reversed = [...rawModels].reverse();
  const dedupedReversed = deduplicateModelIds(reversed);
  assert.deepEqual(dedupedReversed, [
    'qwen/qwen3.5-2b',
    'google/gemma-4-e2b'
  ]);

  assert.equal(
    resolveCanonicalModelId('Qwen3.5-2B-Q8_0', deduped),
    'qwen/qwen3.5-2b'
  );
  assert.equal(
    resolveCanonicalModelId('gemma-4-E2B-it-Q4_K_M', deduped),
    'google/gemma-4-e2b'
  );
  assert.equal(isNomicEmbeddingModel('nomic-embed-text-v1.5.Q8_0.gguf'), true);
  assert.equal(isNomicEmbeddingModel('bge-m3.gguf'), false);
  assert.equal(getModelComparisonStem('qwen3.5:4b'), 'qwen3.5-4b');
  assert.equal(
    getModelComparisonStem('E:\\llmcp\\models\\Qwen3.5-4B-GGUF\\Qwen3.5-4B-Q4_K_M.gguf'),
    'qwen3.5-4b'
  );
  assert.equal(
    resolveCanonicalModelId('qwen3.5:4b', ['Qwen3.5-4B-Q4_K_M', 'gemma-4-E2B-it-Q4_K_M']),
    'Qwen3.5-4B-Q4_K_M'
  );
  assert.equal(
    resolveCanonicalModelId('Qwen3.5-4B-Q4_K_M', [
      'E:\\llmcp\\models\\Qwen3.5-4B-GGUF\\Qwen3.5-4B-Q4_K_M.gguf'
    ]),
    'E:\\llmcp\\models\\Qwen3.5-4B-GGUF\\Qwen3.5-4B-Q4_K_M'
  );
});

test('File Repo Vector Indexing and Cosine Similarity Retrieval', async (t) => {
  const docs = [
    {
      id: 'doc_1',
      title: 'Built-in llama.cpp Inference',
      category: 'Architecture',
      content: 'llama.cpp runs on http://127.0.0.1:8080/v1 with standard OpenAI completions streaming protocol.'
    },
    {
      id: 'doc_2',
      title: 'Hot Swappable Tools',
      category: 'Plugins',
      content: 'All tools reside in src/tools directory and can be hot-swapped live at runtime via registry.'
    }
  ];

  const index = buildVectorIndex(docs, 200, 40);
  assert.ok(index.length >= 2, 'Vector index chunks generated');
  assert.equal(index[0].vector.length, OCTO_HEART_FALLBACK_DIMENSIONS);

  const hits = searchVectorIndex('OpenAI streaming in llama.cpp', index, 3, 0.01, 'cosine');
  assert.ok(hits.length > 0, 'Retrieval finds relevant document');
  assert.equal(hits[0].docTitle, 'Built-in llama.cpp Inference');

  await assert.rejects(
    fetchOctoHeartEmbedding('Octo Heart embedding circulation test', 'http://127.0.0.1:59999'),
    /Nomic embedding model is required/
  );
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: 'model unavailable' }, { status: 503 })
  );
  await assert.rejects(
    fetchOctoHeartEmbedding(
      'Octo Heart embedding circulation test',
      'http://127.0.0.1:59999',
      'nomic-embed-text-v1.5'
    ),
    /Nomic embedding request failed \(HTTP 503\)/
  );

  const customDimIndex = buildVectorIndex(docs, 200, 40, 256, true);
  assert.equal(customDimIndex[0].vector.length, 256);
  const weightedHits = searchVectorIndex(
    'OpenAI streaming in llama.cpp',
    customDimIndex,
    3,
    0.01,
    'cosine',
    0.7
  );
  assert.ok(weightedHits.length > 0);
});

test('File Repo Search and Pinned Filters', () => {
  const files = [
    createVaultFileEntry({
      fileName: 'config.json',
      collection: 'Config',
      content: '{"port": 3000, "engine": "llamacpp", "thinking": true}',
      pinnedInChat: true
    }),
    createVaultFileEntry({
      fileName: 'notes.txt',
      collection: 'Notes',
      content: 'Meeting notes on local privacy architecture.',
      pinnedInChat: false
    })
  ];

  const pinnedHits = searchVaultFiles('thinking port', files, 4, 'pinned');
  assert.equal(pinnedHits.length, 1);
  assert.equal(pinnedHits[0].fileName, 'config.json');

  const allHits = searchVaultFiles('privacy architecture', files, 4, 'all');
  assert.ok(allHits.length > 0);
  assert.equal(allHits[0].fileName, 'notes.txt');
});

test('System Instruction Composition with Thinking and Directives', () => {
  const instruction = composeSystemInstruction({
    baseSystemPrompt: 'You are an expert AI engineer.',
    memories: [{ id: 'm1', key: 'Style', fact: 'Concise output', category: 'preference', isActive: true }],
    memoryEnabled: true,
    ragHits: [],
    ragEnabled: false,
    vaultHits: [],
    vaultEnabled: false,
    toolResults: [],
    thinkingEnabled: true,
    reasoningEffort: 'high'
  });

  assert.ok(instruction.includes('Thinking Mode: ENABLED'), 'Includes Thinking directive');
  assert.ok(instruction.includes('Reasoning Effort: HIGH'), 'Includes reasoning effort level');
  assert.ok(instruction.includes('Concise output'), 'Includes memory fact');
});

test('Security: Loopback Endpoint and JSON Sanitization', () => {
  const loopback1 = sanitizeLoopbackEndpoint('http://localhost:8080', 'http://127.0.0.1:8080');
  assert.equal(loopback1, 'http://127.0.0.1:8080');

  const blocked = sanitizeLoopbackEndpoint('http://malicious-site.com', 'http://127.0.0.1:8080');
  assert.equal(blocked, 'http://127.0.0.1:8080');

  const cleanedJson = sanitizeJsonObject({
    normal: 'value',
    __proto__: { polluted: true }
  });
  assert.equal(cleanedJson.normal, 'value');
  assert.equal((cleanedJson as Record<string, unknown>).__proto__, undefined);
});

test('PBKDF2 Hashing and AES-256-GCM Snapshot Encryption', () => {
  const passphrase = 'UltraSecureTestKey123';
  const hashed = hashPassphrase(passphrase);
  assert.ok(verifyPassphrase(passphrase, hashed));
  assert.ok(!verifyPassphrase('WrongPassword', hashed));

  const secretPayload = JSON.stringify({ database: 'llmcp', local: true, timestamp: Date.now() });
  const envelope = encryptVaultSnapshot(secretPayload, passphrase);
  assert.ok(envelope.encryptedVault && envelope.iv && envelope.authTag && envelope.salt);

  const decrypted = decryptVaultSnapshot(envelope, passphrase);
  assert.equal(decrypted, secretPayload);

  assert.throws(() => {
    decryptVaultSnapshot(envelope, 'IncorrectKey');
  });
});

test('Provider Normalization to Built-in llama.cpp', () => {
  assert.equal(normalizeProviderId('llamacpp'), 'llamacpp');
  assert.equal(normalizeProviderId('any_legacy'), 'llamacpp');
  assert.equal(normalizeProviderId(undefined), 'llamacpp');
  assert.equal(normalizeSimilarityMetric('cosine'), 'cosine');
});

test('Fact Grounding and Source Verification Engine: Categorizes Proof Levels', () => {
  const parametricMsg = {
    id: 'msg_1',
    role: 'assistant' as const,
    content: 'The sky is blue due to Rayleigh scattering.'
  };
  const parametricAnalysis = analyzeMessageFactGrounding(parametricMsg);
  assert.equal(parametricAnalysis.level, 'parametric_model');
  assert.equal(parametricAnalysis.hasSources, false);
  assert.equal(parametricAnalysis.badgeVariant, 'zinc');

  const webMsg = {
    id: 'msg_2',
    role: 'assistant' as const,
    content: 'According to latest documentation, React 19 is released.',
    toolInvocations: [
      {
        pluginId: 'web_search',
        pluginName: 'Web Search, Fetch & Context',
        inputSummary: 'query="React 19 release"',
        outputSummary: '[1] React 19 Release Notes\nURL: https://react.dev/blog/2024/12/05/react-19\nSummary: React 19 is now available.',
        durationMs: 120
      }
    ]
  };
  const webAnalysis = analyzeMessageFactGrounding(webMsg);
  assert.equal(webAnalysis.level, 'web_context');
  assert.equal(webAnalysis.hasSources, true);
  assert.equal(webAnalysis.badgeVariant, 'emerald');
  assert.ok(webAnalysis.sources.length > 0);
  assert.equal(webAnalysis.sources[0].domain, 'react.dev');

  const vaultMsg = {
    id: 'msg_3',
    role: 'assistant' as const,
    content: 'The architecture uses SQLite local nervous system.',
    vaultCitations: [
      {
        fileName: 'architecture.md',
        collection: 'Architecture',
        lineRange: 'L10-L25',
        score: 0.92,
        excerpt: 'LLMCP Nervous System architecture documentation.',
        sha256Preview: 'a1b2c3d4e5f6'
      }
    ]
  };
  const vaultAnalysis = analyzeMessageFactGrounding(vaultMsg);
  assert.equal(vaultAnalysis.level, 'local_repo_context');
  assert.equal(vaultAnalysis.hasSources, true);
  assert.ok(vaultAnalysis.levelDescription.includes('may not support every claim'));
  assert.ok(!vaultAnalysis.levelLabel.toLowerCase().includes('verified'));
  assert.equal(vaultAnalysis.badgeVariant, 'sky');
  assert.equal(vaultAnalysis.sources[0].title, 'architecture.md');

  const sysMsg = {
    id: 'msg_4',
    role: 'assistant' as const,
    content: 'Current server time is verified.',
    toolInvocations: [
      {
        pluginId: 'system_context',
        pluginName: 'System Context & Host Metadata',
        inputSummary: 'Format: json',
        outputSummary: '{"sys_date":"2026-11-09","os":"windows"}',
        durationMs: 4
      }
    ]
  };
  const sysAnalysis = analyzeMessageFactGrounding(sysMsg);
  assert.equal(sysAnalysis.level, 'system_context');
  assert.equal(sysAnalysis.hasSources, true);
  assert.equal(sysAnalysis.badgeVariant, 'purple');

  const inlineMsg = {
    id: 'msg_5',
    role: 'assistant' as const,
    content: 'Refer to documentation at https://react.dev/learn for details.'
  };
  const inlineAnalysis = analyzeMessageFactGrounding(inlineMsg);
  assert.equal(inlineAnalysis.level, 'model_links');
  assert.equal(inlineAnalysis.hasSources, true);
  assert.equal(inlineAnalysis.badgeVariant, 'zinc');
  assert.ok(inlineAnalysis.levelDescription.includes('not been independently checked'));
  assert.equal(inlineAnalysis.sources[0].domain, 'react.dev');

  const calculatorMsg = {
    id: 'msg_6',
    role: 'assistant' as const,
    content: 'Calculator confirmed results.',
    toolInvocations: [
      {
        pluginId: 'precision_calculator',
        pluginName: 'Calculator',
        inputSummary: 'Expression: 40 + 2',
        outputSummary: 'Result: 42',
        durationMs: 15
      }
    ]
  };
  const calculatorAnalysis = analyzeMessageFactGrounding(calculatorMsg);
  assert.equal(calculatorAnalysis.level, 'system_context');
  assert.equal(calculatorAnalysis.hasSources, true);
  assert.equal(calculatorAnalysis.badgeVariant, 'purple');
});

test('System Instruction Composition: Enforces Analytical Depth and Eliminates Concise Restriction', () => {
  const instruction = composeSystemInstruction({
    baseSystemPrompt: 'You are an AI assistant.',
    memories: [],
    memoryEnabled: false,
    ragHits: [],
    ragEnabled: false,
    vaultHits: [],
    vaultEnabled: false,
    toolResults: [],
    thinkingEnabled: true,
    reasoningEffort: 'medium'
  });

  assert.ok(instruction.includes('Analytical Rigor, Depth & Citation Mandates'));
  assert.ok(instruction.includes('Comprehensive Synthesis'));
  assert.ok(instruction.includes('Explicit Source Citations'));
  assert.ok(!instruction.includes('final concise response'));
  assert.ok(instruction.includes('final comprehensive, well-structured, and authoritative response'));
});
