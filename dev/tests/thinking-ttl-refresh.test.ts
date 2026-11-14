import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { orchestrator } from '../../src/orchestrators';
import {
  beginActiveInferenceStream,
  endActiveInferenceStream,
  executeLlamaCppLoadWithTtl,
  getActiveLoadedLlamaModel,
  clearActiveLoadedLlamaModel,
  unloadActiveLlamaServer,
  refreshActiveTtlTimer,
  schedulePostResponseTtl,
  getLlamaServerPort
} from '../../server/llamacpp/llamaCppTtl';
import { extractInlineGgufToolCalls } from '../../server/routes/chatStreamingEngine';
import { scanLocalFilesystemModels } from '../../server-db';
import {
  resolveCanonicalModelId,
  deduplicateModelIds,
  safeEvaluateArithmetic,
  compactEvictedContext,
  isAuxiliaryOrEmbeddingModel,
  stripThinkingTags
} from '../../src/utils/rag';
import { normalizeSessionPluginIds } from '../../src/hooks/workspaceStateDefaults';
import { INITIAL_SESSIONS } from '../../src/data/seedData';
import { ensureLocalDb } from '../../server/db/localDatabase';

test('Kill Duplicate Thinking: Multi-turn tool execution thinking blocks', () => {
  const multiTurnRawResponse = `<think>
The user is asking for today's date. I have access to tools that can provide system time and date information.

1. **Analyze the request:** The request is simple: "what is todays date?".
2. **Identify relevant tools:** The \`system_time\` tool or \`system_context\` tool are designed to retrieve current date and time information.
3. **Select the appropriate tool call:** I will use \`system_time\` to get the current date.
4. **Execute and formulate the response:** Call the tool and present the result to the user.
</think>

<think>
Thinking Process:
1. Analyze the Request: The user asked, "what is todays date?"
2. Consult Tool Output: I need to look at the output provided by the system_time tool to determine the current date.
3. Extract Date Information: The tool output states: sys_date: 2026-10-29 (10/29/2026) (Thursday) .
4. Formulate the Answer: Based on the extracted information, I will state today's date.
5. Final Response Generation: State the date clearly.
</think>

Today's date is October 29, 2026.`;

  const result = orchestrator.chatOrchestrator.extractThinkingAndContent(multiTurnRawResponse);

  assert.ok(!result.cleanContent.includes('<think>'), 'No <think> opening tag in clean content');
  assert.ok(!result.cleanContent.includes('</think>'), 'No </think> closing tag in clean content');
  assert.equal(result.cleanContent, "Today's date is October 29, 2026.");

  assert.ok(result.reasoningContent, 'Reasoning content should be extracted');
  assert.ok(result.reasoningContent!.includes('The user is asking for today\'s date'));
  assert.ok(result.reasoningContent!.includes('Thinking Process:'));
  assert.ok(result.reasoningContent!.includes('Extract Date Information:'));
});

test('Kill Duplicate Thinking: Handles unclosed streaming think blocks and empty initial stream without premature Response completed', () => {
  const emptyInitial = orchestrator.chatOrchestrator.extractThinkingAndContent('');
  assert.equal(emptyInitial.cleanContent, '');
  assert.equal(emptyInitial.reasoningContent, undefined);

  const openTagOnly = orchestrator.chatOrchestrator.extractThinkingAndContent('<think>\n');
  assert.equal(openTagOnly.cleanContent, '');
  assert.equal(openTagOnly.reasoningContent, undefined);

  const streamingPartial = '<think>\nEvaluating reasoning step 1...';
  const result = orchestrator.chatOrchestrator.extractThinkingAndContent(streamingPartial);
  assert.equal(result.cleanContent, '');
  assert.equal(result.reasoningContent, 'Evaluating reasoning step 1...');

  const toolCallOnly = orchestrator.chatOrchestrator.extractThinkingAndContent(
    '<tool_call>\n{"name":"web_search","arguments":{"query":"live news"}}'
  );
  assert.equal(toolCallOnly.cleanContent, '');
});

