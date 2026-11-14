import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { AUXILIARY_SERVER_DEFAULTS } from '../../src/data/runtimeDefaults';
import { APP_ENV } from '../config/env';
import { resolveLlamaServerBinary } from './llamaCppTtl';

export interface AuxiliaryLlamaServer {
  baseUrl: string;
  apiKey: string;
  stop: () => Promise<void>;
  isRunning?: () => boolean;
}

export async function sendAuxiliaryRequest(
  server: AuxiliaryLlamaServer,
  endpoint: string,
  payload: object,
  label: string
): Promise<unknown> {
  const address = new URL(server.baseUrl);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port ||
      address.username || address.password || address.pathname !== '/' || address.search || address.hash) {
    throw new Error(`Invalid local ${label === 'GLM-OCR' ? 'OCR' : label} server address.`);
  }
  const body = JSON.stringify(payload);
  const agent = new http.Agent({ keepAlive: false });
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1', port: Number(address.port), path: endpoint, method: 'POST',
        agent, signal: AbortSignal.timeout(AUXILIARY_SERVER_DEFAULTS.requestTimeoutMs),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${server.apiKey}`
        }
      }, (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          responseBody += chunk;
          if (responseBody.length > AUXILIARY_SERVER_DEFAULTS.maxResponseBytes) {
            response.destroy(new Error(`${label} response is too large.`));
          }
        });
        response.on('error', reject);
        response.on('aborted', () => reject(new Error(`${label} response was interrupted.`)));
        response.on('end', () => {
          if (response.statusCode !== 200) {
            const detail = responseBody.trim().slice(0, 500);
            reject(new Error(`${label} inference failed (HTTP ${response.statusCode})${detail ? `: ${detail}` : '.'}`));
            return;
          }
          try {
            resolve(JSON.parse(responseBody) as unknown);
          } catch {
            reject(new Error(`${label} returned invalid JSON.`));
          }
        });
      });
      request.on('error', reject);
      request.end(body);
    });
  } finally {
    agent.destroy();
  }
}

async function stopChild(child: ChildProcess, label: string): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  await new Promise<void>((resolve, reject) => {
    const failTimer = setTimeout(() => reject(new Error(`Could not stop the temporary ${label} server.`)), 5000);
    const forceTimer = setTimeout(() => {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      } else {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, 2500);
    child.once('close', () => { clearTimeout(forceTimer); clearTimeout(failTimer); resolve(); });
    if (!child.kill()) {
      clearTimeout(forceTimer);
      clearTimeout(failTimer);
      reject(new Error(`Could not stop the temporary ${label} server.`));
    }
  });
}

export async function startAuxiliaryLlamaServer(args: string[], label: string): Promise<AuxiliaryLlamaServer> {
  const runtime = await resolveLlamaServerBinary();
  if (!runtime) throw new Error(`A local llama.cpp server executable is required for ${label}.`);
  const apiKey = randomBytes(32).toString('hex');
  const threads = String(Math.max(1, Math.min(APP_ENV.auxiliaryMaxThreads, os.availableParallelism())));
  const httpThreads = String(AUXILIARY_SERVER_DEFAULTS.httpThreads);
  const child = spawn(runtime.bin, [
    ...runtime.subcommand, ...args, '--threads', threads, '--threads-batch', threads,
    '--poll', '0', '--poll-batch', '0', '--threads-http', httpThreads,
    '--host', '127.0.0.1', '--port', '0', '--api-key', apiKey
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stopOnExit = () => { child.kill(); };
  process.once('exit', stopOnExit);
  child.once('close', () => process.removeListener('exit', stopOnExit));
  try {
    const baseUrl = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      let settled = false;
      const finish = (error?: Error, url?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else if (url) resolve(url);
        else reject(new Error(`${label} server did not provide an address.`));
      };
      const timer = setTimeout(
        () => finish(new Error(`${label} server startup timed out.`)),
        AUXILIARY_SERVER_DEFAULTS.startupTimeoutMs
      );
      const readLog = (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop()?.slice(-4096) || '';
        for (const line of lines) {
          const marker = 'listening on http://127.0.0.1:';
          const index = line.indexOf(marker);
          if (index >= 0) {
            const port = Number(line.slice(index + marker.length).trim());
            if (Number.isInteger(port) && port > 0 && port <= 65535) finish(undefined, `http://127.0.0.1:${port}`);
          }
        }
      };
      child.stdout?.on('data', readLog);
      child.stderr?.on('data', readLog);
      child.once('error', (error) => finish(error));
      child.once('exit', (code) => finish(new Error(`${label} server exited before starting (code ${code}).`)));
    });
    return {
      baseUrl, apiKey,
      isRunning: () => child.pid !== undefined && child.exitCode === null && child.signalCode === null,
      stop: () => stopChild(child, label)
    };
  } catch (error) {
    await stopChild(child, label);
    throw error;
  }
}
