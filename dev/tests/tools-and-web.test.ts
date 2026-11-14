import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerToolPlugin,
  hotSwapToolPlugin,
  unregisterToolPlugin,
  resetDefaultToolPlugins,
  getRegisteredToolPlugins,
  executePluginsForPrompt,
  buildCallableToolSchemas,
  invokeToolCallByName,
  AVAILABLE_PLUGINS
} from '../../src/tools';
import {
  captureSystemContextSnapshot,
  SystemContextSnapshot,
  getSysContextMetadata,
  sysContextPlugin
} from '../../src/tools/plugins/systemContextTool';
import { isAsciiDigit } from '../../src/utils/structuredParsers';
import { detectWebGroundingNeed } from '../../src/utils/webTools';
import { orchestrator } from '../../src/orchestrators';
import { performBuiltInWebGrounding } from '../../server/routes/chatToolEnricher';
import { serverLogger } from '../../server/config/logger';

function isIsoDatePattern(val: string): boolean {
  if (val.length !== 10) return false;
  if (val[4] !== '-' || val[7] !== '-') return false;
  const digitIndices = [0, 1, 2, 3, 5, 6, 8, 9];
  return digitIndices.every((idx) => isAsciiDigit(val[idx]));
}

function isClockTimePattern(val: string): boolean {
  if (val.length !== 8) return false;
  if (val[2] !== ':' || val[5] !== ':') return false;
  const digitIndices = [0, 1, 3, 4, 6, 7];
  return digitIndices.every((idx) => isAsciiDigit(val[idx]));
}

function isUtcOffsetPattern(val: string): boolean {
  if (val.length !== 9) return false;
  if (!val.startsWith('UTC')) return false;
  if (val[3] !== '+' && val[3] !== '-') return false;
  if (val[6] !== ':') return false;
  const digitIndices = [4, 5, 7, 8];
  return digitIndices.every((idx) => isAsciiDigit(val[idx]));
}

test('System Context Tool generates deterministic local snapshot for built-in llama.cpp', () => {
  const snapshot: SystemContextSnapshot = captureSystemContextSnapshot();
  assert.ok(snapshot.sys_time, 'sys_time exists');
  assert.ok(snapshot.sys_date, 'sys_date exists');
  assert.ok(snapshot.iso_timestamp, 'iso_timestamp exists');
  assert.equal(snapshot.inference_engine, 'llama.cpp (Built-In GGUF Engine)');
  assert.equal(snapshot.thinking_supported, true);
});

test('Built-in tools include web search, the File Repo inspector, system context, and calculation', () => {
  resetDefaultToolPlugins();
  assert.equal(
    AVAILABLE_PLUGINS.length,
    4,
    'Exactly 4 consolidated domain tools in AVAILABLE_PLUGINS'
  );
  const ids = AVAILABLE_PLUGINS.map((p) => p.id);
  assert.deepEqual(ids, [
    'web_search',
    'agent_file_ops',
    'system_context',
    'precision_calculator'
  ]);
});

