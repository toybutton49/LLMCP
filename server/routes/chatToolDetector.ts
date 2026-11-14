// Deterministic GGUF Tool Call Parser & Raw JSON Fallback Detector (Zero Regex)

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface JsonBlockSpan {
  text: string;
  start: number;
  end: number;
}

export function parseXmlFunctionBlock(
  rawBlock: string,
  callIndex: number
): ParsedToolCall | null {
  const lower = rawBlock.toLowerCase();
  const fnPrefix = '<function=';
  const fnStart = lower.indexOf(fnPrefix);
  if (fnStart === -1) return null;
  const nameStart = fnStart + fnPrefix.length;
  const fnTagEnd = lower.indexOf('>', nameStart);
  if (fnTagEnd === -1) return null;
  const fnName = rawBlock.slice(nameStart, fnTagEnd).trim();
  if (!fnName) return null;

  const argsObj: Record<string, unknown> = {};
  const paramPrefix = '<parameter=';
  const paramClose = '</parameter>';
  let pCursor = fnTagEnd + 1;
  while (pCursor < rawBlock.length) {
    const pStart = lower.indexOf(paramPrefix, pCursor);
    if (pStart === -1) break;
    const keyStart = pStart + paramPrefix.length;
    const keyEnd = lower.indexOf('>', keyStart);
    if (keyEnd === -1) break;
    const paramKey = rawBlock.slice(keyStart, keyEnd).trim();
    const valStart = keyEnd + 1;
    const valEnd = lower.indexOf(paramClose, valStart);
    const rawVal = (valEnd !== -1 ? rawBlock.slice(valStart, valEnd) : rawBlock.slice(valStart)).trim();
    if (paramKey) {
      const asNum = Number(rawVal);
      argsObj[paramKey] =
        rawVal !== '' && Number.isFinite(asNum) && String(asNum) === rawVal ? asNum : rawVal;
    }
    if (valEnd === -1) break;
    pCursor = valEnd + paramClose.length;
  }

  return {
    id: `gguf_xml_${callIndex}`,
    name: fnName,
    arguments: JSON.stringify(argsObj)
  };
}

/**
 * Extracts `<tool_call>{"name": "...", "arguments": {...}}</tool_call>` or
 * `<tool_call><function=name><parameter=key>val</parameter></function></tool_call>` blocks
 * if a GGUF model emits inline tool call tags in addition to or instead of OpenAI `delta.tool_calls`.
 */
export function extractInlineGgufToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const openTag = '<tool_call>';
  const closeTag = '</tool_call>';
  const lower = text.toLowerCase();
  let cursor = 0;
  let idx = 0;

  while (cursor < text.length) {
    const startIdx = lower.indexOf(openTag, cursor);
    if (startIdx === -1) break;
    const bodyStart = startIdx + openTag.length;
    const endIdx = lower.indexOf(closeTag, bodyStart);
    const rawBlock = (endIdx !== -1 ? text.slice(bodyStart, endIdx) : text.slice(bodyStart)).trim();

    if (rawBlock.startsWith('{')) {
      try {
        const parsed = JSON.parse(rawBlock) as { name?: string; arguments?: unknown };
        if (parsed && typeof parsed.name === 'string' && parsed.name.trim()) {
          calls.push({
            id: `gguf_call_${idx++}`,
            name: parsed.name.trim(),
            arguments:
              typeof parsed.arguments === 'string'
                ? parsed.arguments
                : JSON.stringify(parsed.arguments || {})
          });
        }
      } catch {
        // Ignore malformed inline JSON tag
      }
    } else {
      const xmlCall = parseXmlFunctionBlock(rawBlock, idx);
      if (xmlCall) {
        idx++;
        calls.push(xmlCall);
      }
    }

    if (endIdx === -1) break;
    cursor = endIdx + closeTag.length;
  }
  return calls;
}

/**
 * Deterministically scans text without regular expressions for top-level balanced
 * JSON objects ({ ... }) and JSON arrays ([ ... ]), recording exact character offsets.
 */
export function extractJsonSpans(text: string): JsonBlockSpan[] {
  const spans: JsonBlockSpan[] = [];
  let inString = false;
  let escape = false;
  let depth = 0;
  let startIdx = -1;
  let openChar = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{' || ch === '[') {
      if (depth === 0) {
        startIdx = i;
        openChar = ch;
      }
      depth++;
    } else if (ch === '}' || ch === ']') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && startIdx !== -1) {
          const matchingClose = openChar === '{' ? '}' : ']';
          if (ch === matchingClose) {
            spans.push({
              text: text.slice(startIdx, i + 1),
              start: startIdx,
              end: i + 1
            });
          }
          startIdx = -1;
          openChar = '';
        }
      }
    }
  }
  return spans;
}

export function extractJsonBlocks(text: string): string[] {
  return extractJsonSpans(text).map((s) => s.text);
}

/**
 * Checks if a candidate buffer contains a top-level JSON object or array that has reached depth 0.
 */
export function isTopLevelJsonComplete(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  let inString = false;
  let escape = false;
  let depth = 0;
  let started = false;
  let openChar = '';

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      if (!started) {
        started = true;
        openChar = ch;
      }
      depth++;
    } else if (ch === '}' || ch === ']') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && started) {
          const match = openChar === '{' ? '}' : ']';
          return ch === match && i === trimmed.length - 1;
        }
      }
    }
  }
  return false;
}

