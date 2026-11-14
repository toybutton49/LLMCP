import type { HotSwappableToolPlugin, SystemContextSnapshot } from '../types';

export type { SystemContextSnapshot };

export interface SysContextMetadata {
  sys_date: string;
  sys_time: string;
  iso_timestamp: string;
  utc_timestamp: string;
  day_of_week: string;
  timezone: string;
  utc_offset: string;
  utc_offset_minutes: number;
  unix_epoch: number;
  locale: string;
  os_platform: string;
  cpu_arch: string;
  runtime_engine: string;
  inference_engine: string;
  thinking_supported: boolean;
}

/**
 * Generates deterministic, structured system context metadata (date, time, timezone,
 * UTC offset, OS platform, CPU arch, and local engine status) without external API calls.
 */
export function getSysContextMetadata(now: Date = new Date()): SysContextMetadata {
  const days = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday'
  ];
  const pad2 = (n: number) => String(n).padStart(2, '0');

  const year = now.getFullYear();
  const month = pad2(now.getMonth() + 1);
  const day = pad2(now.getDate());
  const sys_date = `${year}-${month}-${day}`;

  const hours = pad2(now.getHours());
  const minutes = pad2(now.getMinutes());
  const seconds = pad2(now.getSeconds());
  const sys_time = `${hours}:${minutes}:${seconds}`;

  const day_of_week = days[now.getDay()] || 'Unknown';

  let timezone = 'UTC';
  let locale = 'en-US';
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    if (resolved.timeZone) timezone = resolved.timeZone;
    if (resolved.locale) locale = resolved.locale;
  } catch {
    // Fallback to UTC / en-US
  }

  const utc_offset_minutes = -now.getTimezoneOffset();
  const offsetSign = utc_offset_minutes >= 0 ? '+' : '-';
  const absOffsetMin = Math.abs(utc_offset_minutes);
  const offsetHours = pad2(Math.floor(absOffsetMin / 60));
  const offsetRemMin = pad2(absOffsetMin % 60);
  const utc_offset = `UTC${offsetSign}${offsetHours}:${offsetRemMin}`;

  const os_platform =
    typeof process !== 'undefined' && process.platform
      ? process.platform
      : typeof navigator !== 'undefined'
        ? navigator.platform || 'browser'
        : 'local-host';

  const cpu_arch =
    typeof process !== 'undefined' && process.arch ? process.arch : 'x64/arm64';

  const runtime_engine =
    typeof process !== 'undefined' && process.versions?.node
      ? `Node.js ${process.versions.node}`
      : 'Browser Runtime';

  return {
    sys_date,
    sys_time,
    iso_timestamp: now.toISOString(),
    utc_timestamp: now.toUTCString(),
    day_of_week,
    timezone,
    utc_offset,
    utc_offset_minutes,
    unix_epoch: Math.floor(now.getTime() / 1000),
    locale,
    os_platform,
    cpu_arch,
    runtime_engine,
    inference_engine: 'llama.cpp (Built-In GGUF Engine)',
    thinking_supported: true
  };
}

export function formatSysContextMetadata(
  meta: SysContextMetadata = getSysContextMetadata(),
  format: 'json' | 'compact' = 'json'
): string {
  if (format === 'compact') {
    return [
      `sys_date: ${meta.sys_date} (${meta.day_of_week})`,
      `sys_time: ${meta.sys_time} (${meta.timezone}, ${meta.utc_offset})`,
      `iso_timestamp: ${meta.iso_timestamp}`,
      `unix_epoch: ${meta.unix_epoch}`,
      `inference_engine: ${meta.inference_engine}`
    ].join('\n');
  }
  return JSON.stringify(meta, null, 2);
}

export function captureSystemContextSnapshot(
  _providerId: string = 'llamacpp',
  now: Date = new Date()
): SystemContextSnapshot {
  const meta = getSysContextMetadata(now);
  return {
    sys_time: meta.sys_time,
    sys_date: meta.sys_date,
    iso_timestamp: meta.iso_timestamp,
    utc_timestamp: meta.utc_timestamp,
    day_of_week: meta.day_of_week,
    timezone: meta.timezone,
    utc_offset: meta.utc_offset,
    unix_epoch: meta.unix_epoch,
    locale: meta.locale,
    os_platform: meta.os_platform,
    cpu_arch: meta.cpu_arch,
    runtime_engine: meta.runtime_engine,
    inference_engine: meta.inference_engine,
    thinking_supported: meta.thinking_supported
  };
}

export function formatSystemContextForPrompt(snapshot: SystemContextSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export const sysContextPlugin: HotSwappableToolPlugin = {
  definition: {
    id: 'sys_context',
    name: 'sys_context (Date, Time & Timezone)',
    category: 'System',
    description:
      'Returns the current date, local time, timestamp, day of week, timezone, and UTC offset when requested.',
    parameterSummary: 'format?: "json" | "compact"',
    triggerKeywords: []
  },
  aliases: ['clock', 'datetime', 'current_time', 'timezone'],
  schema: {
    name: 'sys_context',
    description:
      'Returns the current date (YYYY-MM-DD), local time (HH:mm:ss), ISO-8601 timestamp, day of week, IANA timezone, and UTC offset.',
    parameters: {
      type: 'OBJECT',
      properties: {
        format: {
          type: 'STRING',
          description: 'Output format: "json" (default) or "compact".'
        }
      },
      required: []
    }
  },
  evaluateForPrompt: () => null,
  invokeDirect: (args) => {
    const start = performance.now();
    const fmt = args.format === 'compact' ? 'compact' : 'json';
    const meta = getSysContextMetadata();
    const out = formatSysContextMetadata(meta, fmt);
    return {
      pluginId: 'sys_context',
      pluginName: 'sys_context (Date, Time & Timezone)',
      inputSummary: `format=${fmt}`,
      outputSummary: out,
      durationMs: Math.max(1, Math.round(performance.now() - start))
    };
  }
};

export const systemContextPlugin: HotSwappableToolPlugin = {
  definition: {
    id: 'system_context',
    name: 'System Context & Local Clock (sys_context)',
    category: 'System',
    description:
      'Provides local date, time, timezone, operating system, and llama.cpp status when Octopus requests it.',
    parameterSummary: 'format?: "json" | "compact", section?: "all" | "time" | "runtime"',
    triggerKeywords: []
  },
  aliases: ['sys_context', 'clock', 'datetime', 'current_time', 'timezone'],
  schema: {
    name: 'system_context',
    description:
      'Returns real-time system date, local clock time, timezone, UTC offset, and local host runtime telemetry.',
    parameters: {
      type: 'OBJECT',
      properties: {
        format: {
          type: 'STRING',
          description: 'Output format: "json" (default) or "compact".'
        },
        section: {
          type: 'STRING',
          description: 'Metadata section: "all", "time", or "runtime".'
        }
      },
      required: []
    }
  },
  evaluateForPrompt: () => null,
  invokeDirect: (args) => {
    const start = performance.now();
    const fmt = args.format === 'compact' ? 'compact' : 'json';
    const meta = getSysContextMetadata();
    const out = formatSysContextMetadata(meta, fmt);
    return {
      pluginId: 'system_context',
      pluginName: 'System Context & Local Clock (sys_context)',
      inputSummary: `format=${fmt}`,
      outputSummary: out,
      durationMs: Math.max(1, Math.round(performance.now() - start))
    };
  }
};
