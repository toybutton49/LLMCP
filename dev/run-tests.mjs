import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests must never read or overwrite the developer's real workspace in .local-data or ./models.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.test-data');
fs.mkdirSync(dataDir, { recursive: true });
const sandbox = fs.mkdtempSync(path.join(dataDir, 'test-run-'));

const testsDir = path.join(root, 'dev', 'tests');
const files = fs.readdirSync(testsDir).filter((name) => name.endsWith('.test.ts')).map((name) => path.join('dev', 'tests', name));
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
try {
  const result = spawnSync(process.execPath, [tsx, '--test', ...files], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      LOCAL_DB_PATH: path.relative(root, path.join(sandbox, 'llmcp-db.json')),
      FILE_REPO_DIR: path.relative(root, path.join(sandbox, 'file-repo')),
      LLMCP_VECTOR_DB_PATH: path.join(sandbox, 'octo-vector-db.json')
    }
  });
  if (result.error) console.error('Unable to run tests:', result.error);
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
  try {
    if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length === 0) {
      fs.rmdirSync(dataDir);
    }
  } catch {}
}
