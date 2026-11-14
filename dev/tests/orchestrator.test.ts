import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  orchestrator,
  LLMCPOrchestrator
} from '../../src/orchestrators';
import { createVaultFileEntry } from '../../src/utils/rag';

test('Octopus Topology: Central Brain, embedding retrieval, 10 orchestrators, and API endpoints', () => {
  const topology = orchestrator.getOctopusTopology();
  assert.equal(topology.centralBrain.status, 'healthy');
  assert.equal(topology.centralBrain.architecture, 'Octopus Single-Source-of-Truth');
  assert.ok(topology.mainHeart, 'Embedding retrieval is registered');
  assert.equal(topology.mainHeart.status, 'healthy');
  assert.equal(topology.mainHeart.model, null, 'Topology does not invent an embedding model');
  assert.ok(topology.mainHeart.suctionCups.includes('POST /api/rag/query'), 'Embedding retrieval exposes the RAG query endpoint');
  assert.equal(topology.arms.length, 10, 'All 10 specialized Tentacle Brain Orchestrators registered');

  for (const arm of topology.arms) {
    assert.ok(Array.isArray(arm.suctionCups) && arm.suctionCups.length > 0, `${arm.name} exposes endpoint suction cups`);
  }

  const armDomains = topology.arms.map((a) => a.domain);
  assert.ok(armDomains.includes('chat_and_sessions'));
  assert.ok(armDomains.includes('knowledge_and_file_repo'));
  assert.ok(armDomains.includes('memory_and_personas'));
  assert.ok(armDomains.includes('tools'));
  assert.ok(armDomains.includes('usage_analytics'));
  assert.ok(armDomains.includes('storage_and_persistence'));
});

test('Fresh Install Snapshot: Zero Saved Chats, Files, or Memories', () => {
  const fresh = orchestrator.storageOrchestrator.createFreshInstallSnapshot();
  assert.equal(fresh.sessions.length, 1);
  assert.equal(fresh.sessions[0].title, 'New Chat');
  assert.equal(fresh.sessions[0].messageCount, 0);
  assert.deepEqual(fresh.messagesBySession[fresh.sessions[0].id], []);
  assert.equal(fresh.vaultFiles.length, 0);
  assert.equal(fresh.ragDocuments.length, 0);
  assert.equal(fresh.memories.length, 0);
  assert.equal(fresh.customPlugins.length, 0);
});

test('Chat, Memory, Knowledge, and Analytics Arm Orchestrators Single-Source Mutations', () => {
  // Chat Arm: Thinking trace extraction
  const extracted = orchestrator.chatOrchestrator.extractThinkingAndContent(
    '<think>Step 1: verify</think>Final verified response.'
  );
  assert.equal(extracted.reasoningContent, 'Step 1: verify');
  assert.equal(extracted.cleanContent, 'Final verified response.');

  // Memory Arm: Add, toggle, delete
  let memories = orchestrator.memoryOrchestrator.addMemory([], {
    key: 'Architecture Rule',
    fact: 'Use Octopus Orchestrator',
    category: 'system_directive',
    isActive: true
  });
  assert.equal(memories.length, 1);
  memories = orchestrator.memoryOrchestrator.toggleMemory(memories, memories[0].id);
  assert.equal(memories[0].isActive, false);

  // Knowledge Arm: Add and delete File Repo document
  let docs = orchestrator.knowledgeOrchestrator.addDocument([], {
    title: 'Spec',
    category: 'Architecture',
    content: 'Modular arm orchestrators.'
  });
  assert.equal(docs.length, 1);
  docs = orchestrator.knowledgeOrchestrator.deleteDocument(docs, docs[0].id);
  assert.equal(docs.length, 0);

  // Analytics Arm: Compute clean workspace metrics
  const fresh = orchestrator.storageOrchestrator.createFreshInstallSnapshot();
  const report = orchestrator.analyticsOrchestrator.computeWorkspaceAnalytics({
    sessions: fresh.sessions,
    messagesBySession: fresh.messagesBySession,
    ragDocuments: fresh.ragDocuments,
    vaultFiles: fresh.vaultFiles,
    memories: fresh.memories
  });
  assert.equal(report.totalMessages, 0);
  assert.equal(report.totalTokens, 0);
  assert.equal(report.knowledgeCorpusTokens, 0);
});

