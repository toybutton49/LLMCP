import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import sharp from 'sharp';
import { renderOcrPages } from '../../server/routes/ocrPages';
import { findGlmOcrModel, readImageWithGlmOcr, readPagesWithGlmOcr, sendGlmOcrRequest } from '../../server/routes/glmOcr';

function makePdf(pageCount: number): Buffer {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pageCount} /Kids [${Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] >>`
  ];
  for (let i = 0; i < pageCount; i++) {
    const stream = `BT /F1 24 Tf 30 100 Td (Page ${i + 1}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('PDF pages and supported images are rendered for one GLM-OCR server in order', async (t) => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), 'glm-pages-test-'));
  t.after(() => fs.rm(dir, { recursive: true }));
  const pdf = path.join(dir, 'pages.pdf');
  await fs.writeFile(pdf, makePdf(2));
  let started = 0;
  let stopped = 0;
  let requests = 0;
  const start = async () => {
    started++;
    return { baseUrl: 'http://127.0.0.1:1234', apiKey: 'key', stop: async () => { stopped++; } };
  };
  const send = async (_server: object, payload: object) => {
    const request = payload as { messages: Array<{ content: Array<{ text?: string; image_url?: { url: string } }> }> };
    assert.ok(request.messages[0].content[0].text?.includes('Transcribe all visible text in reading order'));
    assert.ok(request.messages[0].content[0].text?.includes('currency amount, and date'));
    assert.ok(request.messages[0].content[1].image_url?.url.startsWith('data:image/png;base64,'));
    return { choices: [{ message: { content: `Page ${++requests}` } }] };
  };
  assert.equal(await readPagesWithGlmOcr(renderOcrPages(pdf), { model: 'model', projector: 'projector' }, start, send),
    'Page 1\n\nPage 2');
  assert.equal(started, 1);
  assert.equal(stopped, 1);
  assert.equal(requests, 2);

  const webp = path.join(dir, 'page.webp');
  await sharp({ create: { width: 10, height: 10, channels: 3, background: '#ffffff' } }).webp().toFile(webp);
  const pages = [];
  for await (const page of renderOcrPages(webp)) pages.push(page);
  assert.equal(pages.length, 1);
  assert.equal((await sharp(pages[0].bytes).metadata()).format, 'png');

  const tiff = path.join(dir, 'pages.tiff');
  const pixels = Buffer.alloc(10 * 20 * 3, 255);
  pixels.fill(0, 0, 10 * 10 * 3);
  await sharp(pixels, { raw: { width: 10, height: 20, channels: 3, pageHeight: 10 } }).tiff().toFile(tiff);
  const rendered = [];
  for await (const item of renderOcrPages(tiff)) {
    rendered.push((await sharp(item.bytes).raw().toBuffer())[0]);
  }
  assert.deepEqual(rendered, [0, 255]);

  const tooMany = path.join(dir, 'too-many.pdf');
  await fs.writeFile(tooMany, makePdf(21));
  await assert.rejects(readPagesWithGlmOcr(renderOcrPages(tooMany), { model: 'model', projector: 'projector' }, start, send),
    (error: Error) => error.message.includes('20 pages'));
  assert.equal(stopped, 2);

  let page = 0;
  await assert.rejects(readPagesWithGlmOcr(renderOcrPages(pdf), { model: 'model', projector: 'projector' }, start,
    async () => {
      if (++page === 2) throw new Error('page failed');
      return { choices: [{ message: { content: 'first page' } }] };
    }), (error: Error) => error.message.includes('page failed'));
  assert.equal(stopped, 3);
});

test('GLM-OCR sends local image data to its local server and always stops it', async (t) => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), 'glm-test-'));
  t.after(() => fs.rm(dir, { recursive: true }));
  const input = path.join(dir, 'page.png');
  await fs.writeFile(input, 'image bytes');
  let stopped = 0;
  const start = async () => ({ baseUrl: 'http://127.0.0.1:1234', apiKey: 'test-key', stop: async () => { stopped++; } });
  const send = async (server: { baseUrl: string; apiKey: string }, body: object) => {
    assert.equal(server.baseUrl, 'http://127.0.0.1:1234');
    assert.equal(server.apiKey, 'test-key');
    const request = body as { messages: Array<{ content: Array<{ image_url?: { url: string } }> }> };
    assert.equal(request.messages[0].content[1].image_url?.url,
      `data:image/png;base64,${Buffer.from('image bytes').toString('base64')}`);
    return { choices: [{ message: { content: 'Invoice 123' } }] };
  };
  assert.equal(await readImageWithGlmOcr(input, { model: 'model', projector: 'projector' }, start, send), 'Invoice 123');
  assert.equal(stopped, 1);
  await assert.rejects(readImageWithGlmOcr(input, { model: 'model', projector: 'projector' }, start,
    async () => { throw new Error('HTTP 503'); }),
    (error: Error) => error.message.includes('HTTP 503'));
  assert.equal(stopped, 2);
  await assert.rejects(readImageWithGlmOcr(input, { model: 'model', projector: 'projector' }, start, async () => ({
    choices: [{ finish_reason: 'length', message: { content: 'partial' } }]
  })),
    (error: Error) => error.message.includes('token limit'));
  assert.equal(stopped, 3);
  await assert.rejects(sendGlmOcrRequest({ baseUrl: 'http://example.com:1234', apiKey: 'key', stop: async () => {} }, {}),
    (error: Error) => error.message.includes('Invalid local OCR server address'));
});

test('GLM-OCR discovery fails explicitly when the required model is missing', async () => {
  await assert.rejects(
    findGlmOcrModel([]),
    (error: Error) =>
      error.message.includes('GLM-OCR model not found') &&
      error.message.includes('mmproj')
  );
});

test('local OCR requests authenticate, parse responses, and surface server failures', async (t) => {
  let status = 200;
  let responseBody = '{"choices":[{"message":{"content":"readable text"}}]}';
  let sentBody = '';
  t.mock.method(http, 'request', (options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    assert.equal(options.hostname, '127.0.0.1');
    assert.equal(options.port, 1234);
    assert.equal(options.path, '/v1/chat/completions');
    assert.ok(options.headers && 'Authorization' in options.headers);
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const request = Object.assign(new EventEmitter(), {
      end(body: string) {
        sentBody = body;
        const response = new http.IncomingMessage(new Socket());
        response.statusCode = status;
        callback(response);
        response.emit('data', responseBody);
        response.emit('end');
      }
    });
    return request as http.ClientRequest;
  });
  const server = { baseUrl: 'http://127.0.0.1:1234', apiKey: 'test-key', stop: async () => {} };
  assert.deepEqual(await sendGlmOcrRequest(server, { test: 'value' }), {
    choices: [{ message: { content: 'readable text' } }]
  });
  assert.deepEqual(JSON.parse(sentBody), { test: 'value' });
  status = 502;
  responseBody = 'Sandbox proxy could not reach the destination.';
  await assert.rejects(sendGlmOcrRequest(server, {}), (error: Error) =>
    error.message.includes('HTTP 502') && error.message.includes('proxy could not reach'));
  status = 200;
  responseBody = 'not JSON';
  await assert.rejects(sendGlmOcrRequest(server, {}), (error: Error) => error.message.includes('invalid JSON'));
});