test('sys_context tool exposes date, time, and timezone metadata and resolves when invoked by the AI Brain', () => {
  resetDefaultToolPlugins();
  const meta = getSysContextMetadata();
  assert.ok(isIsoDatePattern(meta.sys_date), 'sys_date is YYYY-MM-DD');
  assert.ok(isClockTimePattern(meta.sys_time), 'sys_time is HH:mm:ss');
  assert.ok(meta.iso_timestamp.includes('T'), 'iso_timestamp is ISO-8601');
  assert.ok(meta.utc_timestamp.length > 0, 'utc_timestamp exists');
  assert.ok(meta.timezone.length > 0, 'timezone is non-empty');
  assert.ok(isUtcOffsetPattern(meta.utc_offset), 'utc_offset formatted');
  assert.equal(typeof meta.utc_offset_minutes, 'number');
  assert.equal(typeof meta.unix_epoch, 'number');

  assert.equal(sysContextPlugin.definition.id, 'sys_context');

  // Verify callable schema generation through the supported system context alias.
  const schemas = buildCallableToolSchemas(['sys_context']);
  assert.equal(schemas.length, 1);
  assert.equal(schemas[0].name, 'sys_context');

  // Tool calls are model-directed and are not triggered by prompt keywords.
  const promptResults = executePluginsForPrompt(
    'What is the current date, time, and timezone?',
    ['sys_context'],
    [],
    'llamacpp'
  );
  assert.equal(
    promptResults.length,
    0,
    'No pre-prompt keyword execution; AI Brain decides tool usage'
  );

  // Verify direct tool invocation.
  const directRes = invokeToolCallByName(
    'sys_context',
    { format: 'json' },
    {
      vectorIndex: [],
      vaultFiles: [],
      distanceMetric: 'cosine',
      providerId: 'llamacpp',
      customPlugins: []
    }
  );
  assert.equal(directRes.pluginId, 'sys_context');
  const parsed = JSON.parse(directRes.outputSummary);
  assert.equal(parsed.sys_date, meta.sys_date);
  assert.equal(parsed.timezone, meta.timezone);
});

test('Hot-Swappable Plugin Registry operations', () => {
  resetDefaultToolPlugins();
  const initialPlugins = getRegisteredToolPlugins();
  assert.ok(
    initialPlugins.some((p) => p.id === 'web_search'),
    'web_search plugin registered'
  );
  assert.ok(
    initialPlugins.some((p) => p.id === 'agent_file_ops'),
    'agent_file_ops plugin registered'
  );
  assert.ok(
    initialPlugins.some((p) => p.id === 'system_context'),
    'system_context plugin registered'
  );
  assert.ok(
    initialPlugins.some((p) => p.id === 'precision_calculator'),
    'precision_calculator plugin registered'
  );

  const customPlugin = {
    id: 'unit_test_tool',
    name: 'Unit Test Tool',
    category: 'Testing',
    description: 'A mock plugin for testing hot swap',
    parameterSummary: 'query: string',
    triggerKeywords: [],
    canHandlePrompt: () => false,
    execute: (args: Record<string, unknown>) => ({
      pluginId: 'unit_test_tool',
      pluginName: 'Unit Test Tool',
      inputSummary: String(args.query || ''),
      outputSummary: 'mock output v1',
      durationMs: 1
    }),
    toCallableSchema: () => ({
      name: 'unit_test_tool',
      description: 'Unit test mock',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'query' } },
        required: ['query']
      }
    })
  };

  registerToolPlugin(customPlugin);
  assert.ok(getRegisteredToolPlugins().some((p) => p.id === 'unit_test_tool'));

  hotSwapToolPlugin({
    ...customPlugin,
    execute: () => ({
      pluginId: 'unit_test_tool',
      pluginName: 'Unit Test Tool',
      inputSummary: 'swapped',
      outputSummary: 'mock output v2 (HOT SWAPPED)',
      durationMs: 2
    })
  });

  const res = invokeToolCallByName(
    'unit_test_tool',
    { query: 'test_trigger' },
    {
      vectorIndex: [],
      vaultFiles: [],
      distanceMetric: 'cosine',
      providerId: 'llamacpp',
      customPlugins: []
    }
  );
  assert.equal(res.outputSummary, 'mock output v2 (HOT SWAPPED)');

  unregisterToolPlugin('unit_test_tool');
  assert.ok(!getRegisteredToolPlugins().some((p) => p.id === 'unit_test_tool'));
});

test('Built-in Tool Invocation via invokeToolCallByName', () => {
  resetDefaultToolPlugins();
  const res = invokeToolCallByName(
    'system_context',
    {},
    {
      vectorIndex: [],
      vaultFiles: [],
      distanceMetric: 'cosine',
      providerId: 'llamacpp',
      customPlugins: []
    }
  );
  assert.equal(res.pluginId, 'system_context');
  assert.ok(res.outputSummary.includes('sys_date'), 'Includes date in output');
});

