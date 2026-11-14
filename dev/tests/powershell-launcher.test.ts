import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('Windows launcher runs from scripts/ folder and arbitrary cwd and propagates errors', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmcp-launcher-'));
  try {
    const scriptsDir = path.join(root, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const script = path.join(scriptsDir, 'start-llmcp.ps1');
    fs.copyFileSync(path.resolve('scripts', 'start-llmcp.ps1'), script);
    const run = (cwd: string, ...args: string[]) => spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args
    ], { cwd, encoding: 'utf8', timeout: 15000 });

    const missing = run(os.tmpdir());
    assert.notEqual(missing.status, 0);
    assert.ok(missing.stderr.includes('Dependencies are missing'));
    const bin = path.join(root, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'tsx.cmd'), '@echo off\r\necho WORKDIR=%CD%\r\necho ARGS=%*\r\nexit /b 17\r\n');
    for (const cwd of [os.tmpdir(), root, scriptsDir]) {
      for (const [args, expectedPort] of [[[], 3000], [['-Port', '3000'], 3000], [['-Port', '3333'], 3333]] as Array<[string[], number]>) {
        const result = run(cwd, ...args);
        assert.equal(result.status, 17, result.stderr);
        assert.ok(result.stdout.includes(`WORKDIR=${root}`));
        assert.ok(result.stdout.includes(`ARGS=server.ts --port ${expectedPort}`));
      }
    }
    const withHost = run(scriptsDir, '-Port', '3456', '-HostAddress', '0.0.0.0');
    assert.equal(withHost.status, 17, withHost.stderr);
    assert.ok(withHost.stdout.includes(`WORKDIR=${root}`));
    assert.ok(withHost.stdout.includes('ARGS=server.ts --port 3456 --host 0.0.0.0'));

    const invalid = run(scriptsDir, '-Port', '80');
    assert.notEqual(invalid.status, 0);
    assert.ok(!invalid.stdout.includes('WORKDIR='));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