test('Orchestrator Pipeline: Full Turn Execution Trace (AI Brain Decides Tool Calls)', async () => {
  const customOrch = new LLMCPOrchestrator();

  const vaultFiles = [
    createVaultFileEntry({
      fileName: 'architecture.md',
      collection: 'Docs',
      content: 'LLMCP modular architecture with orchestrator pipelines and built-in llama.cpp inference.',
      pinnedInChat: true
    })
  ];

  const trace = await customOrch.executePipeline({
    prompt: 'Summarize the architecture of LLMCP and check system time',
    session: {
      id: 'test_sess',
      title: 'Test Session',
      ownerId: 'local_operator',
      providerId: 'llamacpp',
      modelId: 'test-model',
      systemPrompt: 'You are an AI assistant.',
      temperature: 0.3,
      ragEnabled: true,
      vaultEnabled: true,
      vaultScopeMode: 'all',
      memoryEnabled: true,
      enabledPluginIds: ['system_context', 'precision_calculator'],
      messageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    history: [],
    ragDocuments: [],
    vaultFiles,
    memories: [],
    customPlugins: []
  });

  assert.ok(trace.traceId, 'Trace ID generated');
  assert.ok(trace.stages.length >= 4, 'Stages executed in pipeline');
  assert.equal(trace.stages[0].stageName, 'prompt_intake');
  const toolStage = trace.stages.find((s) => s.stageName === 'tool_dispatch');
  assert.ok(toolStage, 'tool_dispatch stage recorded');
  assert.ok(trace.durationMs >= 0, 'Duration recorded');
});

test('Logging Orchestrator Ring Buffer and Subsystem Filtering', () => {
  orchestrator.loggingOrchestrator.clear();
  orchestrator.loggingOrchestrator.info('inference', 'test.event', 'llama.cpp connected');
  orchestrator.loggingOrchestrator.warn('tool', 'test.warn', 'Tool timeout handled');
  orchestrator.loggingOrchestrator.error('system', 'test.error', 'Mock error handled');

  const allLogs = orchestrator.loggingOrchestrator.getEntries();
  assert.equal(allLogs.length, 3);

  const inferenceLogs = orchestrator.loggingOrchestrator.getEntries({ subsystem: 'inference' });
  assert.equal(inferenceLogs.length, 1);
  assert.equal(inferenceLogs[0].message, 'llama.cpp connected');

  const warnLogs = orchestrator.loggingOrchestrator.getEntries({ level: 'WARN' });
  assert.equal(warnLogs.length, 1);
  assert.equal(warnLogs[0].event, 'test.warn');
});

test('Orchestrator Self-Test Diagnostics', () => {
  const diag = orchestrator.runDiagnostics({
    ragDocuments: [],
    vaultFiles: [],
    customPlugins: [],
    activeProviderId: 'llamacpp',
    activeModelId: 'local-test'
  });

  assert.ok(diag.timestamp, 'Timestamp generated');
  assert.ok(diag.latencyBaselineMs >= 0, 'Baseline latency computed');
  assert.equal(diag.modules.inference.provider, 'llamacpp');
  assert.equal(diag.status, 'healthy');
  assert.equal(diag.modules.inference.status, 'pending');
  assert.ok((diag.modules.inference.details || '').includes('Not run by design'));
  assert.ok((diag.modules.context.details || '').includes('Synthetic fixture'));
  assert.equal(Object.keys(diag.modules).length, 10, 'All 10 arms verified in diagnostics');
});

test('Live Turn Trace: Captures Chat Turns and Tool Runs via TraceManager Subscriptions', () => {
  let receivedTrace: any = null;
  const unsubscribe = orchestrator.subscribeTraces((t) => {
    receivedTrace = t;
  });

  const toolTrace = orchestrator.recordToolExecutionTrace({
    toolName: 'System Context & Host Metadata',
    toolId: 'system_context',
    inputSummary: 'Format: json',
    outputSummary: '{"os":"windows","engine":"llamacpp"}',
    durationMs: 4,
    sessionId: 'test_tool_session',
    status: 'success'
  });

  assert.ok(receivedTrace, 'Listener received trace update on tool execution');
  assert.equal(receivedTrace.id, toolTrace.id);
  assert.equal(orchestrator.getLatestTrace()?.id, toolTrace.id);
  assert.ok(orchestrator.getTraceHistory().length > 0);
  assert.equal(toolTrace.stages.length, 2);
  assert.equal(toolTrace.stages[0].stage, 'prompt_intake');
  assert.equal(toolTrace.stages[1].stage, 'tool_dispatch');
  assert.equal(toolTrace.toolsExecuted, 1);

  unsubscribe();
});

test('Root Directory Clean of Loose Architecture JPEGs and Removed from Settings Display', () => {
  const rootDir = process.cwd();
  const rootArchJpg = path.join(rootDir, 'llmcp-architecture.jpg');
  const rootArchAlias = path.join(rootDir, 'architecture.jpg');

  assert.equal(fs.existsSync(rootArchJpg), false, 'llmcp-architecture.jpg must not exist in root');
  assert.equal(fs.existsSync(rootArchAlias), false, 'architecture.jpg must not exist in root');

  const settingsSectionPath = path.join(
    rootDir,
    'src',
    'components',
    'orchestrator',
    'OrchestratorSettingsSection.tsx'
  );
  const settingsContent = fs.readFileSync(settingsSectionPath, 'utf-8');
  assert.equal(
    settingsContent.includes('activeSubTab === \'topology\''),
    false,
    'OrchestratorSettingsSection must not display topology subtab'
  );
  assert.equal(
    settingsContent.includes('Octopus Orchestrator Architecture'),
    false,
    'OrchestratorSettingsSection must not display legacy topology banner'
  );
});