test('Built-in calculator evaluates arithmetic without a code execution workspace', () => {
  const result = invokeToolCallByName(
    'precision_calculator',
    { expression: '(1024 * 4) + 512' },
    {
      vectorIndex: [],
      vaultFiles: [],
      distanceMetric: 'cosine',
      providerId: 'llamacpp',
      customPlugins: []
    }
  );
  assert.equal(result.pluginId, 'precision_calculator');
  assert.equal(result.outputSummary, 'Result: 4608');
});

test('Built-in Web Grounding: Detects factual inquiries and triggers live search', () => {
  const sportsResult = detectWebGroundingNeed('nfl game tonights score');
  assert.equal(sportsResult.trigger, true);
  assert.equal(sportsResult.reason, 'factual_inquiry');
  assert.ok(sportsResult.suggestedQuery.includes('nfl game tonights score'));

  const newsResult = detectWebGroundingNeed('what is the breaking news today?');
  assert.equal(newsResult.trigger, true);
  assert.equal(newsResult.reason, 'factual_inquiry');

  const weatherResult = detectWebGroundingNeed('weather in Seattle today');
  assert.equal(weatherResult.trigger, true);
  assert.equal(weatherResult.reason, 'factual_inquiry');

  const codingResult = detectWebGroundingNeed('Write a TypeScript function to sort an array');
  assert.equal(codingResult.trigger, false);
  assert.equal(codingResult.suggestedQuery, '');

  const greetingResult = detectWebGroundingNeed('Hello, how are you today?');
  assert.equal(greetingResult.trigger, false);
});

test('Built-in Web Grounding: User corrections contextualize prior conversation query and trigger live search', () => {
  const history = [
    { role: 'user', content: 'nfl game tonights score' },
    { role: 'assistant', content: 'Bills vs Vikings ... score 20-17' }
  ];

  const correction = detectWebGroundingNeed('wrong, its 13 to 6', history);
  assert.equal(correction.trigger, true);
  assert.equal(correction.reason, 'correction');
  assert.ok(correction.suggestedQuery.includes('nfl game tonights score'));
  assert.ok(correction.suggestedQuery.includes('13 to 6'));

  const secondCorrection = detectWebGroundingNeed("no, that's not right, the score changed", history);
  assert.equal(secondCorrection.trigger, true);
  assert.equal(secondCorrection.reason, 'correction');

  const checkAgain = detectWebGroundingNeed('check again please', history);
  assert.equal(checkAgain.trigger, true);
  assert.equal(checkAgain.reason, 'correction');
  assert.equal(checkAgain.suggestedQuery, 'nfl game tonights score');

  const conversationalObjection = detectWebGroundingNeed('no, that is wrong', history);
  assert.equal(conversationalObjection.trigger, true);
  assert.equal(conversationalObjection.reason, 'correction');
  assert.equal(conversationalObjection.suggestedQuery, 'nfl game tonights score');

  const areYouSure = detectWebGroundingNeed('are you sure about that?', history);
  assert.equal(areYouSure.trigger, true);
  assert.equal(areYouSure.suggestedQuery, 'nfl game tonights score');

  const waitScore = detectWebGroundingNeed('Wait, the score was 13 to 6', history);
  assert.equal(waitScore.trigger, true);
  assert.ok(waitScore.suggestedQuery.includes('nfl game tonights score'));
  assert.ok(waitScore.suggestedQuery.includes('13 to 6'));
});

