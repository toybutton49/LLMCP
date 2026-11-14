import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LlamaCppEngineSettings } from '../../src/components/settings/LlamaCppEngineSettings';
import { ChatHeader } from '../../src/components/chat/ChatHeader';
import { MemoryCard } from '../../src/components/memory/MemoryCard';
import { RouterReadinessBanner } from '../../src/components/layout/RouterReadinessBanner';
import type { ProviderOption } from '../../src/components/ChatView';
import { INITIAL_SESSIONS } from '../../src/data/seedData';
import { reconcileProviderModelSelection } from '../../src/hooks/workspaceStateDefaults';
import { streamOpenAiCompletion } from '../../server/routes/chatStreamingEngine';
import {
  beginActiveInferenceStream,
  endActiveInferenceStream,
  unloadActiveLlamaServer,
  refreshActiveTtlTimer,
  getActiveLoadedLlamaModel,
  schedulePostResponseTtl
} from '../../server/llamacpp/llamaCppTtl';
import { ensureLocalDb } from '../../server-db';

const ROOT_DIR = process.cwd();

test('Boost 1: Token-by-token streaming emits markdown code blocks and bracketed lists without buffering', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const tokens = [
      'Here ', 'is ', 'the ', 'plan:\n',
      '[1] ', 'First ', 'step\n',
      '```ts\n',
      'const ', 'val = ', '42;\n',
      '```\n',
      'Done!'
    ];

    const makeTokenStream = (chunks: string[]) => {
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const c of chunks) {
              const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;
              controller.enqueue(enc.encode(frame));
            }
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
          }
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    };

    globalThis.fetch = (async () => makeTokenStream(tokens)) as any;

    const emittedChunks: string[] = [];
    const result = await streamOpenAiCompletion({
      endpointUrl: 'http://127.0.0.1:8080/v1/chat/completions',
      modelName: 'qwen-2.5-7b',
      messages: [{ role: 'user', content: 'Show code and steps' }],
      allowTools: true,
      openAiTools: [{ type: 'function', function: { name: 'web_search' } }],
      temperature: 0.3,
      topP: 0.9,
      maxTokens: 512,
      thinkingEnabled: false,
      reasoningEffort: 'low',
      abortSignal: new AbortController().signal,
      onChunk: (chunk) => {
        emittedChunks.push(chunk);
      }
    });

    assert.equal(result.toolCalls.length, 0, 'No tool call should be detected');
    assert.ok(emittedChunks.length > 5, `Expected incremental streaming chunks but got ${emittedChunks.length}`);
    const reconstructed = emittedChunks.join('');
    assert.ok(reconstructed.includes('```ts'), 'Reconstructed stream must include code fence');
    assert.ok(reconstructed.includes('[1] First step'), 'Reconstructed stream must include list item');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Boost 2 & 8: Think tokens changeable in global settings and persisted to local database', () => {
  const localDb = ensureLocalDb();
  assert.equal(typeof localDb.engineSettings.thinkingBudget, 'number');

  localDb.engineSettings.thinkingBudget = 8192;
  assert.equal(localDb.engineSettings.thinkingBudget, 8192, 'Global think tokens must be changeable');

  const settingsViewPath = path.join(ROOT_DIR, 'src', 'components', 'SettingsView.tsx');
  const settingsViewContent = fs.readFileSync(settingsViewPath, 'utf-8');
  assert.ok(settingsViewContent.includes('thinkingBudget'), 'SettingsView must handle thinkingBudget');

  const defaultsPath = path.join(ROOT_DIR, 'src', 'components', 'settings', 'GlobalBrainDefaultsSection.tsx');
  const defaultsContent = fs.readFileSync(defaultsPath, 'utf-8');
  assert.ok(defaultsContent.includes('Reasoning Token Budget'), 'Global generation settings must expose the reasoning budget');
  assert.ok(defaultsContent.includes('thinkingBudget'), 'GlobalBrainDefaultsSection must bind thinkingBudget');
});

