import assert from 'node:assert/strict';
import test from 'node:test';
import { streamOpenAiCompletion } from '../../server/routes/chatStreamingEngine';

test('inference rejects incomplete, malformed and error streams without silently retrying', async (t) => {
  let response = new Response();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return response; });
  const run = () => streamOpenAiCompletion({
    endpointUrl: 'http://127.0.0.1:8080/v1/chat/completions',
    modelName: 'test', messages: [{ role: 'user', content: 'hello' }],
    allowTools: false, openAiTools: [], temperature: 0.3, topP: 0.9, maxTokens: 50,
    thinkingEnabled: false, reasoningEffort: 'medium', abortSignal: new AbortController().signal,
    onChunk: () => {}
  });
  const partial = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
  for (const [body, expected] of [
    [partial, 'before the completion marker'],
    [partial + 'data: {bad json}\n\n', 'malformed streaming frame'],
    [partial + 'data: {"error":{"message":"out of memory"}}\n\n', 'out of memory'],
    [partial + 'data: {"choices":[{"finish_reason":"content_filter"}]}\n\ndata: [DONE]\n\n', 'content_filter'],
    [partial + 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n', 'token limit']
  ]) {
    response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    await assert.rejects(run(), (error: Error) => error.message.includes(expected));
  }
  response = new Response(partial + 'data: [DONE]', { headers: { 'content-type': 'text/event-stream' } });
  assert.equal((await run()).contentText, 'partial');
  const encoder = new TextEncoder();
  response = new Response(new ReadableStream({
    start(controller) {
      for (const chunk of [partial, 'data: [DO', 'NE]\n\n']) controller.enqueue(encoder.encode(chunk));
    }
  }), { headers: { 'content-type': 'text/event-stream' } });
  assert.equal((await run()).contentText, 'partial');
  response = Response.json({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] });
  await assert.rejects(run(), (error: Error) => error.message.includes('token limit'));
  response = new Response('bad request', { status: 400 });
  const previousRequests = requests;
  await assert.rejects(run(), (error: Error) => error.message.includes('HTTP 400'));
  assert.equal(requests, previousRequests + 1);
});
