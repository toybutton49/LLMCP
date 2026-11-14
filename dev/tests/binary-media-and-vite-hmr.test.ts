import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import {
  isBinaryOrImageExtension,
  isBinaryMimeType,
  isBinaryContent,
  isBinaryOrImageFile
} from '../../src/utils/rag/binaryGuards';
import {
  createVaultFileEntry,
  mutateVaultFile,
  searchVaultFiles
} from '../../src/utils/rag/vaultFileEngine';
import { buildVectorIndex } from '../../src/utils/rag/vectorEngine';
import { composeSystemInstruction } from '../../src/utils/rag/promptAndMutations';
import { KnowledgeOrchestrator } from '../../src/orchestrators/knowledgeOrchestrator';
import { agentFileOpsPlugin } from '../../src/tools/plugins/fileAndAgentPlugins';
import { executeAgenticTaskPipeline } from '../../src/utils/agentTools';
import { analyzeMessageFactGrounding } from '../../src/utils/sourceVerification';
import type { WorkspaceMessage } from '../../src/data/seedData';

const ROOT_DIR = process.cwd();

test('Binary Media Guard: isBinaryOrImageFile identifies image and binary extensions and mime types', () => {
  assert.equal(isBinaryOrImageFile('Screenshot 2026-11-10 193954.png'), true);
  assert.equal(isBinaryOrImageFile('diagram.jpg'), true);
  assert.equal(isBinaryOrImageFile('photo.jpeg'), true);
  assert.equal(isBinaryOrImageFile('animation.gif'), true);
  assert.equal(isBinaryOrImageFile('graphic.webp'), true);
  assert.equal(isBinaryOrImageFile('icon.ico'), true);
  assert.equal(isBinaryOrImageFile('manual.pdf'), true);
  assert.equal(isBinaryOrImageFile('bundle.zip'), true);
  assert.equal(isBinaryOrImageFile('archive.tar.gz'), true);
  assert.equal(isBinaryOrImageFile('native.wasm'), true);
  assert.equal(isBinaryOrImageFile('model.gguf'), true);

  assert.equal(isBinaryOrImageFile('notes.txt'), false);
  assert.equal(isBinaryOrImageFile('README.md'), false);
  assert.equal(isBinaryOrImageFile('schema.json'), false);
  assert.equal(isBinaryOrImageFile('localDatabase.ts'), false);
  assert.equal(isBinaryOrImageFile('App.tsx'), false);
  assert.equal(isBinaryOrImageFile('pipeline.py'), false);
  assert.equal(isBinaryOrImageFile('data.csv'), false);

  assert.equal(isBinaryMimeType('image/png'), true);
  assert.equal(isBinaryMimeType('image/jpeg'), true);
  assert.equal(isBinaryMimeType('application/pdf'), true);
  assert.equal(isBinaryMimeType('application/octet-stream'), true);
  assert.equal(isBinaryMimeType('text/plain'), false);
  assert.equal(isBinaryMimeType('application/json'), false);
});

test('Binary Media Guard: isBinaryContent detects garbled binary byte sequences and null characters', () => {
  const binaryGarbage = '\u0013=wG\uFFFD\uFFFD\u000BM\uFFFDy\u0014:i\u000b\u0007\nT\u0000\u000brJ\u0016';
  assert.equal(isBinaryContent(binaryGarbage), true);

  const cleanText = '# Application Architecture\nThis is a standard markdown document without binary data.\n\nKey features: zero regex and local first.';
  assert.equal(isBinaryContent(cleanText), false);

  const codeSample = 'function calculateTotal(items: number[]): number {\n  return items.reduce((sum, n) => sum + n, 0);\n}\n';
  assert.equal(isBinaryContent(codeSample), false);

  const nullByteString = 'prefix\u0000suffix';
  assert.equal(isBinaryContent(nullByteString), true);
});

