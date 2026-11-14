import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  LLMCP_LOGO_ASSET_PATH,
  LLMCP_MARK_ASSET_PATH,
  LLMCP_OCTOPUS_JPG_PATH,
  LLMCP_WORDMARK_JPG_PATH
} from '../../src/components/layout/LlmcpLogo';
import {
  containsEmojiOrEmDash,
  isAsciiAlphanumeric
} from '../../src/utils/structuredParsers';

const ROOT_DIR = process.cwd();
const MAX_SOURCE_FILE_LINES = 600;

function collectSourceFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === '.git' ||
      entry.name === '.local-data' ||
      entry.name === '.test-data' ||
      entry.name === '.playwright-cli'
    ) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(fullPath, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

function hasWholeWordToken(lowerText: string, word: string): boolean {
  let idx = 0;
  while (idx < lowerText.length) {
    const pos = lowerText.indexOf(word, idx);
    if (pos === -1) return false;
    const prevChar = pos > 0 ? lowerText[pos - 1] : ' ';
    const nextChar =
      pos + word.length < lowerText.length ? lowerText[pos + word.length] : ' ';
    const prevIsWord = isAsciiAlphanumeric(prevChar) || prevChar === '_';
    const nextIsWord = isAsciiAlphanumeric(nextChar) || nextChar === '_';
    if (!prevIsWord && !nextIsWord) {
      return true;
    }
    idx = pos + word.length;
  }
  return false;
}

function hasForbiddenYellowAmberUtility(content: string): boolean {
  const prefixes = [
    'text-amber-',
    'bg-amber-',
    'border-amber-',
    'ring-amber-',
    'from-amber-',
    'to-amber-',
    'via-amber-',
    'text-yellow-',
    'bg-yellow-',
    'border-yellow-',
    'ring-yellow-',
    'from-yellow-',
    'to-yellow-',
    'via-yellow-'
  ];
  for (const p of prefixes) {
    if (content.includes(p)) return true;
  }
  return false;
}

test(`Architecture Hygiene: Every TypeScript file is <= ${MAX_SOURCE_FILE_LINES} lines`, () => {
  const files = [
    ...collectSourceFiles(path.join(ROOT_DIR, 'src'), ['.ts', '.tsx']),
    ...collectSourceFiles(path.join(ROOT_DIR, 'server'), ['.ts', '.tsx']),
    ...collectSourceFiles(path.join(ROOT_DIR, 'dev'), ['.ts', '.tsx']),
    ...collectSourceFiles(path.join(ROOT_DIR, 'scripts'), ['.ts']),
    path.join(ROOT_DIR, 'server.ts'),
    path.join(ROOT_DIR, 'server-db.ts'),
    path.join(ROOT_DIR, 'server-tools.ts')
  ].filter((f) => fs.existsSync(f));

  const violations: string[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n').length;
    if (lines > MAX_SOURCE_FILE_LINES) {
      violations.push(`${path.relative(ROOT_DIR, file)} (${lines} lines)`);
    }
  }

  assert.equal(
    violations.length,
    0,
    `Files exceeding ${MAX_SOURCE_FILE_LINES}-line ceiling:\n${violations.join('\n')}`
  );
});

test('Architecture Hygiene: Zero Emojis, Zero Em-Dashes, Zero Yellow/Amber, Zero External Engines, Zero AIStudio References', () => {
  const files = [
    ...collectSourceFiles(path.join(ROOT_DIR, 'src'), ['.ts', '.tsx', '.css']),
    ...collectSourceFiles(path.join(ROOT_DIR, 'server'), ['.ts']),
    ...collectSourceFiles(path.join(ROOT_DIR, 'scripts'), ['.ts']),
    path.join(ROOT_DIR, 'server.ts'),
    path.join(ROOT_DIR, 'server-db.ts'),
    path.join(ROOT_DIR, 'server-tools.ts'),
    path.join(ROOT_DIR, 'index.html')
  ].filter((f) => fs.existsSync(f));

  for (const file of files) {
    const rel = path.relative(ROOT_DIR, file);
    const content = fs.readFileSync(file, 'utf-8');
    const lower = content.toLowerCase();

    const scan = containsEmojiOrEmDash(content);
    assert.equal(
      scan.hasEmoji,
      false,
      `Forbidden emoji (${scan.codePointHex}) found in ${rel}`
    );
    assert.equal(
      scan.hasEmDash,
      false,
      `Forbidden em-dash (U+2014) found in ${rel}`
    );
    assert.equal(
      hasForbiddenYellowAmberUtility(content),
      false,
      `Forbidden yellow/amber Tailwind utility found in ${rel}`
    );

    const hasExternalEngine =
      hasWholeWordToken(lower, 'lmstudio') ||
      hasWholeWordToken(lower, 'ollama') ||
      lower.includes('lm studio');
    assert.equal(
      hasExternalEngine,
      false,
      `Forbidden external inference engine reference found in ${rel}`
    );

    assert.equal(
      lower.includes('aistudio'),
      false,
      `Forbidden legacy asset/folder reference found in ${rel}`
    );
  }
});

test('Architecture Hygiene: Zero Regular Expressions across src/, server/, and dev/', () => {
  const files = [
    ...collectSourceFiles(path.join(ROOT_DIR, 'src'), ['.ts', '.tsx']),
    ...collectSourceFiles(path.join(ROOT_DIR, 'server'), ['.ts']),
    ...collectSourceFiles(path.join(ROOT_DIR, 'dev'), ['.ts']),
    ...collectSourceFiles(path.join(ROOT_DIR, 'scripts'), ['.ts']),
    path.join(ROOT_DIR, 'server.ts'),
    path.join(ROOT_DIR, 'server-db.ts'),
    path.join(ROOT_DIR, 'server-tools.ts')
  ].filter((f) => fs.existsSync(f));

  // Build forbidden patterns programmatically so this test file itself contains zero literal trigger substrings
  const forbiddenTokens = [
    ['new ', 'RegExp'].join(''),
    ['RegExp', '('].join(''),
    ['.match', '('].join(''),
    ['.matchAll', '('].join(''),
    ['.replace', '(/'].join(''),
    ['.split', '(/'].join('')
  ];

  for (const file of files) {
    const rel = path.relative(ROOT_DIR, file);
    const content = fs.readFileSync(file, 'utf-8');
    for (const token of forbiddenTokens) {
      assert.equal(
        content.includes(token),
        false,
        `Forbidden regex API "${token}" detected in ${rel}`
      );
    }
  }
});

test('Fresh workspace starts with fixed model and endpoint defaults without .env', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmcp-fresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(path.join(ROOT_DIR, 'server', 'config', 'env.ts')).href;
  const script = `import(${JSON.stringify(moduleUrl)}).then(m => console.log(m.APP_ENV.llamaCppBaseUrl, m.ensureModelsDirectory()))`;
  const result = spawnSync(process.execPath, [
    path.join(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '-e', script
  ], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('http://127.0.0.1:8080'));
  assert.ok(fs.statSync(path.join(dir, 'models')).isDirectory());
});

test('Architecture Hygiene: Official user-uploaded JPEG logos are intact in /public/assets/logos/', () => {
  assert.equal(
    LLMCP_OCTOPUS_JPG_PATH,
    '/assets/logos/llmcp-octopus.jpg'
  );
  assert.equal(
    LLMCP_WORDMARK_JPG_PATH,
    '/assets/logos/llmcp-wordmark.jpg'
  );
  assert.equal(LLMCP_MARK_ASSET_PATH, LLMCP_OCTOPUS_JPG_PATH);
  assert.equal(LLMCP_LOGO_ASSET_PATH, LLMCP_WORDMARK_JPG_PATH);

  const octopusDiskPath = path.join(
    ROOT_DIR,
    'public',
    'assets',
    'logos',
    'llmcp-octopus.jpg'
  );
  const wordmarkDiskPath = path.join(
    ROOT_DIR,
    'public',
    'assets',
    'logos',
    'llmcp-wordmark.jpg'
  );

  assert.equal(
    fs.existsSync(octopusDiskPath),
    true,
    'Octopus emblem JPEG exists on disk'
  );
  assert.equal(
    fs.existsSync(wordmarkDiskPath),
    true,
    'Wordmark JPEG exists on disk'
  );
  assert.ok(
    fs.statSync(octopusDiskPath).size > 1000,
    'Octopus emblem JPEG is non-empty'
  );
  assert.ok(
    fs.statSync(wordmarkDiskPath).size > 1000,
    'Wordmark JPEG is non-empty'
  );
});

test('Architecture Hygiene: Zero Glowing Text Wordmarks in the UI (STRICT_IP_RULES Rule 12)', () => {
  const srcFiles = collectSourceFiles(path.join(ROOT_DIR, 'src'), ['.ts', '.tsx']);
  const violations: string[] = [];

  for (const file of srcFiles) {
    const rel = path.relative(ROOT_DIR, file);
    // LlmcpLogo.tsx defines the component props and asset constants; all other UI files must not use wordmark
    if (rel.endsWith('LlmcpLogo.tsx')) continue;

    const content = fs.readFileSync(file, 'utf-8');
    if (content.includes('variant="wordmark"') || content.includes("variant='wordmark'")) {
      violations.push(`${rel}: contains variant="wordmark"`);
    }
    if (content.includes('header-top-middle-text-logo')) {
      violations.push(`${rel}: contains header-top-middle-text-logo`);
    }
  }

  assert.equal(
    violations.length,
    0,
    `Forbidden text wordmarks found in UI:\n${violations.join('\n')}`
  );

  const chatHeaderPath = path.join(ROOT_DIR, 'src', 'components', 'chat', 'ChatHeader.tsx');
  const chatHeaderContent = fs.readFileSync(chatHeaderPath, 'utf-8');
  assert.equal(
    chatHeaderContent.includes('LlmcpLogo'),
    false,
    'ChatHeader.tsx must not import or render LlmcpLogo'
  );
  assert.equal(
    chatHeaderContent.includes('header-top-middle-text-logo'),
    false,
    'ChatHeader.tsx must not contain header-top-middle-text-logo container'
  );

  const appPath = path.join(ROOT_DIR, 'src', 'App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf-8');
  assert.equal(
    appContent.includes('LlmcpLogo'),
    false,
    'App.tsx must not import or render LlmcpLogo'
  );
});
