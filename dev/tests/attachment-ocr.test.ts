import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { processAttachmentOcr, registerAttachmentOcrRoute } from '../../server/routes/attachmentOcr';
import { uploadAttachment } from '../../src/utils/attachmentUpload';
import { OCR_MAX_UPLOAD_BYTES } from '../../src/utils/ocrLimits';
import { searchVaultFiles } from '../../src/utils/rag/vaultFileEngine';

function availableRuntimeStatus() {
  return {
    sampledAt: new Date().toISOString(),
    router: { state: 'ready', baseUrl: 'http://127.0.0.1:8080', managed: true },
    gpu: { available: true, pressure: 'normal', thresholdPercent: 90, devices: [] },
    offload: {
      state: 'idle', thresholdPercent: 90, staleRecords: 0, indexedRecords: 0,
      lastUpdatedAt: new Date().toISOString()
    },
    context: null,
    model: {
      id: 'chat-model', loadedId: null, configuredContextTokens: 8192,
      effectiveContextTokens: 8192, pressureAdjusted: false
    },
    models: {
      chat: { selected: 'chat-model', available: true },
      embedding: { selected: 'nomic.gguf', available: true },
      ocr: { available: true, model: 'GLM-OCR.gguf', projector: 'mmproj-GLM-OCR.gguf' }
    }
  };
}

test('OCR attachments save the original without overwriting and report failures', async (t) => {
  await fs.mkdir(path.join(process.cwd(), '.test-data'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.test-data', 'ocr-test-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  let ocrRuns = 0;
  const runOcr = async (input: string) => {
    ocrRuns += 1;
    const data = await fs.readFile(input, 'utf8');
    if (data === 'bad') throw new Error('test OCR failure');
    return 'A searchable invoice number 12345';
  };
  const post = (body: { fileName?: unknown; base64?: unknown }) => processAttachmentOcr(body, dir, runOcr);
  const bytes = Buffer.from('fake image');
  const response = await post({ fileName: 'invoice.png', base64: bytes.toString('base64') });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { text: 'A searchable invoice number 12345', fileName: 'invoice.png' });
  assert.deepEqual(await fs.readFile(path.join(dir, 'invoice.png')), bytes);
  const duplicate = await post({ fileName: 'invoice.png', base64: Buffer.from('other').toString('base64') });
  assert.equal(duplicate.status, 409);
  assert.equal(ocrRuns, 1, 'duplicate uploads are rejected before OCR runs');
  assert.deepEqual(await fs.readFile(path.join(dir, 'invoice.png')), bytes);
  assert.equal((await post({ fileName: '..\\outside.pdf', base64: bytes.toString('base64') })).status, 400);
  assert.equal((await post({ fileName: 'bad.pdf', base64: 'not base64' })).status, 400);
  const failed = await post({ fileName: 'failed.pdf', base64: Buffer.from('bad').toString('base64') });
  assert.equal(failed.status, 422);
  assert.ok(failed.body.error?.includes('test OCR failure'));
  assert.equal(failed.body.code, 'OCR_FAILED');
  assert.equal(typeof failed.body.action, 'string');
  assert.deepEqual(await fs.readdir(dir), ['invoice.png']);
});

test('OCR accepts files up to the transport limit and rejects larger files before inference', async (t) => {
  await fs.mkdir(path.join(process.cwd(), '.test-data'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.test-data', 'ocr-limit-test-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  let ocrRuns = 0;
  const runOcr = async () => { ocrRuns++; return 'Readable text'; };
  const atLimit = Buffer.alloc(OCR_MAX_UPLOAD_BYTES, 65);
  const accepted = await processAttachmentOcr({
    fileName: 'at-limit.png',
    base64: atLimit.toString('base64')
  }, dir, runOcr);
  assert.equal(accepted.status, 200);
  const overLimit = Buffer.alloc(OCR_MAX_UPLOAD_BYTES + 1, 65);
  const rejected = await processAttachmentOcr({
    fileName: 'over-limit.png',
    base64: overLimit.toString('base64')
  }, dir, runOcr);
  assert.equal(rejected.status, 400);
  assert.equal(ocrRuns, 1, 'oversized files must be rejected before inference');
});

test('text uploads report server errors and OCR results become searchable text', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'disk full' }, { status: 500 }));
  await assert.rejects(uploadAttachment(new File(['hello'], 'notes.txt'), 'Chat Drop'),
    (error: Error) => error.message.includes('disk full'));
  t.mock.restoreAll();
  const fakeReader = class {
    result: string | null = null;
    onload: (() => void) | null = null;
    readAsDataURL() { this.result = 'data:image/png;base64,YQ=='; this.onload?.(); }
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  Object.defineProperty(globalThis, 'FileReader', { value: fakeReader, configurable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'FileReader', descriptor);
    else Reflect.deleteProperty(globalThis, 'FileReader');
  });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) =>
    String(url).startsWith('/api/runtime/status')
      ? Response.json(availableRuntimeStatus())
      : Response.json({ text: 'Invoice number 12345' }));
  const entry = await uploadAttachment(new File(['a'], 'invoice.png', { type: 'image/png' }), 'Chat Drop');
  assert.equal(entry.isBinary, false);
  assert.equal(searchVaultFiles('invoice number 12345', [entry]).length, 1);
});

