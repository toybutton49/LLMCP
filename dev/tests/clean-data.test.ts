import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanAllAppData } from '../../scripts/clean-data';

test('cleanAllAppData removes personal chats, prompts, RAG docs, vector DB, File Repo uploads, and memories', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'llmcp-clean-data-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const localDataDir = path.join(sandbox, '.local-data');
  const fileRepoDir = path.join(localDataDir, 'file-repo');
  fs.mkdirSync(path.join(fileRepoDir, 'nested-folder'), { recursive: true });
  fs.writeFileSync(path.join(localDataDir, '.gitkeep'), '', 'utf-8');
  fs.writeFileSync(path.join(fileRepoDir, '.gitkeep'), '', 'utf-8');

  // Seed personal data across DB, backup, vector DB, File Repo, and stray exports
  fs.writeFileSync(
    path.join(localDataDir, 'llmcp-db.json'),
    JSON.stringify({
      vaultMasterHash: 'hashed-secret',
      vaultLocked: true,
      sessions: [{ id: 'sess_private', title: 'Private Taxes', messageCount: 2 }],
      messagesBySession: {
        sess_private: [
          { id: 'm1', role: 'user', content: 'My SSN is secret' },
          { id: 'm2', role: 'assistant', content: 'Noted' }
        ]
      },
      ragDocuments: [{ id: 'rag1', title: 'Personal Contract', content: 'Private terms' }],
      vaultFiles: [{ id: 'vf1', name: 'tax.pdf', content: '2026 taxes' }],
      memories: [{ id: 'mem1', key: 'Address', fact: '123 Private Ln', isActive: true }],
      promptTemplates: [{ id: 'custom_prompt', name: 'Custom Prompt', systemPrompt: 'Secret instructions', defaultTemperature: 0.5 }]
    }),
    'utf-8'
  );
  fs.writeFileSync(path.join(localDataDir, 'llmcp-db.bak.json'), '{"backup":true}', 'utf-8');
  fs.writeFileSync(path.join(localDataDir, 'octo-vector-db.json'), '{"records":[{"id":"v1"}]}', 'utf-8');
  fs.writeFileSync(path.join(fileRepoDir, 'tax.pdf'), 'binary-data', 'utf-8');
  fs.writeFileSync(path.join(fileRepoDir, 'nested-folder', 'notes.ocr.txt'), 'private ocr text', 'utf-8');
  fs.writeFileSync(path.join(sandbox, 'llmcp-chat-debug-export.json'), '{}', 'utf-8');
  fs.mkdirSync(path.join(sandbox, '.ocr-tmp-123'), { recursive: true });

  const report = cleanAllAppData(sandbox);

  assert.equal(fs.existsSync(path.join(localDataDir, '.gitkeep')), true);
  assert.equal(fs.existsSync(path.join(fileRepoDir, '.gitkeep')), true);
  assert.equal(fs.existsSync(path.join(fileRepoDir, 'tax.pdf')), false);
  assert.equal(fs.existsSync(path.join(fileRepoDir, 'nested-folder')), false);
  assert.equal(fs.existsSync(path.join(localDataDir, 'llmcp-db.bak.json')), false);
  assert.equal(fs.existsSync(path.join(localDataDir, 'octo-vector-db.json')), false);
  assert.equal(fs.existsSync(path.join(sandbox, 'llmcp-chat-debug-export.json')), false);
  assert.equal(fs.existsSync(path.join(sandbox, '.ocr-tmp-123')), false);
  assert.ok(report.removedFiles.includes('.local-data/octo-vector-db.json'));
  assert.ok(report.removedFiles.includes('.local-data/file-repo/tax.pdf'));

  const resetDb = JSON.parse(fs.readFileSync(path.join(localDataDir, 'llmcp-db.json'), 'utf-8'));
  assert.equal(resetDb.vaultMasterHash, null);
  assert.equal(resetDb.vaultLocked, false);
  assert.deepEqual(resetDb.ragDocuments, []);
  assert.deepEqual(resetDb.vaultFiles, []);
  assert.deepEqual(resetDb.memories, []);
  assert.equal(resetDb.sessions.length, 1);
  assert.equal(resetDb.sessions[0].title, 'New Chat');
  assert.deepEqual(resetDb.messagesBySession[resetDb.sessions[0].id], []);
  assert.equal(
    resetDb.promptTemplates.some((p: { id: string }) => p.id === 'custom_prompt'),
    false
  );
});

test('clean-data.ps1 PowerShell wrapper and scripts/clean-data.ts run cleanly from project root and scripts folder', () => {
  const ps1Path = path.resolve(process.cwd(), 'clean-data.ps1');
  assert.equal(fs.existsSync(ps1Path), true);
  const content = fs.readFileSync(ps1Path, 'utf-8');
  assert.ok(content.includes('Push-Location -LiteralPath $PSScriptRoot'));
  assert.ok(content.includes('scripts/clean-data.ts'));
  assert.ok(content.includes('Dependencies are missing'));

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'llmcp-scripts-cwd-'));
  try {
    const scriptsDir = path.join(sandbox, 'scripts');
    const localDataDir = path.join(sandbox, '.local-data');
    const fileRepoDir = path.join(localDataDir, 'file-repo');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(fileRepoDir, { recursive: true });
    fs.writeFileSync(path.join(localDataDir, '.gitkeep'), '', 'utf-8');
    fs.writeFileSync(path.join(fileRepoDir, '.gitkeep'), '', 'utf-8');
    fs.writeFileSync(path.join(fileRepoDir, 'ephemeral.txt'), 'secret', 'utf-8');
    fs.writeFileSync(path.join(sandbox, 'package.json'), '{"name":"sandbox"}', 'utf-8');
    fs.writeFileSync(path.join(sandbox, 'server.ts'), '// stub', 'utf-8');

    const tsxCli = path.resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const cleanScriptModule = path.resolve(process.cwd(), 'scripts', 'clean-data.ts');
    const res = spawnSync(
      process.execPath,
      [
        tsxCli,
        '-e',
        `import { cleanAllAppData } from ${JSON.stringify(cleanScriptModule)}; const r = cleanAllAppData(${JSON.stringify(sandbox)}); console.log(JSON.stringify(r));`
      ],
      { cwd: scriptsDir, encoding: 'utf-8', timeout: 20000 }
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(path.join(fileRepoDir, 'ephemeral.txt')), false);
    assert.equal(fs.existsSync(path.join(scriptsDir, 'models')), false);
    assert.equal(fs.existsSync(path.join(localDataDir, 'llmcp-db.json')), true);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
