// Minimal GGUF header reader used to classify model files by their declared metadata instead of their filenames.
import fs from 'fs';

export type GgufRole = 'chat' | 'embedding' | 'projector';

export interface GgufMetadata {
  architecture: string;
  name: string;
  hasPooling: boolean;
  keys: string[];
}

const MAX_KEYS = 4096;
const CHUNK = 1 << 16;
const FIXED_SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const TYPE_UINT32 = 4;
const TYPE_STRING = 8;
const TYPE_ARRAY = 9;
const GGUF_MAGIC = 0x46554747;

export function assertNotLfsPointer(filePath: string): void {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(128);
    const length = fs.readSync(fd, header, 0, header.length, 0);
    if (header.subarray(0, length).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) {
      throw new Error(`Model weights have not been fetched: "${filePath}" is a Git LFS pointer. Run git lfs pull in the LLMCP directory, then retry.`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

class FileReader {
  private buf = Buffer.alloc(0);
  private start = 0;
  pos = 0;
  constructor(private readonly fd: number, private readonly size: number) {}

  private view(len: number): Buffer {
    if (this.pos + len > this.size) throw new Error('GGUF truncated');
    if (this.pos < this.start || this.pos + len > this.start + this.buf.length) {
      const want = Math.min(Math.max(len, CHUNK), this.size - this.pos);
      const next = Buffer.alloc(want);
      fs.readSync(this.fd, next, 0, want, this.pos);
      this.buf = next;
      this.start = this.pos;
    }
    return this.buf.subarray(this.pos - this.start, this.pos - this.start + len);
  }

  u32(): number {
    const v = this.view(4).readUInt32LE(0);
    this.pos += 4;
    return v;
  }

  u64(): number {
    const v = Number(this.view(8).readBigUInt64LE(0));
    this.pos += 8;
    return v;
  }

  skip(n: number): void {
    this.pos += n;
  }

  string(): string {
    const len = this.u64();
    if (len > 1 << 20) {
      this.skip(len);
      return '';
    }
    const s = this.view(len).toString('utf8');
    this.pos += len;
    return s;
  }
}

function skipValue(r: FileReader, type: number): void {
  if (type === TYPE_STRING) {
    r.skip(r.u64());
    return;
  }
  if (type === TYPE_ARRAY) {
    const elemType = r.u32();
    const count = r.u64();
    const fixed = FIXED_SIZES[elemType];
    if (fixed) {
      r.skip(fixed * count);
      return;
    }
    for (let i = 0; i < count; i++) skipValue(r, elemType);
    return;
  }
  const size = FIXED_SIZES[type];
  if (!size) throw new Error(`Unknown GGUF value type ${type}`);
  r.skip(size);
}

export function readGgufMetadata(filePath: string): GgufMetadata | null {
  let fd = -1;
  try {
    fd = fs.openSync(filePath, 'r');
    const r = new FileReader(fd, fs.fstatSync(fd).size);
    if (r.u32() !== GGUF_MAGIC) return null;
    r.u32();
    r.u64();
    const kvCount = Math.min(r.u64(), MAX_KEYS);
    const meta: GgufMetadata = { architecture: '', name: '', hasPooling: false, keys: [] };
    for (let i = 0; i < kvCount; i++) {
      const key = r.string();
      const type = r.u32();
      meta.keys.push(key);
      if (key === 'general.architecture' && type === TYPE_STRING) meta.architecture = r.string();
      else if (key === 'general.name' && type === TYPE_STRING) meta.name = r.string();
      else if (key.endsWith('.pooling_type') && type === TYPE_UINT32) {
        meta.hasPooling = true;
        r.skip(4);
      } else skipValue(r, type);
    }
    return meta;
  } catch {
    return null;
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
}

/** Returns null when the file has no readable GGUF metadata so callers can fall back. */
export function classifyGgufRole(filePath: string): GgufRole | null {
  const meta = readGgufMetadata(filePath);
  if (!meta || !meta.architecture) return null;
  if (meta.architecture === 'clip' || meta.keys.some((k) => k.startsWith('clip.'))) return 'projector';
  if (meta.hasPooling) return 'embedding';
  return 'chat';
}
