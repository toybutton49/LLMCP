import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import os from 'node:os';
import path from 'path';
import {defineConfig} from 'vite';

const srcRoot = `${path.resolve(import.meta.dirname, 'src').replaceAll('\\', '/')}/`;
const srcRootLower = srcRoot.toLowerCase();

function normalizeModuleId(id: string): string {
  if (id.startsWith('\0')) {
    return '';
  }
  const normalized = id.replaceAll('\\', '/');
  const queryIndex = normalized.indexOf('?');
  return queryIndex === -1 ? normalized : normalized.slice(0, queryIndex);
}

function getNodeModulePath(id: string): string | null {
  const normalized = normalizeModuleId(id);
  const marker = '/node_modules/';
  const index = normalized.lastIndexOf(marker);
  return index === -1 ? null : normalized.slice(index + marker.length);
}

function getProjectSrcPath(id: string): string | null {
  const normalized = normalizeModuleId(id);
  if (!normalized.toLowerCase().startsWith(srcRootLower)) {
    return null;
  }
  return normalized.slice(srcRoot.length);
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    envDir: false as const,
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            minSize: 10_000,
            groups: [
              {
                name: 'react-vendor',
                priority: 30,
                test: (id) => {
                  const pkg = getNodeModulePath(id);
                  return (
                    pkg !== null &&
                    (pkg.startsWith('react/') ||
                      pkg.startsWith('react-dom/') ||
                      pkg.startsWith('scheduler/'))
                  );
                },
              },
              {
                name: 'ui-vendor',
                priority: 25,
                test: (id) => {
                  const pkg = getNodeModulePath(id);
                  return (
                    pkg !== null &&
                    (pkg.startsWith('lucide-react/') || pkg.startsWith('motion/'))
                  );
                },
              },
              {
                name: 'vendor',
                priority: 20,
                test: (id) => getNodeModulePath(id) !== null,
              },
              {
                name: 'workspace-core',
                priority: 15,
                test: (id) => {
                  const rel = getProjectSrcPath(id);
                  return (
                    rel !== null &&
                    (rel.startsWith('data/') ||
                      rel.startsWith('utils/') ||
                      rel.startsWith('tools/') ||
                      rel.startsWith('orchestrators/'))
                  );
                },
              },
              {
                name: 'workspace-views',
                priority: 10,
                test: (id) => {
                  const rel = getProjectSrcPath(id);
                  return (
                    rel !== null &&
                    (rel.startsWith('components/settings/') ||
                      rel === 'components/SettingsView.tsx' ||
                      rel.startsWith('components/analytics/') ||
                      rel.startsWith('components/memory/') ||
                      rel === 'components/MemoryAndPromptsView.tsx' ||
                      rel.startsWith('components/rag/') ||
                      rel.startsWith('components/tools/') ||
                      rel.startsWith('components/database/') ||
                      rel.startsWith('components/orchestrator/'))
                  );
                },
              },
            ],
          },
        },
      },
    },
    server: {
      allowedHosts: [
        '.ts.net',
        '.local',
        os.hostname().toLowerCase(),
      ].filter(Boolean),
      // Keep user data (chats, vector DB, uploads, model files) out of the static file server.
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local-data/**', '**/.test-data/**', '**/models/**', '**/*.gguf'],
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify - file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch:
        process.env.DISABLE_HMR === 'true'
          ? null
          : {
              ignored: [
                '**/models/**',
                '**/llmcp/models/**',
                '**/.local-data/**',
                '**/.test-data/**',
                '**/*.gguf',
              ],
            },
    },
  };
});
