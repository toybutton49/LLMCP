import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resetLocalDbToFreshInstall } from '../../server/db/localDatabase';
import {
  materializeLegacyFileRepoEntries,
  readFileRepoDirectory
} from '../../server/routes/fileRepoDirectory';
import { createVaultFileEntry } from '../../src/utils/rag';

async function createTestDirectory(prefix: string): Promise<string> {
  const testDataDirectory = path.join(process.cwd(), '.test-data');
  await fs.mkdir(testDataDirectory, { recursive: true });
  return fs.mkdtemp(path.join(testDataDirectory, prefix));
}

test('File Repo refresh reads Explorer files recursively and indexes OCR sidecars once', async (t) => {
  const root = await createTestDirectory('file-repo-directory-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'policies'), { recursive: true });
  await fs.writeFile(path.join(root, 'policies', 'retention.md'), 'Keep records for seven years.');
  await fs.writeFile(path.join(root, 'invoice.pdf'), 'test PDF bytes');

  let ocrCalls = 0;
  const runOcr = async (filePath: string) => {
    ocrCalls++;
    assert.equal(path.basename(filePath), 'invoice.pdf');
    return 'Invoice total: 12345';
  };
  const first = await readFileRepoDirectory(root, [], 100, runOcr);

  assert.equal(first.ocrCount, 1);
  assert.equal(ocrCalls, 1);
  assert.deepEqual(first.files.map((file) => file.relativePath), [
    'invoice.pdf.ocr.txt',
    'policies/retention.md'
  ]);
  assert.ok(first.files[0].content.includes('Invoice total: 12345'));
  assert.equal(first.files[1].collection, 'policies');
  assert.equal(await fs.readFile(path.join(root, 'invoice.pdf.ocr.txt'), 'utf8'), 'Invoice total: 12345');

  const pinnedFiles = first.files.map((file) => ({ ...file, pinnedInChat: true }));
  const second = await readFileRepoDirectory(root, pinnedFiles, 100, async () => {
    throw new Error('Fresh OCR sidecars must be reused.');
  });
  assert.equal(second.ocrCount, 0);
  assert.equal(second.files.every((file) => file.pinnedInChat), true);
  assert.deepEqual(second.files.map((file) => file.id), first.files.map((file) => file.id));

  await fs.rm(path.join(root, 'policies', 'retention.md'));
  const afterExplorerDelete = await readFileRepoDirectory(root, second.files, 100, runOcr);
  assert.equal(afterExplorerDelete.files.some((file) => file.relativePath === 'policies/retention.md'), false);
  assert.equal(afterExplorerDelete.files.some((file) => file.relativePath === 'invoice.pdf.ocr.txt'), true);
});

test('File Repo refresh fails explicitly for an oversized OCR source', async (t) => {
  const root = await createTestDirectory('file-repo-ocr-limit-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'large.pdf'), 'too large');

  await assert.rejects(
    readFileRepoDirectory(root, [], 4, async () => 'should not run'),
    (error: Error) => error.message.includes('large.pdf') && error.message.includes('4-byte limit')
  );
});

test('empty OCR sidecars are retried instead of suppressing usable extraction', async (t) => {
  const root = await createTestDirectory('file-repo-empty-ocr-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'scan.png');
  const sidecarPath = `${sourcePath}.ocr.txt`;
  await fs.writeFile(sourcePath, 'image bytes');
  await fs.writeFile(sidecarPath, '');
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(sidecarPath, future, future);

  const result = await readFileRepoDirectory(root, [], 100, async () => 'Recovered text');
  assert.equal(result.ocrCount, 1);
  assert.ok(result.files[0].content.includes('Recovered text'));
});

test('legacy database File Repo entries migrate to disk without overwriting Explorer files', async (t) => {
  const root = await createTestDirectory('file-repo-migration-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'existing.md'), 'Explorer version');
  const legacyFiles = [
    createVaultFileEntry({ fileName: 'legacy.md', content: 'Legacy database document.' }),
    createVaultFileEntry({ fileName: 'existing.md', content: 'Old cached copy.' })
  ];

  assert.equal(materializeLegacyFileRepoEntries(root, legacyFiles), 1);
  assert.equal(await fs.readFile(path.join(root, 'legacy.md'), 'utf8'), 'Legacy database document.');
  assert.equal(await fs.readFile(path.join(root, 'existing.md'), 'utf8'), 'Explorer version');
  await fs.writeFile(path.join(root, 'legacy.md'), 'Updated in Explorer.');
  assert.equal(materializeLegacyFileRepoEntries(root, legacyFiles), 0);
  assert.equal(await fs.readFile(path.join(root, 'legacy.md'), 'utf8'), 'Updated in Explorer.');
});

test('resetting the chat database preserves Explorer-managed File Repo files', async (t) => {
  const root = await createTestDirectory('file-repo-reset-');
  const priorDbPath = process.env.LOCAL_DB_PATH;
  const priorRepoPath = process.env.FILE_REPO_DIR;
  t.after(async () => {
    if (priorDbPath === undefined) delete process.env.LOCAL_DB_PATH;
    else process.env.LOCAL_DB_PATH = priorDbPath;
    if (priorRepoPath === undefined) delete process.env.FILE_REPO_DIR;
    else process.env.FILE_REPO_DIR = priorRepoPath;
    await fs.rm(root, { recursive: true, force: true });
  });

  const databaseFile = path.join(root, 'database.json');
  const fileRepoDir = path.join(root, 'file-repo');
  process.env.LOCAL_DB_PATH = path.relative(process.cwd(), databaseFile);
  process.env.FILE_REPO_DIR = path.relative(process.cwd(), fileRepoDir);
  await fs.mkdir(fileRepoDir, { recursive: true });
  const documentPath = path.join(fileRepoDir, 'keep-me.md');
  await fs.writeFile(documentPath, 'This belongs to File Repo.');

  resetLocalDbToFreshInstall();
  assert.equal(await fs.readFile(documentPath, 'utf8'), 'This belongs to File Repo.');
});
