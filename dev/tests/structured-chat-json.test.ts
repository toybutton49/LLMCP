import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatView } from '../../src/components/ChatView';
import { ChatComposer } from '../../src/components/chat/ChatComposer';
import { MarkdownContent } from '../../src/components/chat/MarkdownContent';
import { ChatToolsTab } from '../../src/components/tools/ChatToolsTab';
import { PluginsAndGatewayView } from '../../src/components/tools/PluginsAndGatewayView';
import { GlobalGenerationDefaultsSection } from '../../src/components/settings/GlobalBrainDefaultsSection';
import { GgufAndHardwareSection } from '../../src/components/settings/GgufAndHardwareSection';
import { RagContextSettings } from '../../src/components/settings/RagContextSettings';
import { SecurityAndSnapshotsSettings } from '../../src/components/settings/SecurityAndSnapshotsSettings';
import { AVAILABLE_PLUGINS, composeSystemInstruction, createVaultFileEntry } from '../../src/utils/rag';
import { GENERATION_DEFAULTS } from '../../src/data/runtimeDefaults';
import { DEFAULT_BRANDING, INITIAL_SESSIONS } from '../../src/data/seedData';
import {
  buildProgrammaticPromptEnvelope,
  buildProgrammaticResponseEnvelope
} from '../../src/utils/structuredChatEnvelope';
import { orchestrator } from '../../src/orchestrators';

