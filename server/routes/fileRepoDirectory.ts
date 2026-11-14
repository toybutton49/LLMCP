import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createVaultFileEntry, type VaultFileEntry } from '../../src/utils/rag';

const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.csv', '.go', '.h', '.html', '.ini',
  '.java', '.js', '.json', '.jsx', '.kt', '.log', '.md', '.mjs', '.py',
  '.rs', '.sh', '.sql', '.swift', '.toml', '.ts', '.tsx', '.txt', '.xml',
  '.yaml', '.yml'
]);
const OCR_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp']);
const IGNORED_DIRECTORIES = new Set([
  '.git', 'build', 'coverage', 'dist', 'node_modules', '.next', '.test-data'
]);
const MAX_TEXT_FILE_BYTES = 512 * 1024;
const MAX_DIRECTORY_DEPTH = 6;

interface DiskFile {
  fullPath: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
}

function listFiles(root: string): DiskFile[] {
  const files: DiskFile[] = [];

  const walk = (directory: string, depth: number) => {
    if (depth > MAX_DIRECTORY_DEPTH) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === '.gitkeep') continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const extension = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(extension) && !OCR_EXTENSIONS.has(extension)) continue;
      const stat = fs.statSync(fullPath);
      files.push({
        fullPath,
        relativePath: path.relative(root, fullPath).replaceAll('\\', '/'),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
    }
  };

  walk(root, 0);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function fileId(relativePath: string): string {
  return `file_${createHash('sha256').update(relativePath.toLowerCase()).digest('hex').slice(0, 20)}`;
}

function makeEntry(
  relativePath: string,
  content: string,
  sizeBytes: number,
  modifiedAt: string,
  previousByPath: Map<string, VaultFileEntry>
): VaultFileEntry {
  const normalizedPath = relativePath.replaceAll('\\', '/');
  const previous = previousByPath.get(normalizedPath.toLowerCase());
  const parent = path.posix.dirname(normalizedPath);
  const entry = createVaultFileEntry({
    id: previous?.id || fileId(normalizedPath),
    fileName: path.posix.basename(normalizedPath),
    relativePath: normalizedPath,
    collection: previous?.collection || (parent === '.' ? 'File Repo' : parent),
    content,
    sizeBytes,
    pinnedInChat: previous?.pinnedInChat ?? false,
    createdAt: previous?.createdAt || modifiedAt
  });
  return { ...entry, updatedAt: modifiedAt };
}

export async function readFileRepoDirectory(
  root: string,
  existingFiles: VaultFileEntry[],
  maxOcrBytes: number,
  runOcr: (filePath: string) => Promise<string>
): Promise<{ files: VaultFileEntry[]; ocrCount: number }> {
  const absoluteRoot = path.resolve(root);
  const previousByPath = new Map(
    existingFiles.map((file) => [
      (file.relativePath || file.fileName).replaceAll('\\', '/').toLowerCase(),
      file
    ])
  );
  const diskFiles = listFiles(absoluteRoot);
  const diskPaths = new Set(diskFiles.map((file) => file.relativePath.toLowerCase()));
  const entries: VaultFileEntry[] = [];
  let ocrCount = 0;

  for (const file of diskFiles) {
    const extension = path.extname(file.fullPath).toLowerCase();
    const relativePathLower = file.relativePath.toLowerCase();
    if (relativePathLower.endsWith('.ocr.txt')) {
      const originalPath = relativePathLower.slice(0, -'.ocr.txt'.length);
      if (diskPaths.has(originalPath)) continue;
    }

    if (OCR_EXTENSIONS.has(extension)) {
      if (file.sizeBytes > maxOcrBytes) {
        throw new Error(
          `File Repo OCR file "${file.relativePath}" exceeds the ${maxOcrBytes}-byte limit.`
        );
      }
      const sidecarPath = `${file.fullPath}.ocr.txt`;
      const sidecarRelativePath = `${file.relativePath}.ocr.txt`;
      let text: string;
      let sidecarStat = fs.existsSync(sidecarPath) ? fs.statSync(sidecarPath) : undefined;

      if (sidecarStat && sidecarStat.mtimeMs >= fs.statSync(file.fullPath).mtimeMs) {
        text = fs.readFileSync(sidecarPath, 'utf8');
      } else {
        text = '';
      }
      if (!text.trim()) {
        text = (await runOcr(file.fullPath)).trim();
        if (!text) throw new Error(`OCR returned no text for "${file.relativePath}".`);
        const temporaryPath = `${sidecarPath}.${process.pid}.tmp`;
        fs.writeFileSync(temporaryPath, text, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temporaryPath, sidecarPath);
        sidecarStat = fs.statSync(sidecarPath);
        ocrCount++;
      }
      if (text.trim()) {
        entries.push(makeEntry(
          sidecarRelativePath,
          `Extracted text from ${path.posix.basename(file.relativePath)}:\n\n${text}`,
          sidecarStat?.size ?? Buffer.byteLength(text, 'utf8'),
          sidecarStat?.mtime.toISOString() ?? file.modifiedAt,
          previousByPath
        ));
      }
      continue;
    }

    if (file.sizeBytes > MAX_TEXT_FILE_BYTES) continue;
    const content = fs.readFileSync(file.fullPath, 'utf8');
    entries.push(makeEntry(
      file.relativePath,
      content,
      file.sizeBytes,
      file.modifiedAt,
      previousByPath
    ));
  }

  return { files: entries, ocrCount };
}

export function materializeLegacyFileRepoEntries(
  root: string,
  files: VaultFileEntry[]
): number {
  const absoluteRoot = path.resolve(root);
  fs.mkdirSync(absoluteRoot, { recursive: true });
  let migratedCount = 0;

  for (const file of files) {
    if (
      file.relativePath ||
      file.isBinary ||
      file.content.startsWith('[Binary Media:') ||
      file.content.startsWith('[Attached Binary Media:')
    ) continue;
    const fileName = path.basename(file.fileName);
    if (!fileName || fileName.startsWith('.')) continue;
    const targetPath = path.join(absoluteRoot, fileName);
    if (fs.existsSync(targetPath)) continue;
    fs.writeFileSync(targetPath, file.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    migratedCount++;
  }

  return migratedCount;
}
