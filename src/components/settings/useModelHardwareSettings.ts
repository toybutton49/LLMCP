import { useEffect, useState } from 'react';
import type { AppSettings } from './GgufAndHardwareSection';

export function useModelHardwareSettings(
  model: string,
  setLocalSettings: React.Dispatch<React.SetStateAction<AppSettings>>,
  setSettings?: React.Dispatch<React.SetStateAction<AppSettings>>
) {
  const [configError, setConfigError] = useState('');
  const [configuredModel, setConfiguredModel] = useState('');

  useEffect(() => {
    if (!model) {
      setConfiguredModel('');
      return;
    }
    const controller = new AbortController();
    setConfiguredModel('');
    setConfigError('');
    fetch('/api/native/model-configs', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Model configuration request failed (${response.status}).`);
        return response.json() as Promise<{
          configs: Record<string, {
            contextSize: number; gpuLayers: number | 'auto'; threads: number; flashAttention: boolean;
          }>;
          defaultConfig: { contextSize: number; gpuLayers: number | 'auto'; threads: number; flashAttention: boolean };
        }>;
      })
      .then(({ configs, defaultConfig }) => {
        if (controller.signal.aborted) return;
        const config = configs[model] || defaultConfig;
        const apply = (prev: AppSettings): AppSettings => ({
          ...prev,
          defaultContextLength: config?.contextSize ?? 8192,
          llamaGpuLayers: config?.gpuLayers === 'auto' ? -1 : config?.gpuLayers ?? -1,
          llamaThreads: config?.threads ?? 8,
          flashAttention: config?.flashAttention ?? true
        });
        setLocalSettings(apply);
        setSettings?.(apply);
        setConfiguredModel(model);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setConfigError(error instanceof Error ? error.message : 'Model configuration could not be loaded.');
      });
    return () => controller.abort();
  }, [model, setLocalSettings, setSettings]);

  return { configError, configuredModel };
}