test('image upload connects the server OCR route to searchable context', async (t) => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), 'ocr-test-'));
  t.after(() => fs.rm(dir, { recursive: true }));
  const app = express();
  registerAttachmentOcrRoute(app, () => dir, async (input) => {
    assert.equal(await fs.readFile(input, 'utf8'), 'image data');
    return 'Invoice total 12345';
  });
  const layers: Array<{ route?: { path: string; stack: Array<{ handle: (req: object, res: object) => void }> } }> =
    app._router.stack;
  const route = layers.find((layer) => layer.route?.path === '/api/filerepo/ocr')?.route;
  assert.ok(route);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  Object.defineProperty(globalThis, 'FileReader', {
    configurable: true,
    value: class {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() {
        this.result = `data:image/png;base64,${Buffer.from('image data').toString('base64')}`;
        this.onload?.();
      }
    }
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'FileReader', descriptor);
    else Reflect.deleteProperty(globalThis, 'FileReader');
  });
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      if (String(_url).startsWith('/api/runtime/status')) {
        resolve(Response.json(availableRuntimeStatus()));
        return;
      }
      let status = 200;
      const res = {
        status(code: number) { status = code; return this; },
        json(body: object) { resolve(Response.json(body, { status })); }
      };
      route.stack[0].handle({ body: JSON.parse(String(init?.body)) }, res);
    })
  );
  const entry = await uploadAttachment(new File(['image data'], 'invoice.png', { type: 'image/png' }), 'Chat Drop');
  assert.equal(await fs.readFile(path.join(dir, 'invoice.png'), 'utf8'), 'image data');
  assert.equal(searchVaultFiles('invoice total 12345', [entry]).length, 1);
});

test('OCR upload preflight blocks before file data is sent when GLM-OCR is unavailable', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json({
      sampledAt: new Date().toISOString(),
      router: { state: 'ready', baseUrl: 'http://127.0.0.1:8080', managed: true },
      gpu: { available: true, pressure: 'normal', thresholdPercent: 90, devices: [] },
      offload: {
        state: 'idle', thresholdPercent: 90, staleRecords: 0, indexedRecords: 0,
        lastUpdatedAt: new Date().toISOString()
      },
      context: null,
      model: {
        id: 'chat-model', loadedId: null, configuredContextTokens: 8192,
        effectiveContextTokens: 8192, pressureAdjusted: false
      },
      models: {
        chat: { selected: 'chat-model', available: true },
        embedding: { selected: 'nomic.gguf', available: true },
        ocr: {
          available: false,
          error: 'GLM-OCR model not found.',
          action: 'Install GLM-OCR and its matching projector.'
        }
      }
    });
  });

  await assert.rejects(
    uploadAttachment(new File(['image'], 'invoice.png', { type: 'image/png' }), 'Chat Drop'),
    (error: unknown) => error instanceof Error &&
      'code' in error && error.code === 'OCR_MODEL_UNAVAILABLE' &&
      'action' in error && String(error.action).includes('matching projector')
  );
  assert.equal(requests, 1);
});
