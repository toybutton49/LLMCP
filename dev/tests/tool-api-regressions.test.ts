import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express, { type Express } from 'express';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { serverLogger } from '../../server/config/logger';
import { performBuiltInWebGrounding } from '../../server/routes/chatToolEnricher';
import { registerWebAndAgentToolRoutes } from '../../server/tools/mcpAndAgentRoutes';
import { registerWorkspaceRoutes } from '../../server/routes/workspaceRoutes';
import { ensureLocalDb } from '../../server/db/localDatabase';
import { getContextBudgetForUsage } from '../../server/llamacpp/runtimeTelemetry';
import { extractDiamondMemoryCandidate } from '../../src/utils/memory/memoryScanner';
import { StructuredJsonMessage } from '../../src/components/chat/StructuredJsonMessage';
import { analyzeMessageFactGrounding } from '../../src/utils/sourceVerification';

type Handler = (req: { body?: unknown }, res: {
  statusCode: number;
  body?: unknown;
  status(code: number): unknown;
  json(value: unknown): unknown;
}) => unknown;

function createRouteHarness(getLocalDb: () => any = () => {
  throw new Error('Database should not be accessed');
}) {
  const handlers = new Map<string, Handler>();
  const app = {
    get: (path: string, handler: Handler) => handlers.set(`GET ${path}`, handler),
    post: (path: string, handler: Handler) => handlers.set(`POST ${path}`, handler)
  };
  registerWebAndAgentToolRoutes(app as unknown as Express, getLocalDb);
  return async (path: string, body?: unknown, method = 'POST') => {
    const handler = handlers.get(`${method} ${path}`);
    assert.ok(handler, `route registered: ${method} ${path}`);
    const response = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(value: unknown) {
        this.body = value;
        return this;
      }
    };
    await handler({ body }, response);
    return response;
  };
}

test('tool endpoints reject malformed JSON bodies and wrongly typed required fields with 400', async () => {
  const callRoute = createRouteHarness();
  for (const [path, body] of [
    ['/api/tools/web-search', null],
    ['/api/tools/web-fetch', []],
    ['/api/tools/web-context', null],
    ['/api/agent/execute', []],
    ['/api/tools/call', null]
  ] as const) {
    const response = await callRoute(path, body);
    assert.equal(response.statusCode, 400, path);
  }

  for (const [path, body] of [
    ['/api/tools/web-search', { query: 42 }],
    ['/api/tools/web-fetch', { url: 42 }],
    ['/api/tools/web-context', { query: 42 }],
    ['/api/agent/execute', { objective: 42 }],
    ['/api/tools/call', { toolName: 42 }]
  ] as const) {
    const response = await callRoute(path, body);
    assert.equal(response.statusCode, 400, path);
  }
});

test('web-context and agent reject malformed list fields instead of iterating strings', async () => {
  const callRoute = createRouteHarness();
  const webContext = await callRoute('/api/tools/web-context', { query: 'example', urls: 'https://example.com' });
  assert.equal(webContext.statusCode, 400);
  assert.deepEqual(webContext.body, { error: 'urls must be an array of strings.' });

  const agent = await callRoute('/api/agent/execute', { objective: 'inspect', fileIds: [1] });
  assert.equal(agent.statusCode, 400);
  assert.deepEqual(agent.body, { error: 'fileIds must be an array of strings.' });

  const invalidFiles = await callRoute('/api/agent/execute', { objective: 'inspect', vaultFiles: [null] });
  assert.equal(invalidFiles.statusCode, 400);
  assert.deepEqual(invalidFiles.body, { error: 'vaultFiles must be an array of valid file records.' });

  const toolCall = await callRoute('/api/tools/call', { toolName: 'system_context', arguments: [] });
  assert.equal(toolCall.statusCode, 400);
  assert.deepEqual(toolCall.body, { ok: false, error: 'arguments must be a JSON object.' });
});