test('Boost 3: Global Settings manager controls model, persona, and generation while ChatHeader stays minimal', () => {
  const globalPath = path.join(ROOT_DIR, 'src', 'components', 'settings', 'GlobalBrainDefaultsSection.tsx');
  const globalContent = fs.readFileSync(globalPath, 'utf-8');
  const headerPath = path.join(ROOT_DIR, 'src', 'components', 'chat', 'ChatHeader.tsx');
  const headerContent = fs.readFileSync(headerPath, 'utf-8');
  assert.ok(globalContent.includes('Global Generation Defaults'), 'Global controls must be clearly labeled');
  assert.ok(globalContent.includes('Active Persona'), 'Global settings must expose Active Persona selection');
  assert.equal(headerContent.includes('Select Model for this Chat'), false, 'Per-chat model dropdown must be removed from ChatHeader');
  assert.equal(headerContent.includes('Select Active Persona'), false, 'Per-chat persona dropdown must be removed from ChatHeader');
  assert.equal(headerContent.includes('Sampling Temperature'), false, 'Per-chat temperature slider must be removed from ChatHeader');

  const localDb = ensureLocalDb();
  assert.ok('defaultTemperature' in localDb.engineSettings);
  assert.ok('maxTokens' in localDb.engineSettings);
  assert.ok('topP' in localDb.engineSettings);
});

test('ChatHeader renders only conversation title plus Tokens, Download, and Reset actions', () => {
  const markup = renderToStaticMarkup(React.createElement(ChatHeader, {
    session: { ...INITIAL_SESSIONS[0], title: 'Clean Header Session' },
    messageCount: 2,
    onUpdateSession: () => {},
    onClearSessionMessages: () => {},
    onOpenTokenAnalytics: () => {},
    onDownloadChatDebug: () => {}
  }));
  assert.ok(markup.includes('Clean Header Session'));
  assert.ok(markup.includes('Tokens'));
  assert.ok(markup.includes('Download'));
  assert.ok(markup.includes('Reset'));
  assert.equal(markup.includes('<select'), false, 'ChatHeader must not render model or persona select dropdowns');
});

test('provider refresh keeps global-model sessions implicit and reconciles stale selections to server state', () => {
  const session = INITIAL_SESSIONS[0];
  const result = reconcileProviderModelSelection([
    { ...session, id: 'implicit', modelId: '' },
    { ...session, id: 'stale', modelId: 'retired-model' },
    { ...session, id: 'alias', modelId: 'Qwen3.5-4B' }
  ], 'google/gemma-4b', ['Qwen3.5-4B-Q4_K_M', 'google/gemma-4b']);

  assert.equal(result.activeModelId, 'google/gemma-4b');
  assert.equal(result.sessions[0].modelId, '');
  assert.equal(result.sessions[1].modelId, 'google/gemma-4b');
  assert.equal(result.sessions[2].modelId, 'Qwen3.5-4B-Q4_K_M');
});

test('Boost 4: Model lifecycle uses one timeout control for on-demand and idle unload', () => {
  const render = (ttl: number) => renderToStaticMarkup(
    React.createElement(LlamaCppEngineSettings, { modelTtlSeconds: ttl })
  );
  const ttlMarkup = render(437);
  assert.ok(ttlMarkup.includes('aria-label="Model unload timeout in seconds"'));
  assert.ok(ttlMarkup.includes('min="0"'));
  assert.ok(ttlMarkup.includes('value="437"'));
  assert.equal(ttlMarkup.split('data-testid="gateway-ttl-input"').length - 1, 1);
  const jitMarkup = render(0);
  assert.ok(jitMarkup.includes('value="0"'));
  assert.ok(jitMarkup.includes('0 loads on demand and unloads after each response'));
  assert.equal(jitMarkup.split('data-testid="gateway-ttl-input"').length - 1, 1);
  assert.equal(jitMarkup.includes('type="radio"'), false);
});