test('Binary Media Guard: createVaultFileEntry replaces binary content with clean media descriptor', () => {
  const binaryPngBytes = '\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR\u0000\u0000\u0001\u0000\u0000\u0001\u0000\b\u0006\u0000\u0000\u0000';
  const entry = createVaultFileEntry({
    fileName: 'Screenshot 2026-11-10 193954.png',
    mimeType: 'image/png',
    content: binaryPngBytes,
    collection: 'Attached',
    pinnedInChat: true
  });

  assert.equal(entry.isBinary, true);
  assert.equal(entry.tokenEstimate, 0);
  assert.ok(!entry.content.includes('\u0089PNG'), 'Raw binary PNG bytes must not be preserved in content');
  assert.ok(entry.content.includes('[Binary Media: Screenshot 2026-11-10 193954.png'), 'Must contain clean media descriptor');

  const mutated = mutateVaultFile([entry], entry.id, {
    content: '\u0000\u0013\u0007raw_bytes'
  });
  assert.equal(mutated[0].isBinary, true);
  assert.ok(!mutated[0].content.includes('\u0000'), 'Mutated binary file must not contain null bytes');
});

test('Binary Media Guard: searchVaultFiles skips binary and image files, preventing garbled excerpts', () => {
  const textFile = createVaultFileEntry({
    fileName: 'system_design.md',
    content: 'The LLMCP system runs on a local-first architecture.\nIt uses built-in llama.cpp core and scans models.\nContext is dynamically bounded.',
    collection: 'Architecture',
    pinnedInChat: true
  });

  const imageFile = createVaultFileEntry({
    fileName: 'Screenshot 2026-11-10 193954.png',
    mimeType: 'image/png',
    content: '\u0013=wG\uFFFD\uFFFD\u000BM\uFFFDy\u0014:i\u000b\u0007\nT\u0000\u000brJ\u0016>0\b5|Z`\u0006\u0019',
    collection: 'Attached',
    pinnedInChat: true
  });

  const hits = searchVaultFiles('what do the picture errors mean', [textFile, imageFile], 5, 'all');

  assert.ok(hits.length > 0, 'Text files can produce matches');
  for (const hit of hits) {
    assert.notEqual(hit.fileName, 'Screenshot 2026-11-10 193954.png', 'Binary image file must never be returned in vault excerpt hits');
    assert.ok(!isBinaryContent(hit.excerpt), 'Hit excerpt must never contain binary control characters');
  }

  const imageOnlyHits = searchVaultFiles('screenshot picture error', [imageFile], 5, 'all');
  assert.equal(imageOnlyHits.length, 0, 'Searching only image files must return empty hits');
});

test('Binary Media Guard: composeSystemInstruction filters any binary citations from prompt context', () => {
  const cleanHit = {
    chunkId: 'doc_1_c0',
    fileId: 'doc_1',
    fileName: 'guidelines.txt',
    collection: 'Docs',
    lineRange: 'L1-L10',
    excerpt: 'All operations run in local memory without external telemetry.',
    similarityScore: 0.95,
    sha256Preview: 'deadbeef1234'
  };

  const corruptBinaryHit = {
    chunkId: 'vfile_bad_L1-L14',
    fileId: 'vfile_bad',
    fileName: 'Screenshot 2026-11-10 193954.png',
    collection: 'Attached',
    lineRange: 'L51-L64',
    excerpt: '\u0013=wG\uFFFD\uFFFD\u000BM\uFFFDy\u0014:i\u000b\u0007\nT\u0000\u000brJ',
    similarityScore: 0.88,
    sha256Preview: '4b74908f1e84'
  };

  const prompt = composeSystemInstruction({
    baseSystemPrompt: 'You are an AI assistant.',
    memories: [],
    memoryEnabled: false,
    ragHits: [],
    ragEnabled: false,
    vaultHits: [cleanHit, corruptBinaryHit],
    vaultEnabled: true,
    toolResults: []
  });

  assert.ok(prompt.includes('guidelines.txt'), 'Prompt must include clean text file citations');
  assert.ok(!prompt.includes('Screenshot 2026-11-10 193954.png'), 'Prompt must never include corrupt binary excerpt citations');
  assert.ok(!prompt.includes('\u0013=wG'), 'Prompt must not contain binary garbage characters');
});

