// Robust CUID (Collision-Resistant Unique Identifier) & Tag Engine
// Zero Regex, Pure Character/Base36 Arithmetic & Monotonic Counter

let globalCounter = 0;
const CLIENT_FINGERPRINT = (function generateFingerprint(): string {
  let val = 0;
  if (typeof process !== 'undefined' && process.pid) {
    val = (val * 31 + process.pid) & 0xffffff;
  }
  const entropy = Math.floor(Math.random() * 0xffffff);
  val = (val ^ entropy) & 0xffffff;
  return val.toString(36).padStart(4, '0');
})();

function padBase36(num: number, targetLength: number): string {
  const str = Math.abs(num).toString(36);
  if (str.length >= targetLength) return str.slice(-targetLength);
  let pad = '';
  for (let i = str.length; i < targetLength; i++) {
    pad += '0';
  }
  return pad + str;
}

function getRandomEntropyBlock(length: number): string {
  let out = '';
  while (out.length < length) {
    const chunk = Math.floor(Math.random() * 0xffffff).toString(36);
    out += chunk;
  }
  return out.slice(0, length);
}

/**
 * Generates a collision-resistant unique identifier:
 * Prefix 'c' + 8-char base36 timestamp + 4-char monotonic counter + 4-char process fingerprint + 8-char random entropy.
 */
export function createCuid(): string {
  const timestamp = Date.now();
  const timeBlock = padBase36(timestamp, 8);
  globalCounter = (globalCounter + 1) % 0x10000;
  const countBlock = padBase36(globalCounter, 4);
  const entropyBlock = getRandomEntropyBlock(8);
  return `c${timeBlock}${countBlock}${CLIENT_FINGERPRINT}${entropyBlock}`;
}

/**
 * Generates a scoped CUID tag for indexing and relational lookups across context units.
 * Example: createCuidTag('mem', 'baseball') => 'cuid:mem:c...'
 */
export function createCuidTag(domain: string, entityLabel?: string, existingCuid?: string): string {
  const cuid = existingCuid && isCuid(existingCuid) ? existingCuid : createCuid();
  const cleanDomain = (domain || 'ctx').trim().toLowerCase();
  if (entityLabel && typeof entityLabel === 'string') {
    const cleanLabel = entityLabel.trim().toLowerCase().replaceAll(' ', '-').slice(0, 24);
    return `cuid:${cleanDomain}:${cleanLabel}:${cuid}`;
  }
  return `cuid:${cleanDomain}:${cuid}`;
}

export function isCuid(val: string): boolean {
  if (typeof val !== 'string' || val.length < 20 || val[0] !== 'c') {
    return false;
  }
  for (let i = 1; i < val.length; i++) {
    const code = val.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    const isLower = code >= 97 && code <= 122;
    if (!isDigit && !isLower) return false;
  }
  return true;
}

export function extractCuidFromTag(tag: string): string | null {
  if (!tag || typeof tag !== 'string') return null;
  const parts = tag.split(':');
  const last = parts[parts.length - 1];
  return isCuid(last) ? last : null;
}

