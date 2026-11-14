// Local Text-to-Speech API routes (status, model scan, and offline WAV synthesis).
import type { Express } from 'express';
import { TTS_DEFAULTS } from '../../src/data/runtimeDefaults';
import { toAppErrorPayload } from '../../src/utils/appErrors';
import { sanitizeJsonObject } from '../../src/utils/rag';
import { serverLogger } from '../config/logger';
import type { LocalDatabaseSchema } from '../db/localDatabase';
import { getTtsStatus, synthesizeSpeechWav } from '../tts/kokoroTtsEngine';

export function registerTtsRoutes(
  app: Express,
  getLocalDb: () => LocalDatabaseSchema
): void {
  app.get('/api/tts/status', (_req, res) => {
    const localDb = getLocalDb();
    res.setHeader('Cache-Control', 'no-store');
    res.json(
      getTtsStatus(
        localDb.engineSettings.ttsModelId,
        localDb.engineSettings.ttsVoice,
        localDb.engineSettings.ttsSpeed,
        localDb.engineSettings.modelTtlSeconds
      )
    );
  });

  app.post('/api/tts/scan', (_req, res) => {
    const localDb = getLocalDb();
    res.setHeader('Cache-Control', 'no-store');
    res.json(
      getTtsStatus(
        localDb.engineSettings.ttsModelId,
        localDb.engineSettings.ttsVoice,
        localDb.engineSettings.ttsSpeed,
        localDb.engineSettings.modelTtlSeconds
      )
    );
  });

  app.post('/api/tts/speak', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'Request body must be a JSON object.' });
      return;
    }
    const localDb = getLocalDb();
    const body = sanitizeJsonObject(req.body as Record<string, unknown>);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'Text is required for speech synthesis.' });
      return;
    }
    if (text.length > TTS_DEFAULTS.maxInputChars) {
      res.status(400).json({
        error: `Speech chunk exceeds the ${TTS_DEFAULTS.maxInputChars}-character limit.`
      });
      return;
    }

    const voice = typeof body.voice === 'string' && body.voice.trim()
      ? body.voice.trim()
      : localDb.engineSettings.ttsVoice;
    const speed = typeof body.speed === 'number'
      ? body.speed
      : localDb.engineSettings.ttsSpeed;
    const modelId = typeof body.modelId === 'string' && body.modelId.trim()
      ? body.modelId.trim()
      : localDb.engineSettings.ttsModelId;
    const hasExplicitTtl =
      typeof body.ttlSeconds === 'number' &&
      Number.isFinite(body.ttlSeconds) &&
      body.ttlSeconds >= 0;
    const baseTtlSeconds = hasExplicitTtl
      ? body.ttlSeconds as number
      : localDb.engineSettings.modelTtlSeconds;
    const hasMoreChunks = body.hasMoreChunks === true;
    // Keep Kokoro warm across buffered multi-chunk utterances when a short non-zero TTL (e.g. 10s) is configured,
    // then arm the configured TTL on the final chunk so speech never evicts and cold-reloads mid-sentence.
    const ttlSeconds =
      hasMoreChunks && !hasExplicitTtl && typeof baseTtlSeconds === 'number' && baseTtlSeconds > 0
        ? Math.max(baseTtlSeconds, 60)
        : baseTtlSeconds;

    try {
      const result = await synthesizeSpeechWav({ text, voice, speed, modelId, ttlSeconds });
      serverLogger.info('inference', 'tts.speak.complete', {
        modelId: result.modelId,
        voice: result.voice,
        speed: result.speed,
        ttlSeconds: result.ttlSeconds,
        durationMs: result.durationMs,
        synthMs: result.synthMs,
        wavBytes: result.wavBuffer.byteLength
      });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('X-TTS-Model', result.modelId);
      res.setHeader('X-TTS-Voice', result.voice);
      res.setHeader('X-TTS-Duration-Ms', String(result.durationMs));
      res.setHeader('X-TTS-Synth-Ms', String(result.synthMs));
      res.setHeader('X-TTS-TTL-Seconds', String(result.ttlSeconds));
      res.send(result.wavBuffer);
    } catch (error) {
      serverLogger.error('inference', 'tts.speak.failed', error);
      res.status(503).json(
        toAppErrorPayload(error, {
          code: 'TTS_UNAVAILABLE',
          feature: 'Local Text-to-Speech',
          action: 'Verify the local Kokoro-82M ONNX model is present in ./models and retry.'
        })
      );
    }
  });
}