test('Binary Media Guard: vector indexing and KnowledgeOrchestrator skip binary and image files', () => {
  const orchestrator = new KnowledgeOrchestrator();

  const textFile = createVaultFileEntry({
    fileName: 'config.json',
    content: '{\n  "version": 1,\n  "mode": "standalone"\n}',
    collection: 'Config'
  });

  const imageFile = createVaultFileEntry({
    fileName: 'diagram.png',
    mimeType: 'image/png',
    content: '[Binary Media: diagram.png]',
    collection: 'Assets'
  });

  const indexRes = orchestrator.index({
    documents: [
      { id: 'd1', title: 'guide.md', category: 'Guide', content: 'Comprehensive guide to local workflows.' }
    ],
    files: [textFile, imageFile],
    chunkSize: 420,
    chunkOverlap: 60,
    similarityMetric: 'cosine'
  });

  assert.ok(indexRes.result.totalChunks > 0);

  const vectorChunks = buildVectorIndex([
    { id: 'd1', title: 'architecture.png', category: 'Diagram', content: '\u0089PNG\u0000\u0000\u0000' },
    { id: 'd2', title: 'overview.md', category: 'Docs', content: 'Text documentation explaining component boundaries.' }
  ]);

  assert.equal(vectorChunks.length, 1, 'Only text documents must be indexed into vector chunks');
  assert.equal(vectorChunks[0].docTitle, 'overview.md');
});

test('Binary Media Guard: agent_file_ops tool reports binary media files cleanly without dumping bytes', () => {
  const binaryFile = createVaultFileEntry({
    fileName: 'Screenshot 2026-11-10 193954.png',
    mimeType: 'image/png',
    content: '[Binary Media: Screenshot 2026-11-10 193954.png (PNG · 43688 bytes) - Stored in File Repo]',
    collection: 'Attached'
  });

  const res = agentFileOpsPlugin.invokeDirect(
    { action: 'read', fileName: 'Screenshot 2026-11-10 193954.png' },
    { vaultFiles: [binaryFile] } as any
  );

  assert.ok(res.outputSummary.includes('Binary media file'));
  assert.ok(res.outputSummary.includes('cannot be displayed as plain text'));
  assert.ok(!res.outputSummary.includes('\u0000'));
});

test('Client memory barrel excludes the server-only vector database', () => {
  const barrel = fs.readFileSync(path.join(ROOT_DIR, 'src', 'utils', 'memory', 'index.ts'), 'utf8');
  assert.ok(!barrel.includes("export * from './octoVectorDatabase'"));
});

test('agent_file_ops is read-only: it exposes no write, edit, create or move capability', () => {
  const file = createVaultFileEntry({ fileName: 'notes.txt', content: 'original', collection: 'Docs' });
  const context = { providerId: 'llamacpp', vectorIndex: [], vaultFiles: [file] };
  assert.equal(agentFileOpsPlugin.schema.name, 'agent_file_ops');
  for (const alias of ['write_file', 'edit_file', 'create_directory', 'move_file']) {
    assert.ok(!agentFileOpsPlugin.aliases?.includes(alias), `${alias} must not be an alias`);
  }
  const result = agentFileOpsPlugin.invokeDirect(
    { action: 'patch', fileName: 'notes.txt', target: 'original', replacement: 'changed' },
    context
  );
  assert.ok(!result.outputSummary.includes('changed'));
  assert.equal(file.content, 'original');
});

test('React State Warning Prevention: LlamaCppEngineSettings does not call parent state setters during render updater', () => {
  const settingsFilePath = path.join(ROOT_DIR, 'src', 'components', 'settings', 'LlamaCppEngineSettings.tsx');
  const content = fs.readFileSync(settingsFilePath, 'utf-8');

  // Verify that setLocalSettings pure updater does not execute props.onUpdateModelTtl
  assert.equal(
    content.includes('setLocalSettings((prev) => {\n      const next'),
    false,
    'setLocalSettings must not contain multi-step callback with parent side effects'
  );
  assert.ok(
    content.includes('setLocalSettings(updater);'),
    'updateSettings must pass updater directly to setLocalSettings'
  );
});