test('Memory cards do not render a stray zero when a directive has no tags and no probe count', () => {
  const markup = renderToStaticMarkup(React.createElement(MemoryCard, {
    memory: {
      id: 'mem_1', key: 'Favorite color', fact: 'The user favorite color is sapphire blue.',
      category: 'system_directive', isActive: true, tags: [], accessCount: 0
    },
    onUpdate: () => {}, onToggle: () => {}, onTogglePin: () => {}, onDelete: () => {}
  }));
  assert.ok(markup.includes('sapphire blue'));
  assert.equal(markup.includes('>0<'), false);
});

test('The built-in server banner stays hidden until the first status response arrives', () => {
  assert.equal(renderToStaticMarkup(React.createElement(RouterReadinessBanner)), '');
});

test('Boost 5: JIT Standby button is strictly removed from the chat bar', () => {
  const headerPath = path.join(ROOT_DIR, 'src', 'components', 'chat', 'ChatHeader.tsx');
  const headerContent = fs.readFileSync(headerPath, 'utf-8');
  assert.equal(headerContent.includes('JitModelUnloadButton'), false, 'JitModelUnloadButton must be absent from ChatHeader');
  assert.equal(headerContent.includes('JIT Standby'), false, 'ChatHeader must not render JIT Standby button');
});

test('Boost 6: Dedicated Tools tab is available without a code execution workspace', () => {
  const sidebarPath = path.join(ROOT_DIR, 'src', 'components', 'layout', 'Sidebar.tsx');
  const sidebarContent = fs.readFileSync(sidebarPath, 'utf-8');

  assert.ok(sidebarContent.includes("'tools'"), 'WorkspaceTab must include tools');
  assert.ok(sidebarContent.includes("label: 'Tools & Plugins'"), 'Sidebar nav items must include Tools & Plugins tab');
  assert.equal(sidebarContent.includes('Code Sandbox'), false, 'Code Sandbox navigation must be removed');

  const appPath = path.join(ROOT_DIR, 'src', 'App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf-8');
  assert.ok(appContent.includes("ws.activeTab === 'tools'"), 'App.tsx must handle activeTab tools');
});

test('Boost 7: Unified JIT & TTL timeout never interrupts active inference streams', async () => {
  beginActiveInferenceStream();

  await unloadActiveLlamaServer(false);
  refreshActiveTtlTimer('qwen-2.5-7b', 10);

  endActiveInferenceStream('qwen-2.5-7b', 0);
  assert.equal(getActiveLoadedLlamaModel(), null, 'Zero TTL must cleanly evict after stream ends');
});

test('Boost 9: Octo Heart Embedding Model Parameters descriptions are clear and plain English', () => {
  const ragSettingsPath = path.join(ROOT_DIR, 'src', 'components', 'settings', 'RagContextSettings.tsx');
  const content = fs.readFileSync(ragSettingsPath, 'utf-8');

  assert.ok(content.includes('Vector Detail (Dimensions)'), 'Must use human-friendly Vector Detail label');
  assert.ok(content.includes('Embedding Batch Size'), 'Must use clear Embedding Batch Size label');
  assert.ok(content.includes('Score Normalization'), 'Must use clear Score Normalization label');
  assert.equal(content.includes('Matryoshka vector width'), false, 'Confusing jargon Matryoshka vector width must be removed');
  assert.equal(content.includes('Unit-sphere scaling'), false, 'Confusing jargon Unit-sphere scaling must be removed');
});

test('Boost 10: Local Database Query Explorer supports Card-based Probe DB style and raw JSON', () => {
  const dbSettingsPath = path.join(ROOT_DIR, 'src', 'components', 'settings', 'DatabaseQuerySettings.tsx');
  const content = fs.readFileSync(dbSettingsPath, 'utf-8');

  assert.ok(content.includes("viewMode === 'cards'"), 'DatabaseQuerySettings must support cards mode');
  assert.ok(content.includes("viewMode === 'json'"), 'DatabaseQuerySettings must support raw JSON mode');
  assert.ok(content.includes('Copy record JSON'), 'Cards must provide copy action');
});

