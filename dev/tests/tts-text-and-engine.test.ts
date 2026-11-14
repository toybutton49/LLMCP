import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {
  KOKORO_VOICES,
  clampTtsSpeed,
  isKnownKokoroVoice,
  prepareTextForSpeech,
  splitSpeechChunks
} from '../../src/utils/ttsText';
import {
  getTtsStatus,
  resolveLocalTtsModel,
  scanLocalTtsModels,
  synthesizeSpeechWav,
  unloadTtsEngine
} from '../../server/tts/kokoroTtsEngine';
import { registerTtsRoutes } from '../../server/routes/ttsRoutes';
import type { LocalDatabaseSchema } from '../../server/db/localDatabase';

test('TTS text normalizer strips thinking traces, fenced code, and markdown formatting', () => {
  const markdown = [
    '<think>Internal reasoning that should never be spoken aloud.</think>',
    '# Summary Heading',
    '',
    'Here is **bold text**, `inlineCode()`, and a [Reference Link](https://example.com).',
    '',
    '```typescript',
    'const secret = 42;',
    'console.log(secret);',
    '```',
    '',
    '- First bullet point',
    '2. Second numbered point',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    '| Latency | 120 ms |'
  ].join('\n');

  const spoken = prepareTextForSpeech(markdown);
  assert.equal(spoken.includes('Internal reasoning'), false);
  assert.equal(spoken.includes('const secret'), false);
  assert.equal(spoken.includes('https://example.com'), false);
  assert.equal(spoken.includes('**'), false);
  assert.equal(spoken.includes('`'), false);
  assert.ok(spoken.includes('Summary Heading.'));
  assert.ok(spoken.includes('Here is bold text, inlineCode(), and a Reference Link.'));
  assert.ok(spoken.includes('Code block omitted.'));
  assert.ok(spoken.includes('First bullet point.'));
  assert.ok(spoken.includes('Second numbered point.'));
  assert.ok(spoken.includes('Latency, 120 ms.'));
});

test('TTS chunker splits multi-sentence text on sentence boundaries and wraps long sentences safely', () => {
  const multi =
    'Sentence one is concise. Sentence two adds a second point! Sentence three asks a question? ' +
    'Sentence four finishes the paragraph cleanly.';
  const chunks = splitSpeechChunks(multi, 90);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 90, `Chunk exceeded target length: ${chunk.length}`);
  }
  assert.equal(chunks.join(' '), multi);

  const oversized = Array.from({ length: 30 }, (_, i) => `word${i + 1}`).join(' ');
  const wrapped = splitSpeechChunks(oversized, 80);
  assert.ok(wrapped.length >= 3);
  for (const chunk of wrapped) {
    assert.ok(chunk.length <= 80, `Wrapped chunk exceeded target length: ${chunk.length}`);
  }
  assert.equal(wrapped.join(' '), oversized);
});

test('TTS voice and speed helpers validate bounds deterministically', () => {
  assert.ok(KOKORO_VOICES.length >= 10);
  assert.equal(isKnownKokoroVoice('af_heart'), true);
  assert.equal(isKnownKokoroVoice('bm_george'), true);
  assert.equal(isKnownKokoroVoice('unknown_voice_xyz'), false);

  assert.equal(clampTtsSpeed(1.0), 1.0);
  assert.equal(clampTtsSpeed(0.2), 0.7);
  assert.equal(clampTtsSpeed(3.5), 1.5);
  assert.equal(clampTtsSpeed(Number.NaN), 1.0);
  assert.equal(clampTtsSpeed(1.126), 1.13);
});

test('TTS model scanner rejects Git LFS pointers and requires real ONNX weights', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llmcp-tts-scan-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const modelDir = path.join(tempRoot, 'Kokoro-82M-v1.0-ONNX');
  const onnxDir = path.join(modelDir, 'onnx');
  fs.mkdirSync(onnxDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'config.json'), '{}');
  fs.writeFileSync(path.join(modelDir, 'tokenizer.json'), '{}');
  // Write a tiny 134-byte LFS-style pointer file
  fs.writeFileSync(
    path.join(onnxDir, 'model_quantized.onnx'),
    'version https://git-lfs.github.com/spec/v1\noid sha256:0000\nsize 89000000\n'
  );

  assert.deepEqual(scanLocalTtsModels(tempRoot), []);
  assert.throws(
    () => resolveLocalTtsModel(undefined, tempRoot),
    (err: unknown) => err instanceof Error && err.message.includes('Local TTS model not found')
  );

  // Replace with >1KB placeholder weight file
  fs.writeFileSync(path.join(onnxDir, 'model_quantized.onnx'), Buffer.alloc(2048, 7));
  const discovered = scanLocalTtsModels(tempRoot);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].id, 'Kokoro-82M-v1.0-ONNX');
  assert.equal(discovered[0].dtype, 'q8');
  assert.equal(discovered[0].sizeBytes, 2048);

  const resolved = resolveLocalTtsModel('', tempRoot);
  assert.equal(resolved.id, 'Kokoro-82M-v1.0-ONNX');
  assert.throws(
    () => resolveLocalTtsModel('NonExistent-Model', tempRoot),
    (err: unknown) => err instanceof Error && err.message.includes('was not found')
  );
});

