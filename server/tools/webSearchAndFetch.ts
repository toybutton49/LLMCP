// Server-side live web search, RSS, guarded fetch, and semantic distillation
import { RagDocumentInput, buildVectorIndex, searchVectorIndex } from '../../src/utils/rag';
import {
  WebContextResult, WebFetchResult, WebSearchResultItem,
  buildWebContextFromPages, parseHtmlToReadableDocument, validateSafeWebUrl
} from '../../src/utils/webTools';
import { stripHtmlTagsScanner } from '../../src/utils/structuredParsers';
import { safeFetchWithManualRedirects } from './safeWebFetch';
import { serverLogger } from '../config/logger';

export { safeFetchWithManualRedirects } from './safeWebFetch';

function decodeXmlEntities(raw: string): string {
  if (!raw) return '';
  let text = raw.trim();
  if (text.startsWith('<![CDATA[') && text.endsWith(']]>')) {
    text = text.slice(9, -3).trim();
  }
  return text
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&nbsp;', ' ').replaceAll('&amp;', '&').trim();
}

function extractXmlTagValue(itemXml: string, tagName: string): string {
  const lower = itemXml.toLowerCase();
  const openTag = `<${tagName.toLowerCase()}`;
  const openIdx = lower.indexOf(openTag);
  if (openIdx === -1) return '';
  const gtIdx = itemXml.indexOf('>', openIdx + openTag.length);
  if (gtIdx === -1) return '';
  const closeTag = `</${tagName.toLowerCase()}>`;
  const closeIdx = lower.indexOf(closeTag, gtIdx + 1);
  if (closeIdx === -1) return '';
  return decodeXmlEntities(itemXml.slice(gtIdx + 1, closeIdx));
}

function unwrapRedirectTargetUrl(rawUrl: string): string {
  const cleaned = decodeXmlEntities(rawUrl);
  if (!cleaned) return '';
  for (const marker of ['&url=', '?url=']) {
    const idx = cleaned.indexOf(marker);
    if (idx !== -1) {
      const start = idx + marker.length;
      const ampIdx = cleaned.indexOf('&', start);
      const encodedTarget = ampIdx === -1 ? cleaned.slice(start) : cleaned.slice(start, ampIdx);
      try {
        const decoded = decodeURIComponent(encodedTarget);
        if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
          return decoded;
        }
      } catch {
        // Keep original URL if decoding fails
      }
    }
  }
  return cleaned;
}

interface ParsedRssItem {
  title: string;
  url: string;
  description: string;
  pubDate: string;
  publisher: string;
}

function parseRssFeedItems(xmlText: string, maxItems: number = 6): ParsedRssItem[] {
  const items: ParsedRssItem[] = [];
  if (!xmlText) return items;
  const lower = xmlText.toLowerCase();
  let cursor = 0;

  while (items.length < maxItems && cursor < xmlText.length) {
    const itemStart = lower.indexOf('<item>', cursor);
    const itemStartAttr = lower.indexOf('<item ', cursor);
    let openIdx = -1;
    if (itemStart !== -1 && itemStartAttr !== -1) {
      openIdx = Math.min(itemStart, itemStartAttr);
    } else {
      openIdx = itemStart !== -1 ? itemStart : itemStartAttr;
    }
    if (openIdx === -1) break;

    const closeIdx = lower.indexOf('</item>', openIdx + 5);
    if (closeIdx === -1) break;

    const block = xmlText.slice(openIdx, closeIdx + 7);
    cursor = closeIdx + 7;

    const title = stripHtmlTagsScanner(extractXmlTagValue(block, 'title'));
    const rawLink = extractXmlTagValue(block, 'link');
    const url = unwrapRedirectTargetUrl(rawLink);
    const description = stripHtmlTagsScanner(extractXmlTagValue(block, 'description'));
    const pubDate = stripHtmlTagsScanner(extractXmlTagValue(block, 'pubDate'));
    const publisher =
      stripHtmlTagsScanner(extractXmlTagValue(block, 'News:Source')) ||
      stripHtmlTagsScanner(extractXmlTagValue(block, 'source'));

    if (title && url) {
      items.push({ title, url, description, pubDate, publisher });
    }
  }
  return items;
}

