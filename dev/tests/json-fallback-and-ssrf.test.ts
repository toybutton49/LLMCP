import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectRawJsonToolCalls, extractJsonBlocks, extractJsonSpans,
  extractInlineGgufToolCalls, stripRawJsonToolCalls, isTopLevelJsonComplete
} from '../../server/routes/chatToolDetector';
import { safeFetchWithManualRedirects } from '../../server/tools/safeWebFetch';

test('Raw JSON Tool Call Fallback: Granite-style raw JSON tool calls (thinking off)', () => {
  const pureJson = '{"name": "web_search", "arguments": {"query": "weather in NYC"}}';
  const calls = detectRawJsonToolCalls(pureJson);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'web_search');
  assert.deepEqual(JSON.parse(calls[0].arguments), { query: 'weather in NYC' });

  const stringArgs = '{"name": "web_search", "arguments": "{\\"query\\": \\"weather in NYC\\"}"}';
  const stringCalls = detectRawJsonToolCalls(stringArgs);
  assert.equal(stringCalls.length, 1);
  assert.equal(stringCalls[0].name, 'web_search');
  assert.deepEqual(JSON.parse(stringCalls[0].arguments), { query: 'weather in NYC' });

  const paramCall = '{"name": "precision_calculator", "parameters": {"expression": "40 + 2"}}';
  const paramCalls = detectRawJsonToolCalls(paramCall);
  assert.equal(paramCalls.length, 1);
  assert.equal(paramCalls[0].name, 'precision_calculator');
  assert.deepEqual(JSON.parse(paramCalls[0].arguments), { expression: '40 + 2' });

  const argsCall = '{"name": "agent_file_ops", "args": {"operation": "list", "path": "."}}';
  const argsCalls = detectRawJsonToolCalls(argsCall);
  assert.equal(argsCalls.length, 1);
  assert.equal(argsCalls[0].name, 'agent_file_ops');
  assert.deepEqual(JSON.parse(argsCalls[0].arguments), { operation: 'list', path: '.' });

  const toolAlias = '{"tool": "system_context", "arguments": {}}';
  const toolCalls = detectRawJsonToolCalls(toolAlias);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, 'system_context');
  assert.deepEqual(JSON.parse(toolCalls[0].arguments), {});

  const funcWrapped = '{"type": "function", "function": {"name": "web_search", "arguments": {"query": "quantum"}}}';
  const funcCalls = detectRawJsonToolCalls(funcWrapped);
  assert.equal(funcCalls.length, 1);
  assert.equal(funcCalls[0].name, 'web_search');
  assert.deepEqual(JSON.parse(funcCalls[0].arguments), { query: 'quantum' });
});

test('Raw JSON Tool Call Fallback: Markdown fences and conversational prose', () => {
  const fenced = ['```json', '{', '  "name": "web_search",', '  "arguments": {', '    "query": "Granite 4.1 3b Q4_K_M"', '  }', '}', '```'].join('\n');
  const fencedCalls = detectRawJsonToolCalls(fenced);
  assert.equal(fencedCalls.length, 1);
  assert.equal(fencedCalls[0].name, 'web_search');
  assert.deepEqual(JSON.parse(fencedCalls[0].arguments), { query: 'Granite 4.1 3b Q4_K_M' });

  const embedded = 'I will query the system clock.\n{"name": "system_context", "arguments": {}}\nPlease wait for the result.';
  const embeddedCalls = detectRawJsonToolCalls(embedded);
  assert.equal(embeddedCalls.length, 1);
  assert.equal(embeddedCalls[0].name, 'system_context');
  assert.deepEqual(JSON.parse(embeddedCalls[0].arguments), {});

  const multiSequential = ['{"name": "system_context", "arguments": {}}', '{"name": "web_search", "arguments": {"query": "live updates"}}'].join('\n');
  const multiCalls = detectRawJsonToolCalls(multiSequential);
  assert.equal(multiCalls.length, 2);
  assert.equal(multiCalls[0].name, 'system_context');
  assert.equal(multiCalls[1].name, 'web_search');
  assert.deepEqual(JSON.parse(multiCalls[1].arguments), { query: 'live updates' });
});