describe('Programmatic Prompt & Response Structure (Non-JSON Chat UI)', () => {
  it('renders the composer and streamed message with the connected chat props', () => {
    const props: React.ComponentProps<typeof ChatView> = {
      branding: DEFAULT_BRANDING,
      session: INITIAL_SESSIONS[0],
      messages: [],
      activeProviderId: 'llamacpp',
      activeModelId: 'test-model',
      promptTemplates: [],
      customPlugins: [],
      ragDocuments: [],
      vaultFiles: [],
      memories: [],
      isStreaming: true,
      streamingText: '<think>Checking</think>Streaming answer',
      liveRagHits: [],
      liveVaultHits: [],
      liveToolResults: [],
      onSendMessage: async () => {},
      onStopStreaming: () => {},
      onDeleteMessage: () => {},
      onEditMessage: () => {},
      onForkSession: () => {},
      onRegenerateLastResponse: () => {},
      onSaveMemoryCandidate: () => {},
      onAddVaultFiles: () => {},
      onUpdateSession: () => {},
      onClearSessionMessages: () => {}
    };
    const markup = renderToStaticMarkup(React.createElement(ChatView, props));
    assert.ok(markup.includes('Prompt input'));
    assert.ok(markup.includes('Streaming answer'));
    assert.ok(markup.includes('Checking'));
    assert.ok(!markup.includes('LLMCP Octopus Logo'));

    const emptyChat = renderToStaticMarkup(React.createElement(ChatView, {
      ...props, isStreaming: false, streamingText: ''
    }));
    assert.ok(emptyChat.includes('/assets/logos/llmcp-octopus.jpg'));
    assert.ok(emptyChat.includes('LLMCP Octopus Logo'));
    assert.ok(emptyChat.indexOf('LLMCP Octopus Logo') < emptyChat.indexOf('Your local AI assistant'));
  });

  it('builds a deterministic programmatic prompt envelope for backend and chat pipeline integrity', () => {
    const env = buildProgrammaticPromptEnvelope({
      sessionId: 'sess_test_1',
      modelId: 'Qwen3-8B-Q4_K_M.gguf',
      prompt: 'Analyze the Octo Heart vector store latency.',
      temperature: 0.25,
      thinkingEnabled: true,
      reasoningEffort: 'high',
      enabledTools: ['agent_file_ops', 'precision_calculator'],
      ragEnabled: true,
      vaultEnabled: true,
      memoryEnabled: true
    });

    assert.equal(env.schemaVersion, '1.0');
    assert.equal(env.role, 'user');
    assert.equal(env.sessionId, 'sess_test_1');
    assert.equal(env.modelId, 'Qwen3-8B-Q4_K_M.gguf');
    assert.equal(env.prompt, 'Analyze the Octo Heart vector store latency.');
    assert.equal(env.temperature, 0.25);
    assert.equal(env.thinkingEnabled, true);
    assert.equal(env.reasoningEffort, 'high');
    assert.deepEqual(env.enabledTools, ['agent_file_ops', 'precision_calculator']);
    assert.deepEqual(env.contextFlags, {
      ragEnabled: true,
      vaultEnabled: true,
      memoryEnabled: true
    });
  });

  it('demultiplexes thinking traces and builds a deterministic programmatic response envelope without breaking on partial streams or aborted turns', () => {
    const streamingEnv = orchestrator.chatOrchestrator.buildProgrammaticResponseEnvelope({
      sessionId: 'sess_test_1',
      modelId: 'Qwen3-8B-Q4_K_M.gguf',
      rawContent: '<think>Evaluating cosine similarity bounds</think>Sub-10ms vector lookup confirmed.',
      isStreaming: false,
      latencyMs: 500,
      tokenCount: 25
    });

    assert.equal(streamingEnv.schemaVersion, '1.0');
    assert.equal(streamingEnv.role, 'assistant');
    assert.equal(streamingEnv.status, 'completed');
    assert.equal(streamingEnv.reasoning, 'Evaluating cosine similarity bounds');
    assert.equal(streamingEnv.response, 'Sub-10ms vector lookup confirmed.');
    assert.equal(streamingEnv.metrics.tokens, 25);
    assert.equal(streamingEnv.metrics.latencyMs, 500);
    assert.equal(streamingEnv.metrics.tokPerSec, 50);

    const timedEnv = orchestrator.chatOrchestrator.buildProgrammaticResponseEnvelope({
      sessionId: 'sess_test_1',
      modelId: 'Qwen3-8B-Q4_K_M.gguf',
      rawContent: 'Answer after a cold model load.',
      latencyMs: 18000,
      generationMs: 4000,
      tokenCount: 40
    });
    assert.equal(timedEnv.metrics.latencyMs, 18000);
    assert.equal(timedEnv.metrics.tokPerSec, 10, 'tok/s uses generation time, not load-inclusive latency');

    const abortedEnv = orchestrator.chatOrchestrator.buildProgrammaticResponseEnvelope({
      sessionId: 'sess_test_1',
      modelId: 'Qwen3-8B-Q4_K_M.gguf',
      rawContent: 'Partial output\n\n*[Generation stopped by operator]*',
      isStreaming: false
    });
    assert.equal(abortedEnv.status, 'aborted');
  });

  it('StructuredJsonMessage renders human-readable Markdown and never parses message content as JSON in chat', () => {
    const filePath = path.resolve(process.cwd(), 'src/components/chat/StructuredJsonMessage.tsx');
    assert.equal(fs.existsSync(filePath), true, 'StructuredJsonMessage.tsx must exist');

    const content = fs.readFileSync(filePath, 'utf-8');
    assert.ok(content.includes('structured-user-message'), 'Must render user message testid');
    assert.ok(content.includes('structured-assistant-message'), 'Must render assistant message testid');
    assert.ok(content.includes('buildProgrammaticPromptEnvelope'), 'Must use programmatic prompt envelope');
    assert.ok(content.includes('buildProgrammaticResponseEnvelope'), 'Must use programmatic response envelope');
    assert.ok(!content.includes('JSON.parse('), 'Must never parse chat message text as JSON in UI');
    assert.ok(!content.includes('tryParseJsonObject'), 'Must not attempt JSON parsing on chat content');
    assert.ok(content.includes('MarkdownContent'), 'Must render clean Markdown content');
    assert.ok(content.includes('SourceVerificationDrawer'), 'Must preserve SourceVerificationDrawer');
    assert.ok(content.includes('edit-message-btn'), 'Must support inline message editing');
    assert.ok(content.includes('save-and-resend-btn'), 'Must support Save & Resend on edited user prompts');
    assert.ok(content.includes('save-assistant-edit-btn'), 'Must support saving edited assistant responses');
  });

  it('ChatMessageList delegates message rendering and inline editing to StructuredJsonMessage', () => {
    const listPath = path.resolve(process.cwd(), 'src/components/chat/ChatMessageList.tsx');
    const content = fs.readFileSync(listPath, 'utf-8');
    assert.ok(content.includes('StructuredJsonMessage'), 'ChatMessageList must use StructuredJsonMessage');
    assert.ok(content.includes('onEditMessage'), 'ChatMessageList must wire onEditMessage');
  });

  it('ChatComposer provides a clean prompt input box without raw JSON key chrome', () => {
    const composerPath = path.resolve(process.cwd(), 'src/components/chat/ChatComposer.tsx');
    const content = fs.readFileSync(composerPath, 'utf-8');
    assert.ok(content.includes('structured-json-composer'), 'ChatComposer must include structured-json-composer testid');
    assert.ok(!content.includes('"prompt":'), 'ChatComposer must not display raw JSON key prefix in UI');
  });

  it('renders composer context meter as a non-clickable status readout rather than a modal button', () => {
    const markup = renderToStaticMarkup(
      React.createElement(ChatComposer, {
        session: INITIAL_SESSIONS[0],
        inputPrompt: '',
        onChangePrompt: () => {},
        onSubmitPrompt: () => {},
        isStreaming: false,
        onUpdateSession: () => {},
        allPlugins: AVAILABLE_PLUGINS,
        sessionUsedTokens: 512,
        maxContextTokens: 8192
      })
    );
    assert.ok(
      markup.includes('<div role="status" aria-label="Active context usage" data-testid="composer-context-meter"'),
      'Context meter must be a non-clickable status div'
    );
    assert.equal(markup.includes('Click for breakdown'), false, 'Context meter tooltip must not invite clicking');
  });

  it('renders Web Search tool card as active (not greyed out) when webSearchEnabled is true', () => {
    const enabledMarkup = renderToStaticMarkup(
      React.createElement(ChatToolsTab, {
        enabledPluginIds: [],
        webSearchEnabled: true,
        customPlugins: [],
        onTogglePlugin: () => {}
      })
    );
    assert.ok(
      enabledMarkup.includes('data-testid="tool-card-web_search" data-enabled="true"'),
      'Web search card must be marked enabled when webSearchEnabled is true'
    );
    const cardStart = enabledMarkup.indexOf('data-testid="tool-card-web_search"');
    const cardHeaderSlice = enabledMarkup.slice(cardStart, cardStart + 220);
    assert.equal(cardHeaderSlice.includes('opacity-'), false, 'Enabled web search card must not be dimmed');

    const disabledMarkup = renderToStaticMarkup(
      React.createElement(ChatToolsTab, {
        enabledPluginIds: [],
        webSearchEnabled: false,
        customPlugins: [],
        onTogglePlugin: () => {}
      })
    );
    assert.ok(
      disabledMarkup.includes('data-testid="tool-card-web_search" data-enabled="false"'),
      'Web search card must reflect disabled state when toggled off'
    );
  });

  it('formats structured response sections, tables, callouts, quotes, and inline citations cleanly', () => {
    const sysInstruction = composeSystemInstruction({
      baseSystemPrompt: '',
      memories: [],
      memoryEnabled: false,
      ragHits: [],
      ragEnabled: false,
      toolResults: []
    });
    assert.ok(sysInstruction.includes('Standard Response Format & Visual Layout'));
    assert.ok(sysInstruction.includes('Bottom Line:'));

    const sampleMarkdown = [
      '> **Bottom Line:** Nationwide ground stop issued for safety due to ATC outage [Reuters].',
      '',
      '---',
      '',
      '## **The Official Announcement**',
      '',
      '> *"due to extraordinary circumstances and for reasons of safety"* [NBC News]',
      '',
      '1. **Root Cause**: Communications outage across multiple centers.',
      '   - Equipment or network failure under review',
      '',
      '| Claim | Status | Detail |',
      '| :--- | :---: | :--- |',
      '| Nationwide ground stop | Verified | Confirmed across major outlets [Reuters] |',
      '| Cyberattack confirmed | Unconfirmed | No official statement mentions cyber activity |',
      '',
      '### Sources & Verification',
      '',
      '| Source | Date | Finding |',
      '| --- | --- | --- |',
      '| Reuters | Nov 13, 2026 | ATC communications outage reported |'
    ].join('\n');

    const html = renderToStaticMarkup(React.createElement(MarkdownContent, { content: sampleMarkdown }));
    assert.ok(html.includes('data-testid="markdown-summary-callout"'), 'Renders Bottom Line callout');
    assert.ok(html.includes('data-response-section="analysis"'), 'Groups ## sections into distinct areas');
    assert.ok(html.includes('data-response-section="sources"'), 'Renders dedicated Sources & Verification ledger');
    assert.ok(html.includes('data-testid="markdown-structured-table"'), 'Renders structured pipe tables');
    assert.ok(html.includes('<blockquote'), 'Renders editorial blockquote');
    assert.ok(html.includes('<em'), 'Renders single-asterisk italics');
    assert.equal(html.includes('<p>---</p>'), false, 'Horizontal rules must not leak as literal --- paragraphs');
  });

  it('deduplicates repeated File Repo scans/uploads, tunes 8GB VRAM limits with layman tooltips, removes tool verifiers/duplicate selectors, and consolidates File Repo settings', () => {
    const f1 = createVaultFileEntry({ fileName: 'spec.md', collection: 'Docs', content: 'v1', pinnedInChat: true });
    const f2 = createVaultFileEntry({ fileName: 'spec.md', collection: 'Docs', content: 'v2', pinnedInChat: false });
    const f3 = createVaultFileEntry({ fileName: 'notes.txt', collection: 'Docs', content: 'hello' });
    const firstPass = orchestrator.knowledgeOrchestrator.addVaultFiles([], [f1, f3]);
    assert.equal(firstPass.length, 2);
    const secondPass = orchestrator.knowledgeOrchestrator.addVaultFiles(firstPass, [f2, f3]);
    assert.equal(secondPass.length, 2, 'Rescanning same folder must update in place without adding duplicates');
    const updatedSpec = secondPass.find((f) => f.fileName === 'spec.md')!;
    assert.equal(updatedSpec.id, f1.id, 'Existing file ID preserved on rescan');
    assert.equal(updatedSpec.pinnedInChat, true, 'Existing pin state preserved on rescan');
    assert.equal(updatedSpec.content, 'v2', 'Updated content applied on rescan');

    assert.equal(GENERATION_DEFAULTS.maxThinkingBudget, 8192);
    assert.equal(GENERATION_DEFAULTS.maxMaxTokens, 8192);
    assert.equal(GENERATION_DEFAULTS.thinkingBudget, 1024);
    assert.equal(GENERATION_DEFAULTS.maxTokens, 2048);

    const toolsViewHtml = renderToStaticMarkup(
      React.createElement(PluginsAndGatewayView, {
        enabledPluginIds: [],
        webSearchEnabled: true,
        customPlugins: [],
        onTogglePlugin: () => {}
      })
    );
    assert.equal(toolsViewHtml.includes('Web Tool Tester'), false, 'Web Tool Tester must be removed');
    assert.equal(toolsViewHtml.includes('Direct Tool Verifier'), false, 'Direct Tool Verifier must be removed');
    assert.equal(toolsViewHtml.includes('Run in Verifier'), false, 'Run in Verifier buttons must be removed');

    const defaultsHtml = renderToStaticMarkup(
      React.createElement(GlobalGenerationDefaultsSection, {
        settings: {
          activeModelId: 'Qwen3.5-4B-Q4_K_M',
          temperature: 0.7,
          topP: 0.9,
          maxOutputTokens: 2048,
          systemInstruction: '',
          enableThinking: true,
          thinkingBudget: 2048
        },
        setSettings: () => {}
      })
    );
    assert.ok(defaultsHtml.includes('Global Generation Defaults'));
    assert.ok(defaultsHtml.includes('aria-label="Info for Temperature"'));
    assert.ok(defaultsHtml.includes('aria-label="Info for Top P"'));
    assert.ok(defaultsHtml.includes('aria-label="Info for Repeat Penalty"'));

    const modelSelectorHtml = renderToStaticMarkup(
      React.createElement(GgufAndHardwareSection, {
        settings: {
          activeModelId: 'Qwen3.5-4B-Q4_K_M',
          temperature: 0.7,
          topP: 0.9,
          systemInstruction: '',
          enableThinking: true,
          thinkingBudget: 2048
        },
        setSettings: () => {},
        discoveredGgufs: [{ id: 'Qwen3.5-4B-Q4_K_M', name: 'Qwen3.5-4B-Q4_K_M', quantization: 'Q4_K_M', sizeBytes: 2_800_000_000 }],
        scanMessage: null,
        actionLoading: null,
        onScanDirectory: () => {},
        onContextLengthChange: () => {}
      })
    );
    assert.ok(modelSelectorHtml.includes('Active Chat Model'));
    assert.equal(modelSelectorHtml.includes('Set active'), false, 'Duplicate model pills must be removed');

    const ragSettingsHtml = renderToStaticMarkup(
      React.createElement(RagContextSettings, {
        ragConfig: { chunkSize: 420, chunkOverlap: 60, topK: 3, minScore: 0.45 },
        onUpdateRagConfig: () => {}
      })
    );
    assert.equal(ragSettingsHtml.includes('File Repo Storage Directory'), false);
    assert.ok(ragSettingsHtml.includes('Embedding Model'), 'Embedding settings remain under Knowledge');

    const modelSettingsPath = path.join(
      process.cwd(), 'src', 'components', 'settings', 'LlamaCppEngineSettings.tsx'
    );
    const modelSettingsSource = fs.readFileSync(modelSettingsPath, 'utf8');
    assert.equal(modelSettingsSource.includes('Save Global Settings'), false, 'Model settings save automatically');
    assert.ok(modelSettingsSource.includes('Changes save automatically after a short pause.'));

    const securityHtml = renderToStaticMarkup(
      React.createElement(SecurityAndSnapshotsSettings, {
        storagePath: '.local-data/llmcp-db.json',
        databaseFilePath: '.local-data/llmcp-db.json',
        onSaveDatabasePath: async () => {},
        onExportWorkspaceJson: () => {},
        onImportWorkspaceJson: () => {},
        onRestoreEncryptedWorkspace: async () => {},
        onExportEncryptedWorkspace: async () => ({})
      })
    );
    assert.equal(securityHtml.includes('File Repo Directory'), false, 'File Repo Directory removed from Data & Security');

    const css = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
    assert.ok(css.includes("@theme") && css.includes("--font-sans: 'Tenorite'"), 'Tenorite configured as primary sans font in @theme');
  });
});
