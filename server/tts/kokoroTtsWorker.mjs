// Dedicated worker thread for offline Kokoro-82M ONNX synthesis.
// Isolates tokenizer loading, espeak-ng WASM phonemization, and bounded-thread ONNX CPU inference
// from the main Express/Vite HTTP and WebSocket event loop.
import os from 'node:os';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { AutoTokenizer, StyleTextToSpeech2Model, env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';

let loadedModelId = null;
let loadedDtype = null;
let loadedThreads = 0;
let loadedInstance = null;
let taskChain = Promise.resolve();

function resolveBoundedThreads(requested) {
  const cpuCount = Math.max(1, os.cpus().length);
  const reserveCores = cpuCount >= 6 ? 2 : cpuCount >= 3 ? 1 : 0;
  const ceiling = Math.max(1, cpuCount - reserveCores);
  const parsed = Number(requested);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return Math.max(1, Math.min(ceiling, Math.round(parsed)));
  }
  return Math.min(8, ceiling);
}

async function unloadLoadedModel() {
  const previous = loadedInstance;
  loadedInstance = null;
  loadedModelId = null;
  loadedDtype = null;
  loadedThreads = 0;
  const disposable = previous && previous.model;
  if (disposable && typeof disposable.dispose === 'function') {
    await disposable.dispose().catch(() => undefined);
  }
}

async function ensureKokoroInstance(modelsRoot, modelId, dtype, maxThreads) {
  const boundedThreads = resolveBoundedThreads(maxThreads);
  if (
    loadedInstance &&
    loadedModelId === modelId &&
    loadedDtype === dtype &&
    loadedThreads === boundedThreads
  ) {
    return loadedInstance;
  }
  if (loadedInstance) {
    await unloadLoadedModel();
  }

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelsRoot.endsWith(path.sep) ? modelsRoot : `${modelsRoot}${path.sep}`;

  let instance;
  try {
    const [ttsModel, tokenizer] = await Promise.all([
      StyleTextToSpeech2Model.from_pretrained(modelId, {
        dtype,
        device: 'cpu',
        session_options: {
          intraOpNumThreads: boundedThreads,
          interOpNumThreads: 1
        }
      }),
      AutoTokenizer.from_pretrained(modelId)
    ]);
    instance = new KokoroTTS(ttsModel, tokenizer);
  } catch {
    instance = await KokoroTTS.from_pretrained(modelId, {
      dtype,
      device: 'cpu'
    });
  }

  loadedInstance = instance;
  loadedModelId = modelId;
  loadedDtype = dtype;
  loadedThreads = boundedThreads;
  return instance;
}

if (parentPort) {
  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'unload') {
      taskChain = taskChain
        .then(() => unloadLoadedModel())
        .catch(() => undefined);
      return;
    }

    if (msg.type === 'synthesize') {
      const { id, modelsRoot, modelId, dtype, text, voice, speed, maxThreads } = msg;
      taskChain = taskChain
        .then(async () => {
          const instance = await ensureKokoroInstance(modelsRoot, modelId, dtype, maxThreads);
          const t0 = Date.now();
          const audio = await instance.generate(text, { voice, speed });
          const synthMs = Math.max(1, Date.now() - t0);
          const wavArrayBuffer = audio.toWav();
          const durationMs = Math.round((audio.audio.length / audio.sampling_rate) * 1000);
          parentPort.postMessage(
            {
              id,
              ok: true,
              wavArrayBuffer,
              sampleRate: audio.sampling_rate,
              durationMs,
              synthMs
            },
            [wavArrayBuffer]
          );
        })
        .catch((err) => {
          parentPort.postMessage({
            id,
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          });
        });
    }
  });
}