test('Raw JSON Tool Call Fallback: Array of calls, XML precedence, and non-tool resilience', () => {
  const arrayPayload = JSON.stringify([
    { name: 'web_search', arguments: { query: 'first' } },
    { name: 'web_search', arguments: { query: 'second' } }
  ]);
  const arrayCalls = detectRawJsonToolCalls(arrayPayload);
  assert.equal(arrayCalls.length, 2);
  assert.equal(arrayCalls[0].name, 'web_search');
  assert.equal(arrayCalls[1].name, 'web_search');

  const xmlBlock = '<tool_call>\n{"name": "web_search", "arguments": {"query": "xml"}}\n</tool_call>';
  assert.equal(detectRawJsonToolCalls(xmlBlock).length, 0, 'Must defer when XML tool_call tag is present');
  const xmlParsed = extractInlineGgufToolCalls(xmlBlock);
  assert.equal(xmlParsed.length, 1);
  assert.equal(xmlParsed[0].name, 'web_search');

  assert.equal(detectRawJsonToolCalls('{"status": 200, "message": "All operations completed successfully."}').length, 0);
  assert.equal(detectRawJsonToolCalls('{"name": "Alexander", "role": "Architect", "city": "Seattle"}').length, 0);
  assert.equal(detectRawJsonToolCalls('').length, 0);
  assert.equal(detectRawJsonToolCalls('   ').length, 0);
  assert.equal(detectRawJsonToolCalls('{malformed json').length, 0);

  const blocks = extractJsonBlocks('prefix {"a": [1, 2], "b": {"c": 3}} suffix [4, 5]');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0], '{"a": [1, 2], "b": {"c": 3}}');
  assert.equal(blocks[1], '[4, 5]');

  const spans = extractJsonSpans('prefix {"x": 1} suffix');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, '{"x": 1}');
  assert.equal(spans[0].start, 7);
  assert.equal(spans[0].end, 15);

  assert.equal(stripRawJsonToolCalls('```json\n[{"name": "web_search", "arguments": {"query": "test"}}]\n```'), '');
  assert.equal(stripRawJsonToolCalls('Searching:\n```json\n{"name": "web_search", "arguments": {}}\n```\nDone.'), 'Searching:\nDone.');

  const allowed = new Set(['web_search']);
  assert.equal(detectRawJsonToolCalls('{"name": "Alice", "arguments": {}}', allowed).length, 0);
  assert.equal(detectRawJsonToolCalls('{"name": "web_search", "arguments": {}}', allowed).length, 1);
  assert.equal(detectRawJsonToolCalls('{"name": "tools.web_search", "arguments": {}}', allowed).length, 1);
  assert.equal(isTopLevelJsonComplete('{"a": 1}'), true);
  assert.equal(isTopLevelJsonComplete('{"a": 1'), false);
});

