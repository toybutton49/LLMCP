// SSRF-Guarded External HTTP Fetch with Manual Redirect Validation (Zero Regex)
import { validateSafeWebUrl } from '../../src/utils/webTools';

export interface SafeFetchResult {
  response: Response;
  finalUrl: string;
}

/**
 * Executes a fetch with `redirect: 'manual'`, strictly validating the initial URL
 * and any subsequent 301/302/303/307/308 redirect Location headers against the anti-SSRF
 * guard before dispatching internal network requests.
 */
export async function safeFetchWithManualRedirects(
  targetUrl: string,
  init: RequestInit = {},
  maxRedirects: number = 5
): Promise<SafeFetchResult> {
  let currentUrl = targetUrl;
  let currentInit: RequestInit = { ...init };

  const initialCheck = validateSafeWebUrl(currentUrl);
  if (!initialCheck.valid) {
    throw new Error(initialCheck.reason || 'Blocked unsafe initial URL in SSRF guard.');
  }
  currentUrl = initialCheck.normalizedUrl;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const resp = await fetch(currentUrl, {
      ...currentInit,
      redirect: 'manual'
    });

    const isRedirect =
      resp.status === 301 ||
      resp.status === 302 ||
      resp.status === 303 ||
      resp.status === 307 ||
      resp.status === 308;

    if (isRedirect) {
      await resp.body?.cancel().catch(() => undefined);
      if (redirectCount >= maxRedirects) {
        throw new Error(`Exceeded maximum redirect limit of ${maxRedirects}.`);
      }
      const rawLocation = resp.headers.get('location');
      if (!rawLocation) {
        throw new Error(`HTTP ${resp.status} redirect received without Location header.`);
      }

      let nextUrlObj: URL;
      try {
        nextUrlObj = new URL(rawLocation, currentUrl);
      } catch {
        throw new Error(`Invalid redirect Location header: "${rawLocation}".`);
      }

      if (nextUrlObj.protocol !== 'http:' && nextUrlObj.protocol !== 'https:') {
        throw new Error(`Blocked redirect to non-HTTP/HTTPS protocol: "${nextUrlObj.protocol}".`);
      }

      const nextUrlStr = nextUrlObj.toString();
      const redirectCheck = validateSafeWebUrl(nextUrlStr);
      if (!redirectCheck.valid) {
        throw new Error(
          `Redirect target blocked by SSRF guard: ${redirectCheck.reason || 'Blocked unsafe redirect URL'}`
        );
      }

      // RFC 7231 / Fetch standard: 303 or 301/302 for POST converts to GET without body
      const methodUpper = String(currentInit.method || 'GET').toUpperCase();
      if (
        resp.status === 303 ||
        ((resp.status === 301 || resp.status === 302) && methodUpper === 'POST')
      ) {
        currentInit = {
          ...currentInit,
          method: 'GET',
          body: undefined
        };
      }

      // Prevent sensitive header leakage across origins
      const currentOrigin = new URL(currentUrl).origin;
      if (nextUrlObj.origin !== currentOrigin && currentInit.headers) {
        const cleanedHeaders: Record<string, string> = {};
        if (currentInit.headers instanceof Headers) {
          currentInit.headers.forEach((val, key) => {
            const lk = key.toLowerCase();
            if (lk !== 'authorization' && lk !== 'cookie' && lk !== 'proxy-authorization') {
              cleanedHeaders[key] = val;
            }
          });
        } else if (Array.isArray(currentInit.headers)) {
          for (const [key, val] of currentInit.headers) {
            const lk = key.toLowerCase();
            if (lk !== 'authorization' && lk !== 'cookie' && lk !== 'proxy-authorization') {
              cleanedHeaders[key] = val;
            }
          }
        } else if (typeof currentInit.headers === 'object') {
          for (const [key, val] of Object.entries(currentInit.headers)) {
            const lk = key.toLowerCase();
            if (lk !== 'authorization' && lk !== 'cookie' && lk !== 'proxy-authorization') {
              cleanedHeaders[key] = String(val);
            }
          }
        }
        currentInit.headers = cleanedHeaders;
      }

      currentUrl = redirectCheck.normalizedUrl;
      continue;
    }

    return { response: resp, finalUrl: currentUrl };
  }

  throw new Error(`Exceeded maximum redirect limit of ${maxRedirects}.`);
}
