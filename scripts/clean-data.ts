// Script to wipe all personal data, chats, prompts, RAG DB, File Repo uploads, and memories cleanly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RUNTIME_DEFAULTS } from '../src/data/runtimeDefaults';
import { resetLocalDbToFreshInstall } from '../server/db/localDatabase';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

export interface CleanDataReport {
  removedFiles: string[];
  removedDirs: string[];
  resetDbPath: string;
}

const ROOT_ARTIFACT_PREFIXES = [
  'llmcp-local-db-',
  'llmcp-encrypted-vault-',
  'llmcp-chat-debug-',
  'llmcp-memories-',
  'llmcp-runtime-logs-'
] as const;

const ROOT_TEMP_DIR_PREFIXES = [
  '.ocr-',
  'llmcp-router-'
] as const;

function isInsideRoot(candidate: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

function removeFileIfExists(targetPath: string, root: string, removedFiles: string[]): void {
  if (!isInsideRoot(targetPath, root)) return;
  if (!fs.existsSync(targetPath)) return;
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    fs.rmSync(targetPath, { force: true });
    removedFiles.push(path.relative(root, targetPath).split(path.sep).join('/'));
  }
}

function emptyDirectoryKeepingGitkeep(
  dirPath: string,
  root: string,
  removedFiles: string[],
  removedDirs: string[]
): void {
  if (!isInsideRoot(dirPath, root) || !fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.gitkeep') continue;
    const fullPath = path.join(dirPath, entry.name);
    const relPath = path.relative(root, fullPath).split(path.sep).join('/');
    if (entry.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      removedDirs.push(relPath);
    } else {
      fs.rmSync(fullPath, { force: true });
      removedFiles.push(relPath);
    }
  }
}

export function cleanAllAppData(workspaceRoot: string = PROJECT_ROOT): CleanDataReport {
  const root = path.resolve(workspaceRoot);
  const removedFiles: string[] = [];
  const removedDirs: string[] = [];

  const localDataDir = path.join(root, '.local-data');
  const fileRepoDir = path.join(root, ...RUNTIME_DEFAULTS.fileRepoDir.split('/'));
  const dbFilePath = path.join(root, ...RUNTIME_DEFAULTS.localDbPath.split('/'));
  const vectorDbPath = path.join(path.dirname(dbFilePath), RUNTIME_DEFAULTS.vectorDbFileName);

  // 1. Remove uploaded/OCR File Repo contents (preserving .gitkeep)
  emptyDirectoryKeepingGitkeep(fileRepoDir, root, removedFiles, removedDirs);

  // 2. Remove vector DB, backups, temp files, snapshots, and logs inside .local-data/
  if (fs.existsSync(localDataDir)) {
    const entries = fs.readdirSync(localDataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.gitkeep' || entry.name === 'file-repo') continue;
      const fullPath = path.join(localDataDir, entry.name);
      const relPath = path.relative(root, fullPath).split(path.sep).join('/');
      if (entry.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        removedDirs.push(relPath);
      } else {
        fs.rmSync(fullPath, { force: true });
        removedFiles.push(relPath);
      }
    }
  }

  // Explicitly ensure primary DB, backup, and vector DB paths are removed even if custom-located under root
  removeFileIfExists(vectorDbPath, root, removedFiles);
  removeFileIfExists(`${vectorDbPath}.tmp`, root, removedFiles);
  removeFileIfExists(dbFilePath, root, removedFiles);
  const bakPath = dbFilePath.endsWith('.json')
    ? `${dbFilePath.slice(0, -5)}.bak.json`
    : `${dbFilePath}.bak.json`;
  removeFileIfExists(bakPath, root, removedFiles);
  removeFileIfExists(`${dbFilePath}.tmp`, root, removedFiles);

  // 3. Remove any stray root exports, temp OCR/router directories, or local DB copies
  if (fs.existsSync(root)) {
    const rootEntries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of rootEntries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        if (ROOT_TEMP_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removedDirs.push(entry.name);
        }
      } else if (entry.isFile()) {
        const isArtifact =
          entry.name === 'llmcp-db.json' ||
          entry.name === RUNTIME_DEFAULTS.vectorDbFileName ||
          entry.name.endsWith('.aes.json') ||
          entry.name.endsWith('.bak.json') ||
          ROOT_ARTIFACT_PREFIXES.some((prefix) => entry.name.startsWith(prefix));
        if (isArtifact) {
          fs.rmSync(fullPath, { force: true });
          removedFiles.push(entry.name);
        }
      }
    }
  }

  // 4. Write a clean fresh-install workspace database (zero chats, prompts, RAG docs, files, or memories)
  fs.mkdirSync(fileRepoDir, { recursive: true });
  if (!fs.existsSync(path.join(fileRepoDir, '.gitkeep'))) {
    fs.writeFileSync(path.join(fileRepoDir, '.gitkeep'), '', 'utf-8');
  }
  resetLocalDbToFreshInstall(root === path.resolve(process.cwd()) ? undefined : root);

  return {
    removedFiles: Array.from(new Set(removedFiles)).sort(),
    removedDirs: Array.from(new Set(removedDirs)).sort(),
    resetDbPath: RUNTIME_DEFAULTS.localDbPath
  };
}

const isMainModule =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  const report = cleanAllAppData(PROJECT_ROOT);
  console.log('LLMCP data cleanup complete.');
  console.log(`- Reset workspace database: ${report.resetDbPath}`);
  console.log(`- Removed files (${report.removedFiles.length}): ${report.removedFiles.join(', ') || 'none'}`);
  console.log(`- Removed directories (${report.removedDirs.length}): ${report.removedDirs.join(', ') || 'none'}`);
}
