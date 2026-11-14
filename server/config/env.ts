// Runtime environment configuration backed by process environment and centralized defaults.
import fs from 'fs';
import net from 'node:net';
import path from 'path';
import {
  AUXILIARY_SERVER_DEFAULTS,
  GENERATION_DEFAULTS,
  MEMORY_PROBE_DEFAULTS,
  OCR_DEFAULTS,
  RUNTIME_DEFAULTS,
  TELEMETRY_DEFAULTS,
  TTS_DEFAULTS
} from '../../src/data/runtimeDefaults';
import { sanitizeLoopbackEndpoint } from '../../src/utils/rag';
import { isAllowedClientIp } from './networkAccess';

function resolveWorkspaceRoot(): string {
  const cwd = path.resolve(process.cwd());
  if (
    path.basename(cwd).toLowerCase() === 'scripts' &&
    fs.existsSync(path.join(cwd, '..', 'server.ts')) &&
    fs.existsSync(path.join(cwd, '..', 'package.json'))
  ) {
    return path.resolve(cwd, '..');
  }
  return cwd;
}

export const WORKSPACE_ROOT = resolveWorkspaceRoot();
export const LLMCP_MODELS_DIR = path.join(WORKSPACE_ROOT, 'models');
export const UI_PORT = RUNTIME_DEFAULTS.uiPort;

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function parseBoundedNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function parseValidPort(raw: string | undefined, label = 'UI port'): number {
  const text = (raw ?? '').trim();
  if (!text) {
    throw new Error(`${label} requires an integer port between ${RUNTIME_DEFAULTS.minPort} and ${RUNTIME_DEFAULTS.maxPort}.`);
  }
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) {
      throw new Error(`Invalid ${label} "${text}". Choose an integer port between ${RUNTIME_DEFAULTS.minPort} and ${RUNTIME_DEFAULTS.maxPort}.`);
    }
  }
  const port = Number(text);
  if (!Number.isInteger(port) || port < RUNTIME_DEFAULTS.minPort || port > RUNTIME_DEFAULTS.maxPort) {
    throw new Error(`Invalid ${label} "${text}". Choose an integer port between ${RUNTIME_DEFAULTS.minPort} and ${RUNTIME_DEFAULTS.maxPort}.`);
  }
  return port;
}

export function validateUiPort(args: string[], envPort: string | undefined): number {
  let resolved: number | undefined;
  if (envPort !== undefined && envPort.trim() !== '') {
    resolved = parseValidPort(envPort, 'PORT');
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' || arg === '-p') {
      resolved = parseValidPort(args[++i], arg);
    } else if (arg.startsWith('--port=')) {
      resolved = parseValidPort(arg.slice('--port='.length), '--port');
    }
  }
  return resolved ?? RUNTIME_DEFAULTS.uiPort;
}

export function ensureModelsDirectory(): string {
  const custom = process.env.LLMCP_MODELS_DIR?.trim();
  const targetDir = custom ? path.resolve(WORKSPACE_ROOT, custom) : LLMCP_MODELS_DIR;
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  return targetDir;
}

function formatModelsDirLabel(): string {
  const custom = process.env.LLMCP_MODELS_DIR?.trim();
  if (!custom) return RUNTIME_DEFAULTS.modelsDir;
  const resolved = path.resolve(WORKSPACE_ROOT, custom);
  const rel = path.relative(WORKSPACE_ROOT, resolved).split(path.sep).join('/');
  if (!rel) return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return resolved;
  return rel.startsWith('.') ? rel : `./${rel}`;
}

ensureModelsDirectory();

export function validateBindHost(args: string[], envHost: string | undefined): string {
  let rawHost = envHost !== undefined && envHost.trim() !== '' ? envHost.trim() : undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--host' || arg === '-H') {
      rawHost = (args[++i] ?? '').trim();
      if (!rawHost) {
        throw new Error(`${arg} requires a valid bind host (for example 0.0.0.0, 127.0.0.1, or a LAN/Tailscale IP).`);
      }
    } else if (arg.startsWith('--host=')) {
      rawHost = arg.slice('--host='.length).trim();
      if (!rawHost) {
        throw new Error('--host requires a valid bind host (for example 0.0.0.0, 127.0.0.1, or a LAN/Tailscale IP).');
      }
    }
  }
  const candidate = rawHost ?? RUNTIME_DEFAULTS.bindHost;
  if (candidate === '0.0.0.0' || candidate === '::' || candidate === 'localhost') {
    return candidate;
  }
  if (net.isIP(candidate) !== 0 && isAllowedClientIp(candidate)) {
    return candidate;
  }
  throw new Error(
    `Invalid bind host "${candidate}". Use 0.0.0.0, localhost, 127.0.0.1, ::1, or a private LAN/Tailscale IP.`
  );
}