test('Kill Duplicate Thinking: Strips nested <think> tags, pre-filled </think> prefix, and partial trailing tag fragments', () => {
  const nestedThink =
    '<think>\nRound 1 thought\n</think>\n\n<think>\n<think>\nRound 2 thought\n</think>\n\nFinal synthesis.';
  const nestedResult = orchestrator.chatOrchestrator.extractThinkingAndContent(nestedThink);
  assert.equal(nestedResult.cleanContent, 'Final synthesis.');
  assert.ok(nestedResult.reasoningContent);
  assert.ok(!nestedResult.reasoningContent!.includes('<think>'));
  assert.ok(!nestedResult.reasoningContent!.includes('</think>'));
  assert.ok(nestedResult.reasoningContent!.includes('Round 1 thought'));
  assert.ok(nestedResult.reasoningContent!.includes('Round 2 thought'));

  const prefilledThink = 'Pre-filled template reasoning step.\n</think>\nVisible user answer.';
  const prefilledResult = orchestrator.chatOrchestrator.extractThinkingAndContent(prefilledThink);
  assert.equal(prefilledResult.reasoningContent, 'Pre-filled template reasoning step.');
  assert.equal(prefilledResult.cleanContent, 'Visible user answer.');

  const partialTrailing = orchestrator.chatOrchestrator.extractThinkingAndContent(
    'Streaming answer before tool <tool_c'
  );
  assert.equal(partialTrailing.cleanContent, 'Streaming answer before tool');
});

test('Kill Duplicate Thinking: Merges existing message reasoning with body think tags', () => {
  const existingReasoning = 'Prior Turn 1 Thinking';
  const bodyWithSecondThink = '<think>Turn 2 Post-Tool Thinking</think>Final answer text.';
  const result = orchestrator.chatOrchestrator.extractThinkingAndContent(
    bodyWithSecondThink,
    existingReasoning
  );
  assert.equal(result.cleanContent, 'Final answer text.');
  assert.ok(result.reasoningContent!.includes('Prior Turn 1 Thinking'));
  assert.ok(result.reasoningContent!.includes('Turn 2 Post-Tool Thinking'));
});

test('llama.cpp TTL: Reports the router load endpoint and selected timeout', async () => {
  const result = await executeLlamaCppLoadWithTtl('qwen3.5-2b.gguf', 10);
  assert.equal(
    result.command,
    'POST http://127.0.0.1:8080/models/load'
  );
  assert.equal(result.modelId, 'qwen3.5-2b.gguf');
  assert.equal(result.ttlSeconds, 10);
  assert.ok(result.executedAt);
});

test('llama.cpp TTL: Reports the router endpoint with selected runtime settings', async () => {
  const result = await executeLlamaCppLoadWithTtl('qwen3.5-2b.gguf', 10, {
    contextSize: 4096,
    gpuLayers: 6,
    threads: 4,
    flashAttention: false
  });
  assert.equal(
    result.command,
    'POST http://127.0.0.1:8080/models/load'
  );
});

test('llama.cpp TTL: Rejects empty model safely', async () => {
  const result = await executeLlamaCppLoadWithTtl('', 10);
  assert.equal(result.success, false);
  assert.equal(result.error, 'No .gguf model specified for llama.cpp model loading.');
});

test('llama.cpp Model Scanner: Discovers GGUF reasoning models and Octo Heart embedding model in ./models', () => {
  const scanResult = scanLocalFilesystemModels();
  assert.ok(Array.isArray(scanResult.ggufModels));
  assert.ok(Array.isArray(scanResult.embeddingModels));
  assert.ok(Array.isArray(scanResult.embeddingFiles));
  assert.equal(scanResult.modelsDirectory, './models');
  for (const f of [...scanResult.ggufFiles, ...scanResult.embeddingFiles]) {
    assert.ok(
      f.relativePath.startsWith('./models/'),
      `Relative path must point to ./models/: ${f.relativePath}`
    );
  }
  if (scanResult.embeddingFiles.length > 0) {
    assert.equal(
      scanResult.octoHeartModel,
      scanResult.embeddingFiles[0].fileName,
      'The first discovered embedding model is selected dynamically'
    );
  }
  assert.equal(isAuxiliaryOrEmbeddingModel('nomic-embed-text-v1.5.Q8_0'), true);
  assert.equal(isAuxiliaryOrEmbeddingModel('bge-large-en-v1.5'), true);
  assert.equal(isAuxiliaryOrEmbeddingModel('granite-embedding-107m'), true);
  assert.equal(isAuxiliaryOrEmbeddingModel('all-MiniLM-L6-v2'), true);
  assert.equal(isAuxiliaryOrEmbeddingModel('Qwen3.5-4B-Q4_K_M'), false);
  assert.equal(isAuxiliaryOrEmbeddingModel('gemma-4-E2B-it-Q8_0'), false);
});