test('Offline Kokoro-82M engine synthesizes valid 24kHz WAV audio and serves /api/tts routes', async (t) => {
  const status = getTtsStatus();
  assert.equal(status.available, true, status.error || 'Local Kokoro weights should exist in ./models');
  assert.equal(status.modelId, 'Kokoro-82M-v1.0-ONNX');

  const synth = await synthesizeSpeechWav({
    text: '**Offline check**: local synthesis works cleanly.',
    voice: 'af_heart',
    speed: 1.05
  });
  assert.equal(synth.sampleRate, 24000);
  assert.ok(synth.durationMs > 200);
  assert.equal(synth.wavBuffer.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(synth.wavBuffer.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.ok(synth.wavBuffer.byteLength > 10000);

  const app = express();
  app.use(express.json());
  const db = {
    engineSettings: {
      ttsModelId: '',
      ttsVoice: 'af_heart',
      ttsSpeed: 1.0,
      modelTtlSeconds: 60
    }
  } as unknown as LocalDatabaseSchema;
  registerTtsRoutes(app, () => db);

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(async () => {
    unloadTtsEngine();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  unloadTtsEngine();
  const statusRes = await fetch(`${baseUrl}/api/tts/status`);
  assert.equal(statusRes.status, 200);
  const statusBody = await statusRes.json() as {
    available: boolean;
    loaded: boolean;
    modelId: string;
    ttlSeconds: number;
  };
  assert.equal(statusBody.available, true);
  assert.equal(statusBody.loaded, false);
  assert.equal(statusBody.modelId, 'Kokoro-82M-v1.0-ONNX');
  assert.equal(statusBody.ttlSeconds, 60);

  const scanRes = await fetch(`${baseUrl}/api/tts/scan`, { method: 'POST' });
  assert.equal(scanRes.status, 200);
  const scanBody = await scanRes.json() as { loaded: boolean };
  assert.equal(scanBody.loaded, false);

  const badRes = await fetch(`${baseUrl}/api/tts/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '   ' })
  });
  assert.equal(badRes.status, 400);

  const speakRes = await fetch(`${baseUrl}/api/tts/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Ready to speak locally.', voice: 'bm_george', speed: 1.0 })
  });
  assert.equal(speakRes.status, 200);
  assert.ok((speakRes.headers.get('content-type') || '').includes('audio/wav'));
  assert.equal(speakRes.headers.get('x-tts-voice'), 'bm_george');
  assert.equal(speakRes.headers.get('x-tts-ttl-seconds'), '60');
  const wavBytes = Buffer.from(await speakRes.arrayBuffer());
  assert.equal(wavBytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wavBytes.subarray(8, 12).toString('ascii'), 'WAVE');

  const afterSpeakStatus = await (await fetch(`${baseUrl}/api/tts/status`)).json() as { loaded: boolean };
  assert.equal(afterSpeakStatus.loaded, true);

  // Short modelTtlSeconds (e.g. 10s) holds >=60s while hasMoreChunks is true, then arms 10s on final chunk.
  db.engineSettings.modelTtlSeconds = 10;
  const midStreamRes = await fetch(`${baseUrl}/api/tts/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'First chunk in multi-chunk playback.', hasMoreChunks: true })
  });
  assert.equal(midStreamRes.status, 200);
  assert.equal(midStreamRes.headers.get('x-tts-ttl-seconds'), '60');

  const finalStreamRes = await fetch(`${baseUrl}/api/tts/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Final chunk in multi-chunk playback.', hasMoreChunks: false })
  });
  assert.equal(finalStreamRes.status, 200);
  assert.equal(finalStreamRes.headers.get('x-tts-ttl-seconds'), '10');
  db.engineSettings.modelTtlSeconds = 60;

  // Zero-second TTL unloads immediately after synthesis completes.
  const zeroTtlRes = await fetch(`${baseUrl}/api/tts/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Unload immediately.', voice: 'af_heart', speed: 1.0, ttlSeconds: 0 })
  });
  assert.equal(zeroTtlRes.status, 200);
  assert.equal(zeroTtlRes.headers.get('x-tts-ttl-seconds'), '0');
  const afterZeroTtlStatus = await (await fetch(`${baseUrl}/api/tts/status`)).json() as { loaded: boolean };
  assert.equal(afterZeroTtlStatus.loaded, false);

  // Positive TTL keeps model loaded briefly then auto-unloads after expiry.
  const shortTtlResult = await synthesizeSpeechWav({
    text: 'Short TTL timer check.',
    voice: 'af_heart',
    speed: 1.0,
    ttlSeconds: 1
  });
  assert.equal(shortTtlResult.ttlSeconds, 1);
  assert.equal(getTtsStatus().loaded, true);
  await new Promise((resolve) => setTimeout(resolve, 1250));
  assert.equal(getTtsStatus().loaded, false);
});
