import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GgufAndHardwareSection } from '../../src/components/settings/GgufAndHardwareSection';
import { registerNativeAndQueryRoutes } from '../../server/routes/nativeAndQueryRoutes';
import { uploadAttachment } from '../../src/utils/attachmentUpload';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRagConfig } from '../../server/db/localDatabase';
import { scanLocalFilesystemModels } from '../../server/db/cryptoAndModels';
import { embeddingRetrieval, resolveEmbeddingModel } from '../../server/llamacpp/embeddingRetrieval';
import { findGlmOcrModel } from '../../server/routes/glmOcr';
import { DEFAULT_RAG_CONFIG } from '../../src/hooks/workspaceStateDefaults';
import { StorageOrchestrator } from '../../src/orchestrators/storageOrchestrator';

test('fresh workspaces have zero hardcoded model filenames and discover installed auxiliary models dynamically', async (t) => {
  const fresh = new StorageOrchestrator().createFreshInstallSnapshot().ragConfig;
  for (const config of [fresh, DEFAULT_RAG_CONFIG, normalizeRagConfig({}), normalizeRagConfig({ embeddingModel: '' })]) {
    assert.equal(config.embeddingModel, '');
    assert.equal(config.ocrModel, '');
  }
  const selected = normalizeRagConfig({ embeddingModel: 'missing-nomic.gguf', ocrModel: 'custom-GLM-OCR.gguf' });
  assert.equal(selected.embeddingModel, 'missing-nomic.gguf');
  assert.equal(selected.ocrModel, 'custom-GLM-OCR.gguf');
  const cleared = normalizeRagConfig({ embeddingModel: '', ocrModel: '' }, selected);
  assert.equal(cleared.embeddingModel, '');
  assert.equal(cleared.ocrModel, '');

  const testRoot = path.join(process.cwd(), '.test-data');
  fs.mkdirSync(testRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(testRoot, 'dynamic-discovery-'));
  const previousModelsDir = process.env.LLMCP_MODELS_DIR;
  process.env.LLMCP_MODELS_DIR = path.relative(process.cwd(), directory);
  t.after(() => {
    if (previousModelsDir === undefined) delete process.env.LLMCP_MODELS_DIR;
    else process.env.LLMCP_MODELS_DIR = previousModelsDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const embeddingFile = 'custom-nomic-embed-text-v2.Q8_0.gguf';
  const ocrDir = path.join(directory, 'ocr-pair');
  fs.mkdirSync(ocrDir, { recursive: true });
  const ocrFile = 'Custom-GLM-OCR-Q8_0.gguf';
  const projectorFile = 'mmproj-Custom-GLM-OCR-Q8_0.gguf';
  fs.writeFileSync(path.join(directory, embeddingFile), 'GGUF');
  fs.writeFileSync(path.join(ocrDir, ocrFile), 'GGUF');
  fs.writeFileSync(path.join(ocrDir, projectorFile), 'GGUF');

  const discovered = scanLocalFilesystemModels();
  assert.ok(discovered.embeddingModels.includes(embeddingFile));
  assert.ok(!discovered.ggufModels.includes(embeddingFile.slice(0, -5)));
  assert.ok(!discovered.ggufModels.includes(ocrFile.slice(0, -5)));
  assert.ok(resolveEmbeddingModel(embeddingFile));
  const ocr = await findGlmOcrModel(discovered.ocrFiles);
  assert.equal(path.basename(ocr.model), ocrFile);
  assert.equal(path.basename(ocr.projector), projectorFile);
});

test('default embeddingRetrieval stops its temporary server immediately after retrieval', async () => {
  // Verify the exported singleton does not retain a warm embedding process between calls (NATIVE_INFERENCE.md)
  assert.equal((embeddingRetrieval as unknown as { idleMs: number }).idleMs, 0);
});

test('unfetched embedding, OCR and projector weights report Git LFS recovery', async (t) => {
  const testRoot = path.join(process.cwd(), '.test-data');
  fs.mkdirSync(testRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(testRoot, 'lfs-test-'));
  const previousModelsDir = process.env.LLMCP_MODELS_DIR;
  process.env.LLMCP_MODELS_DIR = path.relative(process.cwd(), directory);
  t.after(() => {
    if (previousModelsDir === undefined) delete process.env.LLMCP_MODELS_DIR;
    else process.env.LLMCP_MODELS_DIR = previousModelsDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + '0'.repeat(64) + '\nsize 100\n';
  const embeddingName = `${path.basename(directory)}-nomic-embed-text.gguf`;
  fs.writeFileSync(path.join(directory, embeddingName), pointer);
  assert.throws(
    () => resolveEmbeddingModel(embeddingName),
    (err: Error) => err.message.includes('Git LFS pointer') && err.message.includes('git lfs pull')
  );
  const ocrModelName = 'test-GLM-OCR.gguf';
  const modelPath = path.join(directory, ocrModelName);
  const projectorPath = path.join(directory, 'mmproj-GLM-OCR-test.gguf');
  fs.writeFileSync(modelPath, pointer);
  fs.writeFileSync(projectorPath, 'GGUF');
  const files = [{ id: 'ocr', fileName: ocrModelName, relativePath: path.relative(process.cwd(), modelPath), sizeBytes: 100, quantization: 'Q8_0' }];
  await assert.rejects(
    findGlmOcrModel(files, ocrModelName),
    (err: Error) => err.message.includes('Git LFS pointer') && err.message.includes('git lfs pull')
  );
  fs.writeFileSync(modelPath, 'GGUF');
  fs.writeFileSync(projectorPath, pointer);
  await assert.rejects(
    findGlmOcrModel(files, ocrModelName),
    (err: Error) => err.message.includes('Git LFS pointer') && err.message.includes('git lfs pull')
  );
});

test('model setup explains manual placement and rejects metadata-only imports', async () => {
  const markup = renderToStaticMarkup(React.createElement(GgufAndHardwareSection, {
    settings: { activeModelId: '', temperature: 0.3, topP: 0.9,
      systemInstruction: '', enableThinking: true, thinkingBudget: 4096 },
    setSettings: () => {}, discoveredGgufs: [], scanMessage: null, actionLoading: null,
    onScanDirectory: () => {}, onContextLengthChange: () => {}
  }));
  assert.ok(markup.includes('This screen does not upload model files'));
  assert.ok(!markup.includes('Import .GGUF into'));
  await assert.rejects(uploadAttachment(new File(['weights'], 'model.gguf'), 'Chat Drop'),
    (error: Error) => error.message.includes('Copy the file to ./models'));

  const app = express();
  registerNativeAndQueryRoutes(app, () => { throw new Error('No database mutation expected'); });
  const layers: Array<{ route?: { path: string; stack: Array<{ handle: (req: object, res: object) => void }> } }> =
    app._router.stack;
  const route = layers.find((layer) => layer.route?.path === '/api/native/import-gguf')?.route;
  assert.ok(route);
  let status = 200;
  let response: { error?: string } = {};
  const res = {
    status(code: number) { status = code; return this; },
    json(body: { error?: string }) { response = body; }
  };
  route.stack[0].handle({ body: { fileName: 'missing.gguf', sizeBytes: 123 } }, res);
  assert.equal(status, 410);
  assert.ok(response.error?.includes('does not upload weights'));
});