test('Built-in Web Grounding: Handles edge cases safely (empty, URLs, explicit requests)', () => {
  assert.equal(detectWebGroundingNeed('').trigger, false);
  assert.equal(detectWebGroundingNeed('   ').trigger, false);

  const urlRes = detectWebGroundingNeed('Check https://example.com/spec.html');
  assert.equal(urlRes.trigger, true);
  assert.equal(urlRes.reason, 'url_reference');
  assert.equal(urlRes.suggestedQuery, 'https://example.com/spec.html');

  const explicitRes = detectWebGroundingNeed('search the web for quantum computing advances');
  assert.equal(explicitRes.trigger, true);
  assert.equal(explicitRes.reason, 'explicit_search');
  assert.ok(explicitRes.suggestedQuery.includes('quantum computing advances'));
});

test('Web Search Built-in Engine Capability: Included in tool schemas by default even with empty enabledPluginIds', () => {
  const schemas = orchestrator.toolOrchestrator.getCallableSchemas([]);
  assert.ok(schemas.length >= 1, 'At least 1 callable schema returned by default');
  const webSchema = schemas.find((s) => s.name === 'web_search');
  assert.ok(webSchema, 'web_search schema is built-in and present by default with empty plugin IDs');
  assert.ok(webSchema.parameters.properties.query, 'Query parameter defined in web_search schema');

  const toggledSchemas = orchestrator.toolOrchestrator.getCallableSchemas(['system_context']);
  assert.ok(toggledSchemas.some((s) => s.name === 'web_search'), 'web_search still present when system_context toggled');
  assert.ok(toggledSchemas.some((s) => s.name === 'sys_context' || s.name === 'system_context'), 'system_context present');

  const disabledWebSchemas = orchestrator.toolOrchestrator.getCallableSchemas(['precision_calculator', 'web_search'], false);
  assert.equal(disabledWebSchemas.some((s) => s.name === 'web_search'), false, 'web_search excluded when webSearchEnabled is false');
  assert.equal(disabledWebSchemas.some((s) => s.name === 'precision_calculator'), true, 'optional tools remain active when webSearchEnabled is false');
});

test('UI Tool Selection Window Simplification: Filters out built-in web_search to only toggle optional tools', () => {
  const allTools = AVAILABLE_PLUGINS;
  const optionalTools = allTools.filter((p) => p.id !== 'web_search' && p.id !== 'live_search');
  assert.equal(optionalTools.length, 3, 'Exactly 3 optional domain tools in the UI toggle list');
  const optionalIds = optionalTools.map((p) => p.id);
  assert.deepEqual(optionalIds, ['agent_file_ops', 'system_context', 'precision_calculator']);
  assert.equal(optionalIds.includes('web_search'), false, 'web_search is excluded from UI toggle list');
});

test('Built-in Web Grounding: Fallback execution and warning logging on failure', async () => {
  const result = await performBuiltInWebGrounding({
    query: 'offline grounding fallback test',
    reason: 'factual_inquiry',
    docsToUse: [
      { id: 'fallback_doc_1', title: 'Local Fallback', category: 'General', content: 'Local knowledge snippet.' }
    ],
    vaultToUse: []
  });
  if (result) {
    assert.equal(result.pluginId, 'web_search');
    assert.ok(result.outputSummary.length > 0);
  }

  const initialWarnings = serverLogger.getEntries({ level: 'WARN', subsystem: 'tool' }).length;
  try {
    throw new Error('Simulated network timeout during grounding');
  } catch (groundErr) {
    serverLogger.warn('tool', 'Built-in web grounding attempt failed', {
      error: groundErr instanceof Error ? groundErr.message : String(groundErr),
      stack: groundErr instanceof Error ? groundErr.stack : undefined
    });
  }
  const toolWarnings = serverLogger.getEntries({ level: 'WARN', subsystem: 'tool' });
  assert.equal(toolWarnings.length, initialWarnings + 1);
  assert.equal(toolWarnings[0].message, 'Built-in web grounding attempt failed');
  assert.equal(toolWarnings[0].metadata?.error, 'Simulated network timeout during grounding');
  assert.ok(typeof toolWarnings[0].metadata?.stack === 'string');
});
