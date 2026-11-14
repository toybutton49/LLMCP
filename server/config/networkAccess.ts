// Network access policy for loopback, RFC1918 private LAN, and Tailscale (CGNAT 100.64.0.0/10 & MagicDNS).
import net from 'node:net';
import os from 'node:os';
import type { RequestHandler } from 'express';

function stripBracketsAndZone(raw: string): string {
  let clean = raw.trim();
  if (clean.startsWith('[') && clean.endsWith(']')) {
    clean = clean.slice(1, -1);
  }
  const zoneIdx = clean.indexOf('%');
  if (zoneIdx !== -1) {
    clean = clean.slice(0, zoneIdx);
  }
  return clean;
}

export function parseIpv4Octets(rawAddr: string): [number, number, number, number] | null {
  let addr = stripBracketsAndZone(rawAddr);
  if (addr.toLowerCase().startsWith('::ffff:')) {
    addr = addr.slice(7);
  }
  if (net.isIP(addr) !== 4) return null;
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return [octets[0], octets[1], octets[2], octets[3]];
}

export function classifyLocalOrTailscaleIpv4(
  rawAddr: string
): 'loopback' | 'lan' | 'tailscale' | null {
  const octets = parseIpv4Octets(rawAddr);
  if (!octets) return null;
  const [a, b] = octets;
  if (a === 127) return 'loopback';
  // RFC 1918 private LAN ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
  if (a === 10) return 'lan';
  if (a === 172 && b >= 16 && b <= 31) return 'lan';
  if (a === 192 && b === 168) return 'lan';
  // RFC 6598 CGNAT range used by Tailscale (100.64.0.0/10 -> 100.64.0.0 - 100.127.255.255)
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
  return null;
}

export function isAllowedClientIp(rawAddr: string): boolean {
  const clean = stripBracketsAndZone(rawAddr);
  if (!clean) return false;
  if (classifyLocalOrTailscaleIpv4(clean) !== null) {
    return true;
  }
  if (net.isIP(clean) === 6) {
    const lower = clean.toLowerCase();
    if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
    // Unique Local IPv6 (fc00::/7, including Tailscale fd7a:115c:a1e0::/48)
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    // Link-local IPv6 (fe80::/10)
    if (
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    ) {
      return true;
    }
  }
  return false;
}

export function extractHostFromHeader(hostHeader: string): string {
  const trimmed = String(hostHeader || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    if (closeIdx === -1) return '';
    const remainder = trimmed.slice(closeIdx + 1);
    if (remainder !== '' && !remainder.startsWith(':')) return '';
    return trimmed.slice(1, closeIdx);
  }
  const firstColon = trimmed.indexOf(':');
  if (firstColon === -1) return trimmed;
  if (trimmed.indexOf(':', firstColon + 1) !== -1) return '';
  return trimmed.slice(0, firstColon);
}

export function isAllowedNetworkHostName(
  rawHostName: string,
  localHostname: string = os.hostname()
): boolean {
  const clean = stripBracketsAndZone(rawHostName).toLowerCase();
  if (!clean) return false;
  if (clean === 'localhost') return true;
  if (isAllowedClientIp(clean)) return true;

  const cleanLocalHost = localHostname.trim().toLowerCase();
  if (cleanLocalHost && (clean === cleanLocalHost || clean === `${cleanLocalHost}.local`)) {
    return true;
  }
  // Tailscale MagicDNS hostnames (*.ts.net)
  if (clean.endsWith('.ts.net') && clean.length > 7 && !clean.startsWith('.')) {
    return true;
  }
  return false;
}

export function isAllowedHostHeader(
  hostHeader: string,
  localHostname: string = os.hostname()
): boolean {
  const hostName = extractHostFromHeader(hostHeader);
  if (!hostName) return false;
  return isAllowedNetworkHostName(hostName, localHostname);
}

export function isAllowedOriginHeader(
  originHeader: string,
  localHostname: string = os.hostname()
): boolean {
  try {
    const parsed = new URL(originHeader);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host =
      parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
        ? parsed.hostname.slice(1, -1)
        : parsed.hostname;
    return isAllowedNetworkHostName(host, localHostname);
  } catch {
    return false;
  }
}

export function createNetworkAccessMiddleware(
  localHostname: string = os.hostname()
): RequestHandler {
  return (req, res, next) => {
    const remoteAddr = req.socket?.remoteAddress || '';
    if (remoteAddr && !isAllowedClientIp(remoteAddr)) {
      res.status(403).json({
        error: 'External connection blocked: only loopback, private LAN, and Tailscale clients are permitted.'
      });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

    // Reject DNS-rebinding requests whose Host header is not loopback, LAN/Tailscale IP, local hostname, or *.ts.net.
    const hostHeader = String(req.headers.host || '');
    if (!isAllowedHostHeader(hostHeader, localHostname)) {
      res.status(403).json({
        error: 'Request blocked: Host header is not an allowed loopback, LAN, or Tailscale host.'
      });
      return;
    }

    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      const origin = req.headers.origin;
      if (origin !== undefined) {
        if (typeof origin !== 'string' || !isAllowedOriginHeader(origin, localHostname)) {
          res.status(403).json({
            error: 'Cross-origin request blocked by network security policy.'
          });
          return;
        }
      }
    }
    next();
  };
}

export function listReachableNetworkUrls(
  port: number,
  bindHost: string
): {
  loopbackUrl: string;
  lanUrls: string[];
  tailscaleUrls: string[];
} {
  const loopbackUrl = `http://localhost:${port}`;
  const lanUrls: string[] = [];
  const tailscaleUrls: string[] = [];

  const trimmedHost = bindHost.trim();
  const isWildcard = trimmedHost === '0.0.0.0' || trimmedHost === '::';

  if (!isWildcard) {
    const kind = classifyLocalOrTailscaleIpv4(trimmedHost);
    if (kind === 'lan') lanUrls.push(`http://${trimmedHost}:${port}`);
    else if (kind === 'tailscale') tailscaleUrls.push(`http://${trimmedHost}:${port}`);
    return { loopbackUrl, lanUrls, tailscaleUrls };
  }

  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      const kind = classifyLocalOrTailscaleIpv4(entry.address);
      if (kind === 'lan') {
        lanUrls.push(`http://${entry.address}:${port}`);
      } else if (kind === 'tailscale') {
        tailscaleUrls.push(`http://${entry.address}:${port}`);
      }
    }
  }

  lanUrls.sort();
  tailscaleUrls.sort();
  return { loopbackUrl, lanUrls, tailscaleUrls };
}