function resolveAllowedToolNameSet(
  allowedToolNames?: string[] | Set<string>
): Set<string> | null {
  if (!allowedToolNames) return null;
  const inputList = Array.isArray(allowedToolNames)
    ? allowedToolNames
    : Array.from(allowedToolNames);
  if (inputList.length === 0) return null;

  const set = new Set<string>();
  for (const name of inputList) {
    const clean = String(name || '').trim().toLowerCase();
    if (!clean) continue;
    set.add(clean);
    if (clean === 'web_search') {
      set.add('web_fetch');
      set.add('web_context');
      set.add('web_tool');
      set.add('web_ops');
    } else if (clean === 'system_context') {
      set.add('sys_context');
    } else if (clean === 'agent_file_ops') {
      set.add('file_ops');
      set.add('agent_filesystem');
    }
  }
  return set.size > 0 ? set : null;
}

function normalizeExtractedToolCall(
  obj: unknown,
  callIndex: number,
  allowedNamesSet?: Set<string> | null
): ParsedToolCall | null {
  if (!obj || typeof obj !== 'object') return null;

  let target = obj as Record<string, unknown>;
  if (target.type === 'function' && target.function && typeof target.function === 'object') {
    target = target.function as Record<string, unknown>;
  } else if (
    target.function &&
    typeof target.function === 'object' &&
    typeof (target.function as Record<string, unknown>).name === 'string'
  ) {
    target = target.function as Record<string, unknown>;
  }

  const rawName = target.name || target.tool || target.tool_name;
  if (typeof rawName !== 'string' || !rawName.trim()) {
    return null;
  }

  let cleanName = rawName.trim().toLowerCase();
  if (cleanName.startsWith('functions.')) cleanName = cleanName.slice(10);
  if (cleanName.startsWith('tools.')) cleanName = cleanName.slice(6);

  if (allowedNamesSet && !allowedNamesSet.has(cleanName)) {
    return null;
  }

  const hasArgs =
    'arguments' in target ||
    'parameters' in target ||
    'args' in target ||
    (obj as Record<string, unknown>).type === 'function' ||
    Boolean((obj as Record<string, unknown>).function);

  if (!hasArgs) {
    return null;
  }

  const rawArgs = target.arguments ?? target.parameters ?? target.args ?? {};
  const argsString = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);

  const rawId = (obj as Record<string, unknown>).id || target.id;
  const id = typeof rawId === 'string' && rawId ? rawId : `raw_json_${callIndex}`;

  return {
    id,
    name: cleanName || rawName.trim(),
    arguments: argsString
  };
}

/**
 * Fallback detector for tool calls when smaller models (such as granite-4.1-3b when
 * thinking mode is disabled) emit raw JSON tool calls instead of XML <tool_call> tags.
 */
export function detectRawJsonToolCalls(
  text: string,
  allowedToolNames?: string[] | Set<string>
): ParsedToolCall[] {
  if (!text) return [];

  const lower = text.toLowerCase();
  if (lower.includes('<tool_call>') || lower.includes('<function=')) {
    return [];
  }

  if (!text.includes('"name"') && !text.includes('"function"') && !text.includes('"tool"')) {
    return [];
  }

  const allowedSet = resolveAllowedToolNameSet(allowedToolNames);
  const calls: ParsedToolCall[] = [];
  const blocks = extractJsonBlocks(text);

  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const call = normalizeExtractedToolCall(item, calls.length, allowedSet);
          if (call) {
            calls.push(call);
          }
        }
      } else {
        const call = normalizeExtractedToolCall(parsed, calls.length, allowedSet);
        if (call) {
          calls.push(call);
        }
      }
    } catch {
      // Ignore unparseable JSON candidate block
    }
  }

  return calls;
}

/**
 * Deterministically strips detected raw JSON tool calls and surrounding markdown code fences
 * from assistant content without regular expressions, preserving conversational prose.
 */
export function stripRawJsonToolCalls(
  text: string,
  allowedToolNames?: string[] | Set<string>
): string {
  if (!text) return '';
  const spans = extractJsonSpans(text);
  if (spans.length === 0) return text;

  let result = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    const callsInSpan = detectRawJsonToolCalls(span.text, allowedToolNames);
    if (callsInSpan.length === 0) continue;

    let start = span.start;
    let end = span.end;

    const before = result.slice(0, start).trimEnd();
    if (before.endsWith('```json')) {
      start = before.length - 7;
    } else if (before.endsWith('```')) {
      start = before.length - 3;
    }

    const after = result.slice(end);
    let afterCursor = 0;
    while (
      afterCursor < after.length &&
      (after[afterCursor] === ' ' ||
        after[afterCursor] === '\t' ||
        after[afterCursor] === '\r' ||
        after[afterCursor] === '\n')
    ) {
      afterCursor++;
    }
    if (after.slice(afterCursor).startsWith('```')) {
      end = end + afterCursor + 3;
      if (result[end] === '\r' && result[end + 1] === '\n') {
        end += 2;
      } else if (result[end] === '\n') {
        end += 1;
      }
    }

    result = result.slice(0, start) + result.slice(end);
  }

  if (result.trim() === '') return '';
  return result;
}