test('SSRF Guard with Manual Redirect: Blocks loopback and internal redirect targets', async () => {
  const originalFetch = globalThis.fetch;
  const recordedFetchUrls: string[] = [];
  const recordedFetchOptions: RequestInit[] = [];

  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      recordedFetchUrls.push(urlStr);
      if (init) recordedFetchOptions.push(init);

      if (urlStr === 'https://example.com/redirect-to-loopback') {
        return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1:3000/api/local-db/query' } });
      }
      if (urlStr === 'https://example.com/redirect-to-metadata') {
        return new Response(null, { status: 301, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } });
      }
      if (urlStr === 'https://example.com/redirect-to-private-ip') {
        return new Response(null, { status: 302, headers: { Location: 'http://10.0.0.1/admin/console' } });
      }
      if (urlStr === 'https://example.com/redirect-to-javascript') {
        return new Response(null, { status: 302, headers: { Location: 'javascript:alert(1)' } });
      }
      if (urlStr === 'https://example.com/redirect-loop') {
        return new Response(null, { status: 302, headers: { Location: 'https://example.com/redirect-loop' } });
      }
      if (urlStr === 'https://example.com/missing-location') {
        return new Response(null, { status: 302 });
      }
      if (urlStr === 'https://example.com/valid-redirect') {
        return new Response(null, { status: 302, headers: { Location: 'https://example.com/final-target' } });
      }
      if (urlStr === 'https://example.com/relative-redirect') {
        return new Response(null, { status: 301, headers: { Location: '/news/article-42' } });
      }
      if (urlStr === 'https://example.com/redirect-post-to-get') {
        return new Response(null, { status: 302, headers: { Location: 'https://example.com/final-target' } });
      }
      if (urlStr === 'https://example.com/cross-origin-redirect') {
        return new Response(null, { status: 302, headers: { Location: 'https://other-domain.com/landing' } });
      }
      if (urlStr === 'https://example.com/final-target' || urlStr === 'https://example.com/news/article-42' || urlStr === 'https://other-domain.com/landing') {
        return new Response('{"ok": true, "article": "Clean Content"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('Not Found', { status: 404 });
    }) as any;

    // 1. Initial URL loopback rejected prior to fetch
    await assert.rejects(async () => { await safeFetchWithManualRedirects('http://127.0.0.1:3000/api/settings'); }, (err: Error) => err.message.includes('SSRF') || err.message.includes('loopback'));
    assert.equal(recordedFetchUrls.length, 0);

    // 2. 302 redirect to 127.0.0.1 blocked before dispatch
    await assert.rejects(async () => { await safeFetchWithManualRedirects('https://example.com/redirect-to-loopback'); }, (err: Error) => err.message.includes('SSRF') || err.message.includes('127.0.0.1'));
    assert.deepEqual(recordedFetchUrls, ['https://example.com/redirect-to-loopback']);
    recordedFetchUrls.length = 0;

    // 3. 301 redirect to cloud metadata service blocked
    await assert.rejects(async () => { await safeFetchWithManualRedirects('https://example.com/redirect-to-metadata'); }, (err: Error) => err.message.includes('SSRF') || err.message.includes('169.254.169.254'));
    assert.deepEqual(recordedFetchUrls, ['https://example.com/redirect-to-metadata']);
    recordedFetchUrls.length = 0;

    // 4. 302 redirect to RFC1918 private IP blocked
    await assert.rejects(async () => { await safeFetchWithManualRedirects('https://example.com/redirect-to-private-ip'); }, (err: Error) => err.message.includes('SSRF') || err.message.includes('10.0.0.1'));
    assert.deepEqual(recordedFetchUrls, ['https://example.com/redirect-to-private-ip']);
    recordedFetchUrls.length = 0;

    // 5. 302 redirect to non-HTTP protocol blocked
    await assert.rejects(async () => { await safeFetchWithManualRedirects('https://example.com/redirect-to-javascript'); }, (err: Error) => err.message.includes('non-HTTP') || err.message.includes('javascript'));
    assert.deepEqual(recordedFetchUrls, ['https://example.com/redirect-to-javascript']);
    recordedFetchUrls.length = 0;

    // 6. Redirect loop hits limit
    await assert.rejects(async () => { await safeFetchWithManualRedirects('https://example.com/redirect-loop', {}, 3); }, (err: Error) => err.message.includes('maximum redirect limit'));
    recordedFetchUrls.length = 0;

    // 7. Missing Location header fails safely
    await assert.rejects(async () => { await safeFetchWithManualRedirects('https://example.com/missing-location'); }, (err: Error) => err.message.includes('Location header'));
    recordedFetchUrls.length = 0;

    // 8. Public redirect succeeds
    const validResult = await safeFetchWithManualRedirects('https://example.com/valid-redirect');
    assert.equal(validResult.response.status, 200);
    assert.equal(validResult.finalUrl, 'https://example.com/final-target');
    assert.deepEqual(recordedFetchUrls, ['https://example.com/valid-redirect', 'https://example.com/final-target']);
    recordedFetchUrls.length = 0;

    // 9. Relative redirect succeeds
    const relativeResult = await safeFetchWithManualRedirects('https://example.com/relative-redirect');
    assert.equal(relativeResult.response.status, 200);
    assert.equal(relativeResult.finalUrl, 'https://example.com/news/article-42');
    assert.deepEqual(recordedFetchUrls, ['https://example.com/relative-redirect', 'https://example.com/news/article-42']);
    recordedFetchUrls.length = 0;
    recordedFetchOptions.length = 0;

    // 10. POST redirect transitions to GET and strips body
    const postResult = await safeFetchWithManualRedirects('https://example.com/redirect-post-to-get', { method: 'POST', body: 'secret-payload' });
    assert.equal(postResult.response.status, 200);
    assert.equal(recordedFetchOptions[0].method, 'POST');
    assert.equal(recordedFetchOptions[1].method, 'GET');
    assert.equal(recordedFetchOptions[1].body, undefined);
    recordedFetchUrls.length = 0;
    recordedFetchOptions.length = 0;

    // 11. Cross-origin redirect strips Authorization header
    const authResult = await safeFetchWithManualRedirects('https://example.com/cross-origin-redirect', { headers: { Authorization: 'Bearer token123' } });
    assert.equal(authResult.response.status, 200);
    assert.equal((recordedFetchOptions[1].headers as any).Authorization, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chatStreamingEngine: streamOpenAiCompletion detects raw JSON tool calls with thinking off', async () => {
  const { streamOpenAiCompletion } = await import('../../server/routes/chatStreamingEngine');
  const originalFetch = globalThis.fetch;

  try {
    const makeStream = (text: string) => {
      const sseFrames = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
      const enc = new TextEncoder();
      return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(sseFrames)); c.close(); } }), {
        status: 200, headers: { 'Content-Type': 'text/event-stream' }
      });
    };

    // 1. Streaming SSE where delta.content emits raw JSON (strictly suppresses chunks)
    globalThis.fetch = (async () => makeStream('{"name": "web_search", "arguments": {"query": "deep learning"}}')) as any;
    let streamedChunks = '';
    const result = await streamOpenAiCompletion({
      endpointUrl: 'http://127.0.0.1:8080/v1/chat/completions',
      modelName: 'granite-4.1-3b-Q4_K_M',
      messages: [{ role: 'user', content: 'Search for deep learning' }],
      allowTools: true,
      openAiTools: [{ type: 'function', function: { name: 'web_search' } }],
      temperature: 0.2, topP: 0.95, maxTokens: 512, thinkingEnabled: false, reasoningEffort: 'low',
      abortSignal: new AbortController().signal,
      onChunk: (chunk) => { streamedChunks += chunk; }
    });
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'web_search');
    assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), { query: 'deep learning' });
    assert.equal(result.contentText, '');
    assert.equal(streamedChunks, '', 'Raw JSON tool call must NOT leak into streamedChunks');

    // 2. Non-streaming JSON response emitting raw JSON in content
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"name": "system_context", "arguments": {}}' } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    })) as any;
    const nonStreamResult = await streamOpenAiCompletion({
      endpointUrl: 'http://127.0.0.1:8080/v1/chat/completions',
      modelName: 'granite-4.1-3b-Q4_K_M',
      messages: [{ role: 'user', content: 'What time is it?' }],
      allowTools: true,
      openAiTools: [{ type: 'function', function: { name: 'system_context' } }],
      temperature: 0.2, topP: 0.95, maxTokens: 512, thinkingEnabled: false, reasoningEffort: 'low',
      abortSignal: new AbortController().signal,
      onChunk: () => {}
    });
    assert.equal(nonStreamResult.toolCalls.length, 1);
    assert.equal(nonStreamResult.toolCalls[0].name, 'system_context');
    assert.deepEqual(JSON.parse(nonStreamResult.toolCalls[0].arguments), {});

    // 3. Streaming SSE with conversational text preceding tool call
    globalThis.fetch = (async () => makeStream('I will search for the weather.\n{"name": "web_search", "arguments": {"query": "weather"}}')) as any;
    let proseStreamed = '';
    const proseResult = await streamOpenAiCompletion({
      endpointUrl: 'http://127.0.0.1:8080/v1/chat/completions',
      modelName: 'granite-4.1-3b-Q4_K_M',
      messages: [{ role: 'user', content: 'Weather in NYC' }],
      allowTools: true,
      openAiTools: [{ type: 'function', function: { name: 'web_search' } }],
      temperature: 0.2, topP: 0.95, maxTokens: 512, thinkingEnabled: false, reasoningEffort: 'low',
      abortSignal: new AbortController().signal,
      onChunk: (chunk) => { proseStreamed += chunk; }
    });
    assert.equal(proseResult.toolCalls.length, 1);
    assert.equal(proseResult.toolCalls[0].name, 'web_search');
    assert.equal(proseStreamed, 'I will search for the weather.\n');
    assert.equal(proseResult.contentText, 'I will search for the weather.');

    // 4. Streaming SSE with non-tool JSON (must be streamed normally)
    globalThis.fetch = (async () => makeStream('{"status": 200, "message": "done"}')) as any;
    let jsonStreamed = '';
    const jsonResult = await streamOpenAiCompletion({
      endpointUrl: 'http://127.0.0.1:8080/v1/chat/completions',
      modelName: 'granite-4.1-3b-Q4_K_M',
      messages: [{ role: 'user', content: 'Output JSON status' }],
      allowTools: true,
      openAiTools: [{ type: 'function', function: { name: 'web_search' } }],
      temperature: 0.2, topP: 0.95, maxTokens: 512, thinkingEnabled: false, reasoningEffort: 'low',
      abortSignal: new AbortController().signal,
      onChunk: (chunk) => { jsonStreamed += chunk; }
    });
    assert.equal(jsonResult.toolCalls.length, 0);
    assert.equal(jsonStreamed, '{"status": 200, "message": "done"}');
    assert.equal(jsonResult.contentText, '{"status": 200, "message": "done"}');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
