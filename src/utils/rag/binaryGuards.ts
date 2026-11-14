// Deterministic Binary and Image Media Guards (Zero Regex)

export const BINARY_AND_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'avif', 'svg',
  'pdf', 'zip', 'tar', 'gz', '7z', 'rar', 'bin', 'exe', 'dll', 'so', 'dylib', 'wasm',
  'iso', 'dmg', 'pkg', 'deb', 'rpm', 'dat', 'img', 'apk',
  'mp3', 'mp4', 'wav', 'ogg', 'mov', 'avi', 'mkv', 'flac', 'webm', 'm4a', 'aac',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pyc', 'pyd', 'class', 'o', 'obj', 'node', 'gguf'
]);

export function isBinaryOrImageExtension(fileName: string): boolean {
  if (!fileName) return false;
  const trimmed = fileName.trim();
  const dotIdx = trimmed.lastIndexOf('.');
  if (dotIdx === -1 || dotIdx === trimmed.length - 1) return false;
  const ext = trimmed.slice(dotIdx + 1).toLowerCase();
  return BINARY_AND_IMAGE_EXTENSIONS.has(ext);
}

export function isBinaryMimeType(mimeType?: string): boolean {
  if (!mimeType) return false;
  const m = mimeType.trim().toLowerCase();
  return (
    m.startsWith('image/') ||
    m.startsWith('video/') ||
    m.startsWith('audio/') ||
    m.startsWith('application/pdf') ||
    m.startsWith('application/zip') ||
    m.startsWith('application/x-zip') ||
    m.startsWith('application/x-tar') ||
    m.startsWith('application/gzip') ||
    m.startsWith('application/octet-stream') ||
    m.includes('binary')
  );
}

export function isBinaryContent(content: string): boolean {
  if (!content) return false;
  const checkLen = Math.min(content.length, 8192);
  let controlChars = 0;
  for (let i = 0; i < checkLen; i++) {
    const code = content.charCodeAt(i);
    if (code === 0 || code === 0xfffd) return true;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 27) {
      controlChars++;
      if (controlChars > 1) return true;
    }
  }
  return false;
}

export function isBinaryOrImageFile(
  fileName: string,
  mimeType?: string,
  content?: string
): boolean {
  if (isBinaryOrImageExtension(fileName)) return true;
  if (isBinaryMimeType(mimeType)) return true;
  if (content && isBinaryContent(content)) return true;
  return false;
}