export const APP_ENV = {
  get bindHost(): string {
    return validateBindHost(process.argv.slice(2), process.env.HOST);
  },
  get port(): number {
    return validateUiPort(process.argv.slice(2), process.env.PORT);
  },
  get llamaCppBaseUrl(): string {
    const raw = process.env.LLAMA_CPP_BASE_URL?.trim();
    return raw
      ? sanitizeLoopbackEndpoint(raw, RUNTIME_DEFAULTS.llamaCppBaseUrl)
      : RUNTIME_DEFAULTS.llamaCppBaseUrl;
  },
  get modelsDir(): string {
    return formatModelsDirLabel();
  },
  get localDbPath(): string {
    return (process.env.LOCAL_DB_PATH || RUNTIME_DEFAULTS.localDbPath).trim();
  },
  get fileRepoDir(): string {
    return (process.env.FILE_REPO_DIR || RUNTIME_DEFAULTS.fileRepoDir).trim();
  },
  get enableThinking(): boolean {
    const val = (process.env.ENABLE_THINKING || String(GENERATION_DEFAULTS.thinkingEnabled)).toLowerCase();
    return val !== 'false' && val !== '0';
  },
  get reasoningEffort(): 'low' | 'medium' | 'high' {
    const val = (process.env.REASONING_EFFORT || GENERATION_DEFAULTS.reasoningEffort).toLowerCase();
    if (val === 'low' || val === 'high') return val;
    return GENERATION_DEFAULTS.reasoningEffort;
  },
  get modelTtlSeconds(): number {
    return parseBoundedInt(
      process.env.MODEL_TTL_SECONDS,
      GENERATION_DEFAULTS.modelTtlSeconds,
      0,
      GENERATION_DEFAULTS.maxModelTtlSeconds
    );
  },
  get maxToolRounds(): number {
    return parseBoundedInt(process.env.MAX_TOOL_ROUNDS, GENERATION_DEFAULTS.maxToolRounds, 1, 16);
  },
  get memoryProbeMaxTokens(): number {
    return parseBoundedInt(process.env.MEMORY_PROBE_MAX_TOKENS, MEMORY_PROBE_DEFAULTS.maxTokens, 100, 4000);
  },
  get contextPressureThresholdPercent(): number {
    return parseBoundedNumber(
      process.env.CONTEXT_PRESSURE_THRESHOLD_PERCENT ?? process.env.VRAM_PRESSURE_THRESHOLD_PERCENT,
      TELEMETRY_DEFAULTS.contextPressureThresholdPercent,
      50,
      99
    );
  },
  get contextPressureBudgetRatio(): number {
    return parseBoundedNumber(
      process.env.CONTEXT_PRESSURE_BUDGET_RATIO ?? process.env.VRAM_PRESSURE_CONTEXT_RATIO,
      TELEMETRY_DEFAULTS.contextPressureBudgetRatio,
      0.25,
      1
    );
  },
  get vramPressureThresholdPercent(): number {
    return parseBoundedNumber(
      process.env.VRAM_PRESSURE_THRESHOLD_PERCENT,
      TELEMETRY_DEFAULTS.vramPressureThresholdPercent,
      50,
      99
    );
  },
  get vramPressureContextRatio(): number {
    return parseBoundedNumber(
      process.env.VRAM_PRESSURE_CONTEXT_RATIO,
      TELEMETRY_DEFAULTS.vramPressureContextRatio,
      0.25,
      1
    );
  },
  get gpuSampleIntervalMs(): number {
    return parseBoundedInt(
      process.env.GPU_TELEMETRY_INTERVAL_MS,
      TELEMETRY_DEFAULTS.gpuSampleIntervalMs,
      250,
      60000
    );
  },
  get offloadBatchSize(): number {
    return parseBoundedInt(process.env.OFFLOAD_BATCH_SIZE, TELEMETRY_DEFAULTS.offloadBatchSize, 1, 512);
  },
  get offloadRetryDelayMs(): number {
    return parseBoundedInt(
      process.env.OFFLOAD_RETRY_DELAY_MS,
      TELEMETRY_DEFAULTS.offloadRetryDelayMs,
      1000,
      300000
    );
  },
  get embeddingIdleMs(): number {
    return parseBoundedInt(
      process.env.EMBEDDING_IDLE_MS,
      AUXILIARY_SERVER_DEFAULTS.embeddingIdleMs,
      0,
      300000
    );
  },
  get embeddingContextSize(): number {
    return parseBoundedInt(
      process.env.EMBEDDING_CONTEXT_SIZE,
      AUXILIARY_SERVER_DEFAULTS.embeddingContextSize,
      512,
      32768
    );
  },
  get ocrContextSize(): number {
    return parseBoundedInt(
      process.env.OCR_CONTEXT_SIZE,
      AUXILIARY_SERVER_DEFAULTS.ocrContextSize,
      512,
      32768
    );
  },
  get ocrMaxTokens(): number {
    return parseBoundedInt(
      process.env.OCR_MAX_TOKENS,
      AUXILIARY_SERVER_DEFAULTS.ocrMaxTokens,
      256,
      16384
    );
  },
  get ocrMaxUploadBytes(): number {
    return parseBoundedInt(
      process.env.OCR_MAX_UPLOAD_BYTES,
      OCR_DEFAULTS.maxUploadBytes,
      1024 * 1024,
      256 * 1024 * 1024
    );
  },
  get ocrMaxPages(): number {
    return parseBoundedInt(process.env.OCR_MAX_PAGES, OCR_DEFAULTS.maxPages, 1, 200);
  },
  get ocrMaxPixelsPerPage(): number {
    return parseBoundedInt(
      process.env.OCR_MAX_PIXELS_PER_PAGE,
      OCR_DEFAULTS.maxPixelsPerPage,
      1_000_000,
      64_000_000
    );
  },
  get auxiliaryMaxThreads(): number {
    return parseBoundedInt(
      process.env.AUXILIARY_MAX_THREADS,
      AUXILIARY_SERVER_DEFAULTS.maxCpuThreads,
      1,
      32
    );
  },
  get ttsVoice(): string {
    return (process.env.TTS_VOICE || TTS_DEFAULTS.voice).trim();
  },
  get ttsSpeed(): number {
    return parseBoundedNumber(
      process.env.TTS_SPEED,
      TTS_DEFAULTS.speed,
      TTS_DEFAULTS.minSpeed,
      TTS_DEFAULTS.maxSpeed
    );
  },
  get ttsIdleMs(): number {
    return parseBoundedInt(
      process.env.TTS_IDLE_MS,
      TTS_DEFAULTS.idleUnloadMs,
      0,
      3600_000
    );
  }
};
