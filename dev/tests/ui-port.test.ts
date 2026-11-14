import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build as viteBuild } from 'vite';
import { APP_ENV, UI_PORT, validateBindHost, validateUiPort } from '../../server/config/env';
import {
  createNetworkAccessMiddleware,
  isAllowedClientIp,
  isAllowedHostHeader,
  isAllowedOriginHeader
} from '../../server/config/networkAccess';

test('UI port configuration defaults to 3000, accepts valid user ports, and rejects invalid ports', () => {
  assert.equal(validateUiPort([], undefined), UI_PORT);
  for (const [args, env, expected] of [
    [[], undefined, 3000],
    [['--port', '3000'], '3000', 3000],
    [['-p', '3333'], undefined, 3333],
    [['--port=4173'], '3000', 4173],
    [[], '5174', 5174]
  ] as Array<[string[], string | undefined, number]>) {
    assert.equal(validateUiPort(args, env), expected);
  }
  for (const [args, env] of [
    [['-p'], undefined],
    [['--port', '80'], undefined],
    [['--port=70000'], undefined],
    [[], '80'],
    [[], 'invalid']
  ] as Array<[string[], string | undefined]>) {
    assert.throws(
      () => validateUiPort(args, env),
      (error: Error) => error.message.includes('1024') && error.message.includes('65535')
    );
  }
});

