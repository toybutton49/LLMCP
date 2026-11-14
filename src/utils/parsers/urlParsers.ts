// Deterministic URL and IPv4 address scanners and loopback guards
import { isAsciiDigit, isWhitespaceChar, hasControlCharacters } from './textScanners';

export function parseIpv4Octets(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return null;
    for (let i = 0; i < part.length; i++) {
      if (!isAsciiDigit(part[i])) return null;
    }
    const val = Number(part);
    if (!Number.isInteger(val) || val < 0 || val > 255) return null;
    octets.push(val);
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

export function validateLoopbackUrl(
  rawUrl: string,
  fallback = 'http://127.0.0.1:1234'
): { valid: boolean; sanitizedUrl: string; error?: string } {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) {
    return { valid: false, sanitizedUrl: fallback, error: 'Endpoint URL cannot be empty.' };
  }
  if (hasControlCharacters(trimmed)) {
    return { valid: false, sanitizedUrl: fallback, error: 'Endpoint contains invalid control characters.' };
  }

  let candidate = trimmed;
  if (!candidate.startsWith('http://') && !candidate.startsWith('https://')) {
    if (candidate.includes('://')) {
      return { valid: false, sanitizedUrl: fallback, error: 'Only http:// or https:// protocols are permitted.' };
    }
    candidate = `http://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, sanitizedUrl: fallback, error: 'Only HTTP/HTTPS protocols are allowed.' };
    }
    if (parsed.username || parsed.password) {
      return { valid: false, sanitizedUrl: fallback, error: 'Embedded credentials are not permitted in endpoints.' };
    }
    const host = parsed.hostname.toLowerCase();
    const allowedHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);
    if (!allowedHosts.has(host)) {
      return {
        valid: false,
        sanitizedUrl: fallback,
        error: `Blocked non-local host "${host}". Strict local-only policy requires localhost or 127.0.0.1.`
      };
    }
    let cleanPath = parsed.pathname;
    while (cleanPath.length > 1 && cleanPath.endsWith('/')) {
      cleanPath = cleanPath.slice(0, -1);
    }
    const normalized = `${parsed.protocol}//${parsed.host}${cleanPath === '/' ? '' : cleanPath}`;
    return { valid: true, sanitizedUrl: normalized };
  } catch {
    return { valid: false, sanitizedUrl: fallback, error: 'Malformed URL syntax.' };
  }
}

export function validatePublicWebUrl(rawUrl: string): { valid: boolean; normalizedUrl: string; error?: string } {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) {
    return { valid: false, normalizedUrl: '', error: 'URL cannot be empty.' };
  }
  if (hasControlCharacters(trimmed)) {
    return { valid: false, normalizedUrl: '', error: 'URL contains invalid control characters.' };
  }

  let candidate = trimmed;
  if (!candidate.startsWith('http://') && !candidate.startsWith('https://')) {
    if (candidate.includes('://')) {
      return { valid: false, normalizedUrl: '', error: 'Only http:// and https:// URLs are supported.' };
    }
    candidate = `https://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, normalizedUrl: '', error: 'Only HTTP and HTTPS protocols are permitted.' };
    }
    if (parsed.username || parsed.password) {
      return { valid: false, normalizedUrl: '', error: 'URLs with embedded credentials are blocked.' };
    }

    const host = parsed.hostname.toLowerCase();
    const blockedHosts = new Set([
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      '::1',
      '[::1]',
      'metadata.google.internal',
      '169.254.169.254'
    ]);
    if (
      blockedHosts.has(host) ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.startsWith('[fc') ||
      host.startsWith('[fd') ||
      host.startsWith('[fe80') ||
      host.startsWith('[::ffff:') ||
      host.startsWith('fc00:') ||
      host.startsWith('fd00:') ||
      host.startsWith('fe80:') ||
      host.startsWith('::ffff:')
    ) {
      return {
        valid: false,
        normalizedUrl: '',
        error: `Blocked private or loopback host "${host}" to prevent SSRF.`
      };
    }

    const octets = parseIpv4Octets(host);
    if (octets) {
      const [a, b] = octets;
      const isPrivate =
        a === 10 ||
        a === 127 ||
        a === 0 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254);
      if (isPrivate) {
        return {
          valid: false,
          normalizedUrl: '',
          error: `Blocked private IPv4 address "${host}" to prevent SSRF.`
        };
      }
    }

    return { valid: true, normalizedUrl: parsed.toString() };
  } catch {
    return { valid: false, normalizedUrl: '', error: 'Malformed URL syntax.' };
  }
}

export function extractHttpUrlsFromText(text: string): string[] {
  if (!text) return [];
  const results: string[] = [];
  const seen = new Set<string>();
  const prefixes = ['https://', 'http://'];

  for (const prefix of prefixes) {
    let idx = 0;
    while (idx < text.length) {
      const found = text.indexOf(prefix, idx);
      if (found === -1) break;
      let end = found + prefix.length;
      while (end < text.length) {
        const ch = text[end];
        if (
          isWhitespaceChar(ch) ||
          ch === '"' ||
          ch === "'" ||
          ch === '<' ||
          ch === '>' ||
          ch === ')' ||
          ch === ']' ||
          ch === '}'
        ) {
          break;
        }
        end++;
      }
      let candidate = text.slice(found, end);
      while (
        candidate.length > prefix.length &&
        (candidate.endsWith('.') ||
          candidate.endsWith(',') ||
          candidate.endsWith(';') ||
          candidate.endsWith(':') ||
          candidate.endsWith('!') ||
          candidate.endsWith('?'))
      ) {
        candidate = candidate.slice(0, -1);
      }
      if (candidate.length > prefix.length && !seen.has(candidate)) {
        seen.add(candidate);
        results.push(candidate);
      }
      idx = end;
    }
  }
  return results;
}