test('Binary Media Guard: agentTools and sourceVerification filter out image and binary files', () => {
  const binaryFile = createVaultFileEntry({
    fileName: 'Screenshot 2026-11-10 193954.png',
    mimeType: 'image/png',
    content: '[Binary Media: Screenshot 2026-11-10 193954.png (PNG · 43688 bytes)]',
    collection: 'Attached'
  });
  const textFile = createVaultFileEntry({
    fileName: 'main.ts',
    content: 'export function runProcess() {\n  return 42;\n}\n',
    collection: 'Source'
  });

  const agentResult = executeAgenticTaskPipeline({
    objective: 'Audit and discover symbols',
    targetFiles: [binaryFile, textFile],
    enabledToolIds: ['knowledge_file_inspector', 'agent_symbol_navigator']
  });

  assert.ok(agentResult.steps.length > 0);
  for (const sym of agentResult.discoveredSymbols) {
    assert.notEqual(sym.fileName, 'Screenshot 2026-11-10 193954.png');
  }

  const dummyMsg: WorkspaceMessage = {
    id: 'm1',
    sessionId: 's1',
    ownerId: 'u1',
    role: 'assistant',
    content: 'Analyzed files.',
    createdAt: new Date().toISOString(),
    vaultCitations: [
      {
        fileName: 'Screenshot 2026-11-10 193954.png',
        collection: 'Attached',
        lineRange: 'L1-L10',
        excerpt: '\u0013=binary',
        score: 0.9,
        sha256Preview: 'deadbeef'
      },
      {
        fileName: 'notes.txt',
        collection: 'General',
        lineRange: 'L1-L5',
        excerpt: 'Plain text note.',
        score: 0.8,
        sha256Preview: 'feedface'
      }
    ]
  };

  const analysis = analyzeMessageFactGrounding(dummyMsg);
  assert.equal(analysis.sources.length, 1);
  assert.equal(analysis.sources[0].title, 'notes.txt');
});

test('Vite HMR WebSocket Connection: server.ts binds server before Vite and passes ws.server to avoid port 24678', () => {
  const serverPath = path.join(ROOT_DIR, 'server.ts');
  const serverContent = fs.readFileSync(serverPath, 'utf-8');

  assert.ok(
    serverContent.includes('const server = http.createServer(app);'),
    'server.ts must create http.Server before Vite initialization'
  );
  assert.ok(
    serverContent.includes('ws: { server }'),
    'server.ts must attach Vite WebSocket server to the Express http.Server'
  );
  assert.ok(
    serverContent.includes('isHmrDisabled'),
    'server.ts must handle DISABLE_HMR environment flag'
  );
});

test('Vite HMR WebSocket Connection: live WebSocket upgrade binds to main application port', async () => {
  const app = express();
  const server = http.createServer(app);
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      ws: { server }
    },
    appType: 'spa'
  });
  app.use(vite.middlewares);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  assert.ok(port > 0, 'Server must bind to an ephemeral port');

  try {
    const res = await fetch(`http://127.0.0.1:${port}/@vite/client`);
    const clientJs = await res.text();
    assert.equal(clientJs.includes('24678'), false, 'Client code must not contain port 24678');

    const tokenPrefix = 'const wsToken = "';
    const startIdx = clientJs.indexOf(tokenPrefix);
    let wsToken = '';
    if (startIdx !== -1) {
      const endIdx = clientJs.indexOf('"', startIdx + tokenPrefix.length);
      wsToken = clientJs.substring(startIdx + tokenPrefix.length, endIdx);
    }
    assert.ok(wsToken.length > 0, 'Must extract valid WebSocket security token');

    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${wsToken}`, 'vite-hmr');
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.close();
        resolve();
      };
      ws.onerror = (err) => {
        reject(err);
      };
    });
  } finally {
    await vite.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
