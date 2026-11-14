import { execFile } from 'node:child_process';
import { TELEMETRY_DEFAULTS } from '../../src/data/runtimeDefaults';
import { APP_ENV } from '../config/env';

export const VRAM_PRESSURE_THRESHOLD_PERCENT = TELEMETRY_DEFAULTS.vramPressureThresholdPercent;

export interface GpuDeviceTelemetry {
  index: number;
  name: string;
  usedMiB: number;
  totalMiB: number;
  usedPercent: number;
  utilizationPercent: number | null;
}

export interface GpuTelemetrySnapshot {
  available: boolean;
  sampledAt: string;
  thresholdPercent: number;
  pressure: 'normal' | 'high' | 'unknown';
  devices: GpuDeviceTelemetry[];
  error?: string;
}

const listeners = new Set<(snapshot: GpuTelemetrySnapshot) => void>();
let latest: GpuTelemetrySnapshot = {
  available: false,
  sampledAt: '',
  thresholdPercent: VRAM_PRESSURE_THRESHOLD_PERCENT,
  pressure: 'unknown',
  devices: [],
  error: 'GPU telemetry has not been sampled yet.'
};
let inFlight: Promise<GpuTelemetrySnapshot> | null = null;
let monitor: ReturnType<typeof setInterval> | null = null;

function runNvidiaSmi(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=index,name,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 2000, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

export function parseNvidiaSmiTelemetry(
  output: string,
  sampledAt = new Date().toISOString(),
  thresholdPercent = APP_ENV.vramPressureThresholdPercent
): GpuTelemetrySnapshot {
  const devices = output.split('\n').map((rawLine) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    return line.trim();
  }).filter(Boolean).map((line) => {
    const [rawIndex, rawName, rawUsed, rawTotal, rawUtilization] = line.split(',').map((field) => field.trim());
    const index = Number(rawIndex);
    const usedMiB = Number(rawUsed);
    const totalMiB = Number(rawTotal);
    const utilizationValue = Number(rawUtilization);
    if (!Number.isInteger(index) || !rawName || !Number.isFinite(usedMiB) ||
        !Number.isFinite(totalMiB) || totalMiB <= 0 || usedMiB < 0) {
      throw new Error(`Invalid nvidia-smi GPU telemetry row: "${line}".`);
    }
    const rawUsedPercent = (usedMiB / totalMiB) * 100;
    return {
      index,
      name: rawName,
      usedMiB,
      totalMiB,
      usedPercent: Math.round(rawUsedPercent * 10) / 10,
      utilizationPercent: Number.isFinite(utilizationValue) ? utilizationValue : null
    };
  });
  if (devices.length === 0) throw new Error('nvidia-smi returned no GPU devices.');
  const pressure = devices.some((device) => device.usedMiB / device.totalMiB * 100 >= thresholdPercent)
    ? 'high'
    : 'normal';
  return {
    available: true,
    sampledAt,
    thresholdPercent,
    pressure,
    devices
  };
}

function publish(snapshot: GpuTelemetrySnapshot): void {
  latest = snapshot;
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (error) {
      console.error('[LLMCP:TELEMETRY] GPU telemetry listener failed:', error);
    }
  }
}

export async function sampleGpuTelemetry(): Promise<GpuTelemetrySnapshot> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const thresholdPercent = APP_ENV.vramPressureThresholdPercent;
    try {
      const output = await runNvidiaSmi();
      const snapshot = parseNvidiaSmiTelemetry(output, new Date().toISOString(), thresholdPercent);
      publish(snapshot);
      return snapshot;
    } catch (error) {
      const snapshot: GpuTelemetrySnapshot = {
        available: false,
        sampledAt: new Date().toISOString(),
        thresholdPercent,
        pressure: 'unknown',
        devices: [],
        error: `GPU telemetry unavailable: ${error instanceof Error ? error.message : String(error)}`
      };
      publish(snapshot);
      return snapshot;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export async function getGpuTelemetry(maxAgeMs = APP_ENV.gpuSampleIntervalMs): Promise<GpuTelemetrySnapshot> {
  const sampledAt = Date.parse(latest.sampledAt);
  if (!latest.sampledAt || Date.now() - sampledAt > maxAgeMs) {
    return sampleGpuTelemetry();
  }
  return latest;
}

export function subscribeGpuTelemetry(listener: (snapshot: GpuTelemetrySnapshot) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function startGpuTelemetryMonitor(intervalMs = APP_ENV.gpuSampleIntervalMs): () => void {
  if (monitor) return () => stopGpuTelemetryMonitor();
  void sampleGpuTelemetry();
  monitor = setInterval(() => { void sampleGpuTelemetry(); }, intervalMs);
  monitor.unref?.();
  return () => stopGpuTelemetryMonitor();
}

export function stopGpuTelemetryMonitor(): void {
  if (monitor) clearInterval(monitor);
  monitor = null;
}