test('workspace dotenv files do not override the server or Vite environment', (t) => {
  const root = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmcp-env-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.local-data'));
  fs.writeFileSync(path.join(dir, '.env'),
    'LOCAL_DB_PATH=.local-data/user.json\nFILE_REPO_DIR=.local-data/user-files\nLLMCP_VECTOR_DB_PATH=.local-data/user-vectors.json\nVITE_LLMCP_DOTENV_PROBE=unexpected\n');
  fs.writeFileSync(path.join(dir, '.env.local'), 'VITE_LLMCP_LOCAL_PROBE=unexpected\n');
  const userDb = path.join(dir, '.local-data', 'user.json');
  fs.writeFileSync(userDb, 'untouched');
  const envModule = pathToFileURL(path.join(root, 'server', 'config', 'env.ts')).href;
  const dbModule = pathToFileURL(path.join(root, 'server', 'db', 'localDatabase.ts')).href;
  const loader = pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  const viteModule = pathToFileURL(path.join(root, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href;
  const viteConfig = pathToFileURL(path.join(root, 'vite.config.ts')).href;
  const env = {
    ...process.env, LOCAL_DB_PATH: '.local-data/test/db.json',
    FILE_REPO_DIR: '.local-data/test/files', LLMCP_VECTOR_DB_PATH: '.local-data/test/vectors.json',
    VITE_LLMCP_DOTENV_PROBE: undefined, VITE_LLMCP_LOCAL_PROBE: undefined
  };
  const script = `const { APP_ENV } = await import(${JSON.stringify(envModule)});` +
    `const { ensureLocalDb, saveLocalDb } = await import(${JSON.stringify(dbModule)}); saveLocalDb(ensureLocalDb());` +
    `const { resolveConfig } = await import(${JSON.stringify(viteModule)});` +
    `const { default: config } = await import(${JSON.stringify(viteConfig)});` +
    `const vite = await resolveConfig({ ...config(), configFile: false, root: process.cwd() }, 'serve');` +
    `console.log(JSON.stringify({ db: APP_ENV.localDbPath, files: APP_ENV.fileRepoDir, vectors: process.env.LLMCP_VECTOR_DB_PATH, viteEnv: vite.env }));`;
  const result = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', script], {
    cwd: dir, env, encoding: 'utf8', timeout: 20000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout.trim().split('\n').at(-1) || '');
  assert.equal(actual.db, '.local-data/test/db.json');
  assert.equal(actual.files, '.local-data/test/files');
  assert.equal(actual.vectors, '.local-data/test/vectors.json');
  assert.equal(actual.viteEnv.VITE_LLMCP_DOTENV_PROBE, undefined);
  assert.equal(actual.viteEnv.VITE_LLMCP_LOCAL_PROBE, undefined);
  assert.ok(fs.existsSync(path.join(dir, '.local-data', 'test', 'db.json')));
  assert.equal(fs.readFileSync(userDb, 'utf8'), 'untouched');
});

test('Vite Rolldown codeSplitting produces bounded acyclic production chunks and handles Windows paths', async () => {
  const root = process.cwd();
  const configMod = await import(pathToFileURL(path.join(root, 'vite.config.ts')).href);
  const resolved = configMod.default();
  const output = resolved.build?.rolldownOptions?.output;
  assert.ok(output && !Array.isArray(output) && typeof output.codeSplitting === 'object');

  const groups = new Map<string, (id: string) => boolean | void | undefined>(
    (output.codeSplitting.groups ?? []).map((group: { name: string; test?: (id: string) => boolean | void | undefined }) => [
      group.name,
      group.test ?? (() => false),
    ])
  );
  assert.equal(groups.get('react-vendor')?.('C:\\repo\\node_modules\\react-dom\\client.js'), true);
  assert.equal(groups.get('react-vendor')?.('C:\\repo\\node_modules\\lucide-react\\dist\\esm\\index.js'), false);
  assert.equal(groups.get('ui-vendor')?.('C:\\repo\\node_modules\\lucide-react\\dist\\esm\\index.js'), true);
  assert.equal(groups.get('vendor')?.('\0rolldown/runtime.js'), false);
  assert.equal(groups.get('workspace-core')?.(path.join(root, 'src', 'orchestrators', 'chatOrchestrator.ts')), true);
  assert.equal(groups.get('workspace-core')?.('C:\\Users\\dev\\src\\utils\\other-repo\\src\\App.tsx'), false);

  const buildResult = await viteBuild({
    configFile: path.join(root, 'vite.config.ts'),
    logLevel: 'silent',
    build: { write: false },
  });
  const firstOutput = Array.isArray(buildResult) ? buildResult[0] : buildResult;
  assert.ok('output' in firstOutput, 'Expected Rollup/Rolldown build output');

  const chunks = firstOutput.output.filter((item) => item.type === 'chunk');
  const chunkNames = chunks.map((chunk) => chunk.name);
  for (const expectedName of ['index', 'react-vendor', 'ui-vendor', 'workspace-core', 'workspace-views']) {
    assert.ok(chunkNames.includes(expectedName), `Expected chunk "${expectedName}" in [${chunkNames.join(', ')}]`);
  }

  const maxChunkBytes = 500 * 1024;
  const importsByFile = new Map<string, string[]>();
  for (const chunk of chunks) {
    assert.ok(
      Buffer.byteLength(chunk.code, 'utf8') < maxChunkBytes,
      `Chunk ${chunk.fileName} exceeded 500 KiB`
    );
    importsByFile.set(chunk.fileName, chunk.imports);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const assertAcyclic = (fileName: string) => {
    assert.equal(visiting.has(fileName), false, `Circular chunk import detected involving ${fileName}`);
    if (visited.has(fileName)) return;
    visiting.add(fileName);
    for (const dep of importsByFile.get(fileName) ?? []) {
      assertAcyclic(dep);
    }
    visiting.delete(fileName);
    visited.add(fileName);
  };
  for (const fileName of importsByFile.keys()) {
    assertAcyclic(fileName);
  }
});

test('LAN and Tailscale network policy permits loopback, RFC1918 LAN, and Tailscale while blocking public internet and DNS rebinding', () => {
  assert.equal(validateBindHost([], undefined), '0.0.0.0');
  assert.equal(validateBindHost(['--host', '127.0.0.1'], undefined), '127.0.0.1');
  assert.equal(validateBindHost(['--host=10.0.0.233'], undefined), '10.0.0.233');
  assert.equal(validateBindHost([], '100.123.24.121'), '100.123.24.121');
  assert.throws(() => validateBindHost(['--host', '8.8.8.8'], undefined));
  assert.throws(() => validateBindHost(['--host'], undefined));

  // Allowed client IPs: loopback, home LAN (RFC1918), Tailscale CGNAT (100.64.0.0/10), IPv6 ULA
  for (const allowedIp of [
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '10.0.0.233',
    '::ffff:10.0.0.45',
    '192.168.1.25',
    '172.16.5.9',
    '172.31.255.254',
    '100.123.24.121',
    '100.64.0.1',
    '100.127.255.254',
    'fd7a:115c:a1e0::1',
    'fe80::1%14'
  ]) {
    assert.equal(isAllowedClientIp(allowedIp), true, `Expected ${allowedIp} to be allowed`);
  }

  // Blocked public and metadata IPs
  for (const blockedIp of [
    '8.8.8.8',
    '1.1.1.1',
    '169.254.169.254',
    '100.63.255.255',
    '100.128.0.1',
    '172.32.0.1',
    '2001:4860:4860::8888'
  ]) {
    assert.equal(isAllowedClientIp(blockedIp), false, `Expected ${blockedIp} to be blocked`);
  }

  // Allowed Host & Origin headers (LAN IP, Tailscale IP, Tailscale MagicDNS, local hostname)
  assert.equal(isAllowedHostHeader('localhost:3000', 'workstation'), true);
  assert.equal(isAllowedHostHeader('10.0.0.233:3000', 'workstation'), true);
  assert.equal(isAllowedHostHeader('100.123.24.121:3000', 'workstation'), true);
  assert.equal(isAllowedHostHeader('workstation:3000', 'workstation'), true);
  assert.equal(isAllowedHostHeader('workstation.local:3000', 'workstation'), true);
  assert.equal(isAllowedHostHeader('workstation.tailnet.ts.net:3000', 'workstation'), true);
  assert.equal(isAllowedHostHeader('evil.example.com:3000', 'workstation'), false);

  assert.equal(isAllowedOriginHeader('http://10.0.0.233:3000', 'workstation'), true);
  assert.equal(isAllowedOriginHeader('http://100.123.24.121:3000', 'workstation'), true);
  assert.equal(isAllowedOriginHeader('https://workstation.tailnet.ts.net', 'workstation'), true);
  assert.equal(isAllowedOriginHeader('https://evil.example.com', 'workstation'), false);

  // Middleware enforcement check
  const guard = createNetworkAccessMiddleware('workstation');
  const invoke = (remoteAddress: string, host: string, pathName: string, origin?: string) => {
    let statusCode = 200;
    let passed = false;
    const headers: Record<string, string> = { host };
    if (origin !== undefined) headers.origin = origin;
    guard(
      {
        socket: { remoteAddress },
        headers,
        path: pathName
      } as never,
      {
        setHeader: () => undefined,
        status(code: number) {
          statusCode = code;
          return this;
        },
        json: () => undefined
      } as never,
      () => {
        passed = true;
      }
    );
    return { statusCode, passed };
  };

  assert.deepEqual(invoke('::ffff:10.0.0.50', '10.0.0.233:3000', '/api/tts/status', 'http://10.0.0.233:3000'), {
    statusCode: 200,
    passed: true
  });
  assert.deepEqual(invoke('::ffff:100.101.2.3', '100.123.24.121:3000', '/api/chat/stream', 'http://100.123.24.121:3000'), {
    statusCode: 200,
    passed: true
  });
  assert.deepEqual(invoke('203.0.113.10', '10.0.0.233:3000', '/'), {
    statusCode: 403,
    passed: false
  });
  assert.deepEqual(invoke('::ffff:10.0.0.50', 'rebind-attacker.com:3000', '/api/local-db'), {
    statusCode: 403,
    passed: false
  });
  assert.deepEqual(invoke('::ffff:10.0.0.50', '10.0.0.233:3000', '/api/local-db/sync', 'https://attacker.com'), {
    statusCode: 403,
    passed: false
  });
});