test('web-fetch rejects negative maxChars and caps oversized response content', async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () => {
    fetchCount++;
    return new Response(JSON.stringify('x'.repeat(60000)), {
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  const callRoute = createRouteHarness();
  for (const maxChars of [-1, null]) {
    const rejected = await callRoute('/api/tools/web-fetch', {
      url: 'https://example.com/',
      maxChars
    });
    assert.equal(rejected.statusCode, 400);
  }
  assert.equal(fetchCount, 0, 'invalid maxChars must not make an upstream request');

  const capped = await callRoute('/api/tools/web-fetch', {
    url: 'https://example.com/',
    maxChars: 100000
  });
  assert.equal(capped.statusCode, 200);
  assert.equal(fetchCount, 1);
  assert.equal((capped.body as { result: { content: string } }).result.content.length, 50000);
});

test('agent honors explicit empty or unmatched file selections', async () => {
  const files = [
    { id: 'one', fileName: 'one.ts', content: 'const one = 1;', fileExtension: 'ts', isBinary: false, mimeType: 'text/plain' },
    { id: 'two', fileName: 'two.ts', content: 'const two = 2;', fileExtension: 'ts', isBinary: false, mimeType: 'text/plain' }
  ];
  const callRoute = createRouteHarness(() => ({ vaultFiles: files }));
  for (const selection of [{ fileIds: ['missing'] }, { fileIds: [] }, { vaultFiles: [] }]) {
    const response = await callRoute('/api/agent/execute', { objective: 'inspect', ...selection });
    assert.equal(response.statusCode, 200);
    const result = (response.body as { result: { steps: Array<{ actionSummary: string }>; proposedPatches: unknown[] } }).result;
    assert.ok(result.steps[0].actionSummary.includes('Searched 0 workspace file(s)'));
    assert.deepEqual(result.proposedPatches, []);
  }
});

test('web endpoints report upstream failures instead of substituting local content or another search', async (t) => {
  const requestedUrls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requestedUrls.push(String(input));
    return new Response('unavailable', { status: 503 });
  });
  const callRoute = createRouteHarness();
  const search = await callRoute('/api/tools/web-search', { query: 'example' });
  assert.equal(search.statusCode, 500);
  assert.ok(String((search.body as { error: string }).error).includes('All web search providers failed'));
  assert.equal(requestedUrls.length, 4);

  requestedUrls.length = 0;
  const context = await callRoute('/api/tools/web-context', {
    query: 'example', urls: ['https://example.com/']
  });
  assert.equal(context.statusCode, 500);
  assert.ok(String((context.body as { error: string }).error).includes('503'));
  assert.deepEqual(requestedUrls, ['https://example.com/']);
});

test('web search permits a successful provider with no results', async (t) => {
  const warnings = t.mock.method(serverLogger, 'warn');
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) =>
    String(input).includes('bing.com/news/')
      ? new Response('<rss><channel></channel></rss>')
      : new Response('unavailable', { status: 503 }));
  const response = await createRouteHarness()('/api/tools/web-search', { query: 'example' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual((response.body as { results: unknown[] }).results, []);
  assert.ok(warnings.mock.calls.some((call) => call.arguments[1] === 'Some web search providers failed.'));
  await assert.rejects(performBuiltInWebGrounding('example'), (error: Error) =>
    error.message.includes('No web passages were available for verification.'));
});

test('web endpoints return provider results and explicitly requested page content', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('bing.com/news/')) {
      return new Response('<rss><channel><item><title>Example finding</title>' +
        '<link>https://example.com/article</link><description>Example finding details</description>' +
        '</item></channel></rss>');
    }
    if (url === 'https://example.com/article') {
      return Response.json({ content: 'Example finding details are available on this page.' });
    }
    return new Response('unavailable', { status: 503 });
  });
  const callRoute = createRouteHarness();
  const search = await callRoute('/api/tools/web-search', { query: 'example finding' });
  assert.equal(search.statusCode, 200);
  const results = (search.body as { results: Array<{ url: string; source: string }> }).results;
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://example.com/article');
  assert.equal(results[0].source, 'live-news');

  const context = await callRoute('/api/tools/web-context', {
    query: 'example finding', urls: ['https://example.com/article']
  });
  assert.equal(context.statusCode, 200);
  const passages = (context.body as { context: { passages: Array<{ url: string }> } }).context.passages;
  assert.ok(passages.some((passage) => passage.url === 'https://example.com/article'));
});