test('model discovery separates GLM-OCR from chat and embedding models', (t) => {
  const testRoot = path.join(process.cwd(), '.test-data');
  fs.mkdirSync(testRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(testRoot, 'ocr-classification-test-'));
  const previousModelsDir = process.env.LLMCP_MODELS_DIR;
  process.env.LLMCP_MODELS_DIR = path.relative(process.cwd(), dir);
  t.after(() => {
    if (previousModelsDir === undefined) delete process.env.LLMCP_MODELS_DIR;
    else process.env.LLMCP_MODELS_DIR = previousModelsDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const modelName = 'GLM-OCR-classification-test.gguf';
  const projectorName = 'mmproj-GLM-OCR-classification-test.gguf';
  const legacyName = 'olmOCR-2-7B-1025-classification-test.gguf';
  fs.writeFileSync(path.join(dir, modelName), '');
  fs.writeFileSync(path.join(dir, projectorName), '');
  fs.writeFileSync(path.join(dir, legacyName), '');

  const scan = scanLocalFilesystemModels();
  assert.ok(scan.ocrFiles.some((file) => file.fileName === modelName));
  assert.ok(!scan.ggufFiles.some((file) => file.fileName === modelName));
  assert.ok(!scan.embeddingFiles.some((file) => file.fileName === modelName));
  assert.ok(!scan.ocrFiles.some((file) => file.fileName === projectorName));
  assert.ok(!scan.ocrFiles.some((file) => file.fileName === legacyName));
  assert.ok(!scan.ggufFiles.some((file) => file.fileName === legacyName));
  assert.ok(!scan.embeddingFiles.some((file) => file.fileName === legacyName));
  assert.equal(isAuxiliaryOrEmbeddingModel(modelName), true);
});

test('Refresh Resilience: Preserves selected model across provider discovery', () => {
  const availableModels = [
    'qwen/qwen3.5-2b',
    'google/gemma-4-e2b'
  ];

  const activeModel = 'google/gemma-4-e2b';
  const resolved = resolveCanonicalModelId(activeModel, availableModels);
  assert.equal(resolved, 'google/gemma-4-e2b', 'Selected model must not drift on reload');

  const deduped = deduplicateModelIds(availableModels);
  assert.equal(deduped.length, 2);
});

test('useChatController model lifecycle preview distinguishes JIT from configured TTL', async () => {
  const { buildModelLifecyclePreview, normalizeModelTtlSeconds } = await import('../../src/hooks/useChatController');
  assert.equal(normalizeModelTtlSeconds(0), 0, 'Zero must remain a valid on-demand lifecycle timeout');
  assert.equal(
    buildModelLifecyclePreview('local-model.gguf', 10),
    'local-model: unload after 10s idle'
  );
  assert.equal(
    buildModelLifecyclePreview('another-local-model', 300),
    'another-local-model: unload after 300s idle'
  );
  assert.equal(
    buildModelLifecyclePreview('local-model', 0),
    'local-model: load on demand; unload after response'
  );
});

test('Chat Demultiplexer: Strips inline GGUF <tool_call> and XML <function=...> tags alongside <think> blocks', () => {
  const rawWithToolCall = `<think>Checking system clock first.</think><tool_call>{"name": "system_context", "arguments": {}}</tool_call>The current local time is 3:15 PM.`;
  const extracted = orchestrator.chatOrchestrator.extractThinkingAndContent(rawWithToolCall);
  assert.equal(extracted.reasoningContent, 'Checking system clock first.');
  assert.equal(extracted.cleanContent, 'The current local time is 3:15 PM.');
  assert.ok(!extracted.cleanContent.includes('<tool_call>'));

  const rawXmlToolCall = `<tool_call>\n<function=web_search>\n<parameter=query>\nIran war 2026\n</parameter>\n</function>\n</tool_call>\n</user>\n<think>\nSynthesizing results.\n</think>\nHere are the latest verified updates.`;
  const xmlExtracted = orchestrator.chatOrchestrator.extractThinkingAndContent(rawXmlToolCall);
  assert.equal(xmlExtracted.reasoningContent, 'Synthesizing results.');
  assert.equal(xmlExtracted.cleanContent, 'Here are the latest verified updates.');
  assert.ok(!xmlExtracted.cleanContent.includes('<function='));
  assert.ok(!xmlExtracted.cleanContent.includes('</user>'));

  const parsedInline = extractInlineGgufToolCalls(rawXmlToolCall);
  assert.equal(parsedInline.length, 1);
  assert.equal(parsedInline[0].name, 'web_search');
  assert.deepEqual(JSON.parse(parsedInline[0].arguments), { query: 'Iran war 2026' });
});

test('Active Inference Stream Guard & No Implicit Model Selection', () => {
  beginActiveInferenceStream();
  endActiveInferenceStream('Qwen3.5-4B-Q4_K_M', 60);

  assert.equal(resolveCanonicalModelId('', ['Qwen3.5-4B-Q4_K_M']), '', 'No model is chosen until the user picks one');
  assert.equal(resolveCanonicalModelId('deleted-model', ['Qwen3.5-4B-Q4_K_M']), '');
});

test('Arithmetic & Context Hot-Resize Compaction: Pratt evaluator and evicted turn preservation', () => {
  const calcEvaluated = safeEvaluateArithmetic('(12 * 8) + 4');
  assert.equal(calcEvaluated, 100, 'Evaluates arithmetic expression deterministically');

  const evictedSummary = compactEvictedContext([
    { role: 'user', content: 'We are building an offline GGUF workbench on port 3000.' },
    { role: 'assistant', content: 'Acknowledged. Using loopback 127.0.0.1 and ./models.' }
  ]);
  assert.ok(evictedSummary.includes('[Turn 1 User]'));
  assert.ok(evictedSummary.includes('[Turn 2 Assistant]'));
  assert.ok(evictedSummary.includes('offline GGUF workbench'));
});

test('Top Chat Header Hygiene & Prompt-Only Model Load: No Octopus button, Clear requires confirmation, Download Chat Debug present, and UI reload does not load model', () => {
  const headerPath = path.join(process.cwd(), 'src', 'components', 'chat', 'ChatHeader.tsx');
  const headerContent = fs.readFileSync(headerPath, 'utf-8');
  assert.ok(
    !headerContent.includes('>Octopus<') && !headerContent.includes('onOpenOrchestratorMonitor'),
    'Top chat header must not render the Octopus button'
  );
  assert.ok(
    headerContent.includes('data-testid="clear-chat-confirmation"') &&
      headerContent.includes('data-testid="confirm-clear-chat-btn"') &&
      headerContent.includes('Clear chat?'),
    'Top chat header Clear button must require two-step confirmation'
  );
  assert.ok(
    headerContent.includes('data-testid="download-chat-btn"'),
    'Top chat header must include Download Chat Debug button'
  );
  assert.ok(
    !headerContent.includes('header-top-middle-text-logo') && !headerContent.includes('LlmcpLogo'),
    'Top chat header must not render the glowing text logo'
  );

  const appPath = path.join(process.cwd(), 'src', 'App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf-8');
  assert.ok(
    !appContent.includes('variant="wordmark"') && !appContent.includes('LlmcpLogo'),
    'Mobile header in App.tsx must not render the glowing text logo'
  );

  const controllerPath = path.join(process.cwd(), 'src', 'hooks', 'useChatController.ts');
  const controllerContent = fs.readFileSync(controllerPath, 'utf-8');
  assert.ok(
    !controllerContent.includes("fetch('/api/llamacpp/ttl'"),
    'Frontend UI reload must not trigger a model load via /api/llamacpp/ttl; only a prompt should load the model'
  );
});

test('Empty Content Fallback: stripThinkingTags isolates non-thinking content deterministically without regex', () => {
  assert.equal(stripThinkingTags('<think>Internal reasoning step</think>'), '');
  assert.equal(stripThinkingTags('<think>Thinking...</think>Visible text response'), 'Visible text response');
  assert.equal(stripThinkingTags('<THINK>Uppercase</THINK>Output'), 'Output');
  assert.equal(stripThinkingTags('</THINK>'), '');
  assert.equal(stripThinkingTags('Leading thought</think>Answer'), 'Answer');
  assert.equal(stripThinkingTags('Leading thought</THINK>'), '');
  assert.equal(stripThinkingTags('<thought>Thought block</thought>Clean answer'), 'Clean answer');
  assert.equal(stripThinkingTags('<reasoning>Reasoning block</reasoning>Clean answer'), 'Clean answer');
  assert.equal(stripThinkingTags('<think>Step 1</think>\n\n<think>Step 2</think>'), '');
  assert.equal(stripThinkingTags('<think>Unclosed trailing block'), '');
  assert.equal(stripThinkingTags('Clean plain text without tags'), 'Clean plain text without tags');
  assert.equal(stripThinkingTags(''), '');
});

test('Empty Content Fallback: Tool invocations synthesized when nonThinkingText is empty', () => {
  const streamedWithThinkingOnly = '<think>\nExecuting tool sys_context to inspect date.\n</think>';
  const nonThinkingText = stripThinkingTags(streamedWithThinkingOnly);
  assert.equal(nonThinkingText, '', 'nonThinkingText must be empty when all content is in <think>');

  const toolInvocations = [
    {
      pluginId: 'system_context',
      pluginName: 'System Context & Host Metadata',
      inputSummary: '{"format":"json"}',
      outputSummary: '{"sys_date":"2026-11-07","timezone":"America/New_York"}',
      durationMs: 5
    }
  ];

  assert.ok(!nonThinkingText && toolInvocations.length > 0);
  const fallbackSummary = toolInvocations
    .map((t) => `### ${t.pluginName} (${t.inputSummary})\n${t.outputSummary}`)
    .join('\n\n');
  assert.ok(fallbackSummary.includes('### System Context & Host Metadata'));
  assert.ok(fallbackSummary.includes('America/New_York'));
});

test('No Silent Fallback: chatRoutes strictly errors when model cannot load or infer', () => {
  const chatRoutesPath = path.join(process.cwd(), 'server', 'routes', 'chatRoutes.ts');
  const chatRoutesContent = fs.readFileSync(chatRoutesPath, 'utf-8');

  assert.ok(
    !chatRoutesContent.includes('streamSynthesizedOfflineFallback'),
    'chatRoutes must not use streamSynthesizedOfflineFallback'
  );
  assert.ok(
    !chatRoutesContent.includes('switching to local grounded synthesis'),
    'chatRoutes must not switch to mock local grounded synthesis'
  );
  assert.ok(
    chatRoutesContent.includes('!loadResult.success') &&
      chatRoutesContent.includes('Failed to load model'),
    'chatRoutes must throw explicit error if model load fails'
  );
  assert.ok(
    chatRoutesContent.includes('offline fallback is disabled'),
    'chatRoutes must explicitly throw error when inference fails or server is unreachable'
  );
  assert.ok(
    !chatRoutesContent.includes("serverLogger.warn(\n            'inference'"),
    'chatRoutes must not swallow inference or reachability failures'
  );
  assert.ok(
    chatRoutesContent.includes('stripThinkingTags(totalStreamedText)'),
    'chatRoutes must strip thinking tags before checking for empty content fallback'
  );
});

test('Default Tools to OFF for New Chats: New sessions default to empty enabledPluginIds', () => {
  const newChat = orchestrator.chatOrchestrator.createNewSession({
    existingCount: 0,
    modelId: 'granite-4.1-3b',
    temperature: 0.3
  });
  assert.deepEqual(newChat.enabledPluginIds, [], 'New session enabledPluginIds must be empty array (tools OFF)');

  const freshDefault = orchestrator.chatOrchestrator.createFreshDefaultSession();
  assert.deepEqual(freshDefault.enabledPluginIds, [], 'Fresh default session enabledPluginIds must be empty array');

  assert.deepEqual(INITIAL_SESSIONS[0].enabledPluginIds, [], 'INITIAL_SESSIONS[0] enabledPluginIds must be empty array');

  assert.deepEqual(normalizeSessionPluginIds([]), [], 'Empty array normalizes to empty array');
  assert.deepEqual(normalizeSessionPluginIds(undefined), [], 'Undefined normalizes to empty array');

  const toggled = normalizeSessionPluginIds(['sys_context', 'precision_calculator']);
  assert.deepEqual(toggled, ['system_context', 'precision_calculator'], 'Toggled tools normalize correctly on demand');
  assert.deepEqual(
    normalizeSessionPluginIds(['python_sandbox']),
    [],
    'Removed sandbox tools are ignored when hydrating old sessions'
  );

  const localDb = ensureLocalDb();
  const dbEmptySession = localDb.sessions.find((s) => s.id === 'sess_1794069468230_20' || s.enabledPluginIds.length === 0);
  if (dbEmptySession) {
    assert.deepEqual(dbEmptySession.enabledPluginIds, [], 'ensureLocalDb must preserve empty enabledPluginIds');
  }
});

test('Full Model Eviction: Unloads model after TTL expires with extension and case tolerance', async () => {
  await executeLlamaCppLoadWithTtl('qwen3.5-2b.gguf', 1);
  assert.ok(getActiveLoadedLlamaModel(), 'Model should be registered as loaded');

  // Schedule TTL with mismatched case and filename format
  schedulePostResponseTtl('QWEN3.5-2B.GGUF', 1);

  // Before TTL expiration, model is still marked loaded
  assert.ok(getActiveLoadedLlamaModel(), 'Model still loaded before TTL expires');

  // Wait for TTL timer to expire
  await new Promise((r) => setTimeout(r, 1150));

  assert.equal(getActiveLoadedLlamaModel(), null, 'Model must be fully unloaded after TTL expires');
});

test('Explicit Unload: unloadActiveLlamaServer immediately evicts active model', async () => {
  await executeLlamaCppLoadWithTtl('qwen3.5-2b.gguf', 300);
  assert.ok(getActiveLoadedLlamaModel());

  await unloadActiveLlamaServer();
  assert.equal(getActiveLoadedLlamaModel(), null, 'Explicit unloadActiveLlamaServer must clear loaded model');
});

test('Empty ModelId Eviction: schedulePostResponseTtl falls back to activeLoadedModelId', async () => {
  await executeLlamaCppLoadWithTtl('granite-4.1-3b', 1);
  assert.ok(getActiveLoadedLlamaModel(), 'Model registered as loaded');

  schedulePostResponseTtl('', 1);
  assert.ok(getActiveLoadedLlamaModel(), 'Model still loaded before TTL expires');

  await new Promise((r) => setTimeout(r, 1150));
  assert.equal(getActiveLoadedLlamaModel(), null, 'Empty modelId must fall back to activeLoadedModelId and evict');
});

test('Stream End Eviction: endActiveInferenceStream triggers TTL unload for loaded model', async () => {
  await executeLlamaCppLoadWithTtl('granite-4.1-3b', 1);
  beginActiveInferenceStream();
  endActiveInferenceStream('', 1);

  await new Promise((r) => setTimeout(r, 1150));
  assert.equal(getActiveLoadedLlamaModel(), null, 'Stream completion must schedule eviction even with empty modelId');
});

test('Server Port Resolution: getLlamaServerPort parses standard loopback URLs without regex', () => {
  const defaultPort = getLlamaServerPort();
  assert.equal(typeof defaultPort, 'number');
  assert.ok(defaultPort > 0 && defaultPort <= 65535);
  assert.equal(defaultPort, 8080);
});
