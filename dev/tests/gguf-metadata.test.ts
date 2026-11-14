import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyGgufRole, readGgufMetadata } from '../../server/db/ggufMetadata';

function str(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(body.length));
  return Buffer.concat([len, body]);
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

function u64(value: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

function writeGguf(name: string, kvs: Buffer[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-meta-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(kvs.length), ...kvs]));
  return file;
}

const archKv = (arch: string) => Buffer.concat([str('general.architecture'), u32(8), str(arch)]);
const tokensKv = Buffer.concat([str('tokenizer.ggml.tokens'), u32(9), u32(8), u64(2), str('a'), str('bc')]);

test('GGUF role comes from metadata, not the filename', () => {
  const projector = writeGguf('model.gguf', [archKv('clip')]);
  const embedding = writeGguf('chat-sounding.gguf', [
    archKv('bert'),
    tokensKv,
    Buffer.concat([str('bert.pooling_type'), u32(4), u32(1)])
  ]);
  const chat = writeGguf('mmproj-looking.gguf', [archKv('llama'), tokensKv]);
  try {
    assert.equal(classifyGgufRole(projector), 'projector');
    assert.equal(classifyGgufRole(embedding), 'embedding');
    assert.equal(readGgufMetadata(embedding)?.architecture, 'bert');
    assert.equal(classifyGgufRole(chat), 'chat');
  } finally {
    for (const f of [projector, embedding, chat]) fs.rmSync(path.dirname(f), { recursive: true, force: true });
  }
});

test('GGUF classification returns null for non-GGUF files', () => {
  const file = writeGguf('bad.gguf', []);
  fs.writeFileSync(file, 'not a gguf');
  try {
    assert.equal(classifyGgufRole(file), null);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