export async function performWebSearch(
  query: string,
  maxResults: number = 6
): Promise<WebSearchResultItem[]> {
  const cleanQuery = (query || '').trim().slice(0, 300);
  if (!cleanQuery) return [];
  const boundedMax = Math.max(1, Math.min(12, Number(maxResults) || 6));
  const results: WebSearchResultItem[] = [];
  const failures: string[] = [];
  let successfulFeeds = 0;
  const recordFailure = (source: string, error: unknown) => {
    failures.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
  };
  const encoded = encodeURIComponent(cleanQuery);
  const browserUa =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

  const bingNewsPromise = (async () => {
    try {
      const url = `https://www.bing.com/news/search?q=${encoded}&format=rss`;
      const { response: resp } = await safeFetchWithManualRedirects(url, {
        headers: { 'User-Agent': browserUa },
        signal: AbortSignal.timeout(3200)
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const xml = await resp.text();
      const parsed = parseRssFeedItems(xml, boundedMax);
      successfulFeeds++;
      parsed.forEach((item, idx) => {
        const metaPrefix = [item.publisher, item.pubDate].filter(Boolean).join(' · ');
        const snippetBody = item.description || item.title;
        results.push({
          id: `live_news_${idx}`,
          title: item.publisher ? `${item.title} (${item.publisher})` : item.title,
          url: item.url,
          snippet: metaPrefix ? `[${metaPrefix}] ${snippetBody}`.slice(0, 650) : snippetBody.slice(0, 650),
          source: 'live-news',
          score: Number((0.98 - idx * 0.01).toFixed(2))
        });
      });
    } catch (error) {
      recordFailure('Bing News', error);
    }
  })();

  const bingWebPromise = (async () => {
    try {
      const url = `https://www.bing.com/search?q=${encoded}&format=rss`;
      const { response: resp } = await safeFetchWithManualRedirects(url, {
        headers: { 'User-Agent': browserUa },
        signal: AbortSignal.timeout(3200)
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const xml = await resp.text();
      const parsed = parseRssFeedItems(xml, boundedMax);
      successfulFeeds++;
      parsed.forEach((item, idx) => {
        const snippetBody = item.description || item.title;
        const metaPrefix = item.pubDate ? `[${item.pubDate}] ` : '';
        results.push({
          id: `live_web_${idx}`,
          title: item.title,
          url: item.url,
          snippet: `${metaPrefix}${snippetBody}`.slice(0, 650),
          source: 'live-web',
          score: Number((0.95 - idx * 0.01).toFixed(2))
        });
      });
    } catch (error) {
      recordFailure('Bing Search', error);
    }
  })();

  const googleNewsPromise = (async () => {
    try {
      const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;
      const { response: resp } = await safeFetchWithManualRedirects(url, {
        headers: { 'User-Agent': browserUa },
        signal: AbortSignal.timeout(3200)
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const xml = await resp.text();
      const parsed = parseRssFeedItems(xml, 4);
      successfulFeeds++;
      parsed.forEach((item, idx) => {
        const metaPrefix = [item.publisher, item.pubDate].filter(Boolean).join(' · ');
        const snippetBody =
          item.description && item.description !== item.title ? item.description : item.title;
        results.push({
          id: `gnews_${idx}`,
          title: item.title,
          url: item.url,
          snippet: metaPrefix ? `[${metaPrefix}] ${snippetBody}`.slice(0, 500) : snippetBody.slice(0, 500),
          source: 'google-news-rss',
          score: Number((0.93 - idx * 0.01).toFixed(2))
        });
      });
    } catch (error) {
      recordFailure('Google News', error);
    }
  })();

  const wikiPromise = (async () => {
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&utf8=&format=json&srlimit=3`;
      const { response: resp } = await safeFetchWithManualRedirects(url, {
        headers: { 'User-Agent': 'LLMCP-Workbench/7.0' },
        signal: AbortSignal.timeout(2800)
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = (await resp.json()) as {
        query?: {
          search?: Array<{ title: string; snippet: string; pageid: number }>;
        };
      };
      const searchHits = json.query?.search || [];
      successfulFeeds++;
      const extractByPageId: Record<string, string> = {};
      if (searchHits.length > 0) {
        try {
          const pageIds = searchHits
            .slice(0, 2)
            .map((h) => String(h.pageid))
            .join('|');
          const extUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&exchars=650&pageids=${encodeURIComponent(pageIds)}&format=json`;
          const { response: extResp } = await safeFetchWithManualRedirects(extUrl, {
            headers: { 'User-Agent': 'LLMCP-Workbench/7.0' },
            signal: AbortSignal.timeout(2200)
          });
          if (extResp.ok) {
            const extJson = (await extResp.json()) as {
              query?: { pages?: Record<string, { extract?: string }> };
            };
            for (const [pid, pageObj] of Object.entries(extJson.query?.pages || {})) {
              if (pageObj?.extract && pageObj.extract.trim()) {
                extractByPageId[pid] = pageObj.extract.trim();
              }
            }
          }
        } catch {
          // Use search snippet
        }
      }
      for (const item of searchHits) {
        const cleanSnippet = stripHtmlTagsScanner(item.snippet || '');
        const fullExtract = extractByPageId[String(item.pageid)] || '';
        const combinedSnippet =
          fullExtract.length > cleanSnippet.length ? fullExtract : cleanSnippet;
        results.push({
          id: `wiki_${item.pageid}`,
          title: `${item.title} - Wikipedia Reference`,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.split(' ').join('_'))}`,
          snippet: combinedSnippet.slice(0, 650),
          source: 'wikipedia',
          score: 0.89
        });
      }
    } catch (error) {
      recordFailure('Wikipedia', error);
    }
  })();

  await Promise.all([bingNewsPromise, bingWebPromise, googleNewsPromise, wikiPromise]);
  if (successfulFeeds === 0) throw new Error(`All web search providers failed: ${failures.join('; ')}`);
  if (failures.length) serverLogger.warn('tool', 'Some web search providers failed.', { failures });

  // Deduplicate by normalized URL or title
  const seenUrls = new Set<string>();
  const deduped: WebSearchResultItem[] = [];
  results.sort((a, b) => b.score - a.score);
  for (const item of results) {
    const key = item.url.toLowerCase();
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);
    deduped.push(item);
    if (deduped.length >= boundedMax) break;
  }

  return deduped;
}

export async function performWebFetch(
  rawUrl: string,
  maxChars: number = 12000
): Promise<WebFetchResult> {
  const check = validateSafeWebUrl(rawUrl);
  if (!check.valid) {
    throw new Error(check.reason || 'Blocked unsafe URL in web_fetch.');
  }

  const { response: resp, finalUrl } = await safeFetchWithManualRedirects(
    check.normalizedUrl,
    {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(4500)
    }
  );

  const finalUrlCheck = validateSafeWebUrl(finalUrl);
  if (!finalUrlCheck.valid) {
    throw new Error(`Redirect target blocked by SSRF guard: ${finalUrlCheck.reason}`);
  }

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} (${resp.statusText}) from ${finalUrlCheck.normalizedUrl}`);
  }

  const contentType = (resp.headers.get('content-type') || '').toLowerCase();
  const contentLength = Number(resp.headers.get('content-length') || 0);
  if (contentLength > 2_000_000) {
    throw new Error('Remote response exceeds 2MB safety ceiling.');
  }
  const rawBody = (await resp.text()).slice(0, 2_000_000);

  if (contentType.includes('application/json')) {
    let formatted = rawBody;
    try {
      formatted = JSON.stringify(JSON.parse(rawBody), null, 2);
    } catch {
      // Keep raw string
    }
    const clipped = formatted.slice(0, maxChars);
    return {
      url: finalUrlCheck.normalizedUrl,
      title: `JSON Payload (${new URL(finalUrlCheck.normalizedUrl).hostname})`,
      description: 'Structured JSON response payload',
      content: clipped,
      headings: ['JSON Root'],
      links: [],
      wordCount: clipped.split(' ').filter(Boolean).length,
      charCount: clipped.length,
      fetchedAt: new Date().toISOString()
    };
  }

  return parseHtmlToReadableDocument(rawBody, finalUrlCheck.normalizedUrl, maxChars);
}

/**
 * Octopus live search and page-context distiller:
 * Fetches the top discovered live web/news URLs in parallel, extracts readable text,
 * ranks chunks using the local vector similarity engine against the user's query,
 * and returns a compact, high-signal intelligence brief tailored for 8GB VRAM context windows.
 */
export async function distillWebSearchForBrain(
  query: string,
  searchHits: WebSearchResultItem[]
): Promise<string> {
  if (searchHits.length === 0) {
    return '0 web results found.';
  }

  // Pick top 2 direct external article URLs (excluding google-news encrypted redirect wrappers) for deep page reading
  const candidateUrls = searchHits
    .filter(
      (h) =>
        (h.url.startsWith('https://') || h.url.startsWith('http://')) &&
        !h.url.includes('news.google.com/rss/articles/')
    )
    .slice(0, 2);

  const fetchedPages: Array<{ title: string; url: string; content: string }> = [];
  await Promise.all(
    candidateUrls.map(async (item) => {
      try {
        const page = await performWebFetch(item.url, 4500);
        if (page.content && page.content.trim().length > 140) {
          fetchedPages.push({
            title: item.title || page.title,
            url: item.url,
            content: page.content
          });
        }
      } catch {
        // Ignore individual page timeouts and rely on search feed snippets
      }
    })
  );

  const candidateDocs: RagDocumentInput[] = [
    ...fetchedPages.map((p, idx) => ({ id: `live_page_${idx}`, title: p.title, category: p.url, content: p.content })),
    ...searchHits.map((h, idx) => ({ id: `search_hit_${idx}`, title: h.title, category: h.url, content: h.snippet }))
  ];

  const vectorIndex = buildVectorIndex(candidateDocs, 360, 50);
  const topPassages = searchVectorIndex(query, vectorIndex, 3, 0.02, 'cosine');

  const headlineLines = searchHits
    .slice(0, 5)
    .map((r, idx) => `[${idx + 1}] ${r.title} (${r.source})\nURL: ${r.url}\nSummary: ${r.snippet.slice(0, 380)}`)
    .join('\n\n');

  if (topPassages.length === 0) {
    return `${headlineLines}\n\n[Octopus Signal: Live web search complete. Ground claims in the verified search results above. If the user disputed a score or fact, cross-check against these sources and cite only verified results.]`;
  }

  const passageLines = topPassages
    .map((p, idx) => `[Distilled Passage ${idx + 1} · Relevance ${p.similarityScore.toFixed(2)} · Source: ${p.docTitle}]\n${p.text.slice(0, 380)}`)
    .join('\n\n');

  return `### Live Web & News Search Results\n${headlineLines}\n\n### Retrieved Page Excerpts\n${passageLines}\n\n[Octopus Signal: Live web and news context distilled. Ground factual statements in the verified search results above and cite only verified sources returned in tool results.]`;
}

export async function performWebContext(params: {
  query: string;
  urls?: string[];
  topK?: number;
}): Promise<WebContextResult> {
  const cleanQuery = (params.query || '').trim();
  const topK = Math.max(1, Math.min(8, Number(params.topK) || 4));
  const explicitUrls = (params.urls || []).filter(Boolean).slice(0, 3);
  const pages: Array<{ url: string; title: string; content: string }> = [];

  for (const targetUrl of explicitUrls) {
    const fetched = await performWebFetch(targetUrl, 8000);
    pages.push({
      url: fetched.url,
      title: fetched.title,
      content: fetched.content
    });
  }

  if (pages.length === 0) {
    const searchItems = await performWebSearch(cleanQuery, 5);
    for (const item of searchItems) {
      pages.push({
        url: item.url,
        title: item.title,
        content: `${item.title}\n${item.snippet}`
      });
    }
  }

  return buildWebContextFromPages(cleanQuery, pages, topK);
}