test('workspace and native routes reject non-object bodies, preserve missing embedding selection on GET /api/providers, and scan configured File Repo directory', async (t) => {
  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'route-isolation-'));
  const prevDb = process.env.LOCAL_DB_PATH;
  const prevRepo = process.env.FILE_REPO_DIR;
  const relDb = path.relative(process.cwd(), path.join(sandbox, 'db.json')).split('\\').join('/');
  const relRepo = path.relative(process.cwd(), path.join(sandbox, 'custom-repo')).split('\\').join('/');
  process.env.LOCAL_DB_PATH = relDb;
  process.env.FILE_REPO_DIR = relRepo;
  fs.mkdirSync(path.join(sandbox, 'custom-repo'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'custom-repo', 'isolated-doc.txt'), 'isolated content');

  let db = ensureLocalDb();
  db.ragConfig.embeddingModel = 'missing-nomic-custom.gguf';
  const beforeMtime = fs.statSync(path.join(sandbox, 'db.json')).mtimeMs;

  const app = express();
  app.use(express.json());
  registerWorkspaceRoutes(app, () => db, (next) => { db = next; }, 3000);
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    if (prevDb === undefined) delete process.env.LOCAL_DB_PATH; else process.env.LOCAL_DB_PATH = prevDb;
    if (prevRepo === undefined) delete process.env.FILE_REPO_DIR; else process.env.FILE_REPO_DIR = prevRepo;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;

  await new Promise((r) => setTimeout(r, 25));
  const providersRes = await fetch(`${base}/api/providers`);
  assert.equal(providersRes.status, 200);
  assert.equal(db.ragConfig.embeddingModel, 'missing-nomic-custom.gguf');
  assert.equal(fs.statSync(path.join(sandbox, 'db.json')).mtimeMs, beforeMtime);

  const scanRes = await fetch(`${base}/api/filerepo/scan`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(scanRes.status, 200);
  const scanJson = await scanRes.json() as { scannedCount: number; files: Array<{ fileName: string }> };
  assert.equal(scanJson.scannedCount, 1);
  assert.equal(scanJson.files[0].fileName, 'isolated-doc.txt');

  for (const endpoint of [
    '/api/settings/keys',
    '/api/engine/ttl',
    '/api/local-db/query',
    '/api/memory/probe',
    '/api/native/load',
    '/api/native/model-configs',
    '/api/local-auth/verify'
  ]) {
    const res = await fetch(`${base}${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]'
    });
    assert.equal(res.status, 400, `Expected 400 for array body on ${endpoint}`);
  }
});

test('runtime telemetry, memory scanner, streaming reasoning toggle, and multi-tool web citations handle edge cases cleanly', () => {
  const budget = getContextBudgetForUsage(Number.NaN, 0);
  assert.equal(budget.configuredTokens, 8192);
  assert.equal(budget.effectiveTokens, 8192);

  assert.equal(
    extractDiamondMemoryCandidate('Using my saved File Repo and Memory, state the amount due on invoice 9842.'),
    null
  );
  assert.equal(
    extractDiamondMemoryCandidate('According to my Sapphire Labs invoice #9842 and memory directive, state the project codename and calculate 1250 * 1.08.'),
    null
  );
  assert.ok(extractDiamondMemoryCandidate('Remember that this repo uses strict TypeScript without regular expressions.'));

  const noThinkStream = renderToStaticMarkup(React.createElement(StructuredJsonMessage, {
    message: { id: 'm1', role: 'assistant', content: '' },
    isStreaming: true,
    thinkingEnabled: false,
    onCopy: () => {},
    copiedId: null
  }));
  assert.equal(noThinkStream.includes('Octopus reasoning'), false);

  const grounding = analyzeMessageFactGrounding({
    id: 'm2',
    role: 'assistant',
    content: 'Verified.',
    toolInvocations: [
      { pluginId: 'web_search', pluginName: 'Web Search', inputSummary: 'first', outputSummary: '[News] First\nhttps://example.com/1', durationMs: 10 },
      { pluginId: 'web_fetch', pluginName: 'Web Fetch', inputSummary: 'https://example.com/2', outputSummary: '   ', durationMs: 10 }
    ]
  });
  assert.equal(grounding.sources.length, 2);
});

