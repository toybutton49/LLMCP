import React, { useState } from 'react';
import { Brain, Info, SlidersHorizontal, UserCheck } from 'lucide-react';
import { GENERATION_DEFAULTS, HARDWARE_DEFAULTS } from '../../data/runtimeDefaults';
import type { AppSettings } from './GgufAndHardwareSection';
import type { SystemPromptTemplate } from '../../data/seedData';

export interface GlobalGenerationDefaultsSectionProps {
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  promptTemplates?: SystemPromptTemplate[];
  onSelectPersona?: (template: SystemPromptTemplate) => void;
}

const SettingTooltip: React.FC<{
  id: string;
  label: string;
  tooltip: string;
  activeId: string | null;
  onToggle: (id: string | null) => void;
}> = ({ id, label, tooltip, activeId, onToggle }) => {
  const isOpen = activeId === id;
  return (
    <span className="relative inline-flex items-center gap-1.5">
      <span className="font-medium text-zinc-200">{label}</span>
      <button
        type="button"
        aria-label={`Info for ${label}`}
        title={tooltip}
        onMouseEnter={() => onToggle(id)}
        onMouseLeave={() => onToggle(null)}
        onFocus={() => onToggle(id)}
        onBlur={() => onToggle(null)}
        onClick={(e) => {
          e.preventDefault();
          onToggle(isOpen ? null : id);
        }}
        className="p-0.5 rounded text-zinc-400 hover:text-accent focus:outline-none cursor-help shrink-0"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {isOpen && (
        <span
          role="tooltip"
          className="absolute left-0 bottom-full mb-1.5 z-40 w-64 p-2.5 rounded-lg border border-zinc-700 bg-zinc-950 text-zinc-200 shadow-xl text-xs font-normal leading-relaxed pointer-events-none"
        >
          {tooltip}
        </span>
      )}
    </span>
  );
};

export const GlobalGenerationDefaultsSection: React.FC<GlobalGenerationDefaultsSectionProps> = ({
  settings,
  setSettings,
  promptTemplates = [],
  onSelectPersona
}) => {
  const [activeTooltipId, setActiveTooltipId] = useState<string | null>(null);
  const currentPrompt = (settings.systemInstruction || '').trim();
  const matchedPersona = currentPrompt
    ? promptTemplates.find((tpl) => tpl.systemPrompt.trim() === currentPrompt)
    : undefined;
  const activePersonaValue = !currentPrompt
    ? '__none__'
    : matchedPersona?.id || '__custom__';

  const clampedThinkingBudget = Math.min(
    GENERATION_DEFAULTS.maxThinkingBudget,
    Math.max(GENERATION_DEFAULTS.minThinkingBudget, settings.thinkingBudget || GENERATION_DEFAULTS.thinkingBudget)
  );
  const clampedMaxOutput = Math.min(
    GENERATION_DEFAULTS.maxMaxTokens,
    Math.max(GENERATION_DEFAULTS.minMaxTokens, settings.maxOutputTokens ?? GENERATION_DEFAULTS.maxTokens)
  );

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 space-y-5">
      <div>
        <h4 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-accent" />
          Global Generation Defaults
        </h4>
        <p className="text-xs text-zinc-400 mt-1">
          Starts with an 8 GB baseline of {HARDWARE_DEFAULTS.contextSize.toLocaleString()} context tokens, {GENERATION_DEFAULTS.thinkingBudget.toLocaleString()} reasoning tokens, and {GENERATION_DEFAULTS.maxTokens.toLocaleString()} response tokens. Adjust for your model and available memory.
        </p>
      </div>

      {promptTemplates.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <label htmlFor="settings-active-persona" className="text-xs font-semibold text-zinc-200 flex items-center gap-2">
              <UserCheck className="w-3.5 h-3.5 text-accent" /> Active Persona
            </label>
            <select
              id="settings-active-persona"
              aria-label="Active persona"
              value={activePersonaValue}
              onChange={(event) => {
                const val = event.target.value;
                if (val === '__none__') {
                  const noneTpl: SystemPromptTemplate = promptTemplates.find((t) => t.id === 'persona_none') || {
                    id: 'persona_none',
                    name: 'Default - No Persona',
                    systemPrompt: '',
                    defaultTemperature: settings.temperature
                  };
                  setSettings((prev) => ({
                    ...prev,
                    systemInstruction: '',
                    temperature: noneTpl.defaultTemperature
                  }));
                  onSelectPersona?.({ ...noneTpl, systemPrompt: '' });
                  return;
                }
                const tpl = promptTemplates.find((t) => t.id === val);
                if (tpl) {
                  setSettings((prev) => ({
                    ...prev,
                    systemInstruction: tpl.systemPrompt,
                    temperature: tpl.defaultTemperature
                  }));
                  onSelectPersona?.(tpl);
                }
              }}
              className="w-full sm:max-w-sm rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-xs font-medium text-zinc-100 focus-accent cursor-pointer"
            >
              <option value="__none__">Default - No Persona (Raw Model)</option>
              {activePersonaValue === '__custom__' && (
                <option value="__custom__">Custom Persona Instructions</option>
              )}
              {promptTemplates
                .filter((tpl) => tpl.id !== 'persona_none')
                .map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name}
                  </option>
                ))}
            </select>
          </div>
          {currentPrompt && (
            <p className="text-xs text-zinc-400 bg-zinc-900/70 border border-zinc-800 rounded-lg px-3.5 py-2.5 leading-relaxed">
              {currentPrompt}
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-4 space-y-4">
          <h5 className="text-xs font-semibold text-zinc-200">
            Sampling Controls
          </h5>
          {([
            {
              key: 'temperature',
              label: 'Temperature',
              tooltip: 'Controls how creative or predictable replies are. Lower values (0.1 - 0.4) keep answers factual and steady; higher values (0.7 - 1.2) encourage more variety and brainstorming.',
              min: 0,
              max: 1.5,
              step: 0.05,
              value: settings.temperature,
              display: settings.temperature.toFixed(2)
            },
            {
              key: 'topP',
              label: 'Top P',
              tooltip: 'Filters out unlikely word choices. At 0.90, Octopus only picks from the top 90% most probable next words, avoiding strange tangents while keeping phrasing natural.',
              min: 0.1,
              max: 1,
              step: 0.05,
              value: settings.topP,
              display: settings.topP.toFixed(2)
            },
            {
              key: 'repeatPenalty',
              label: 'Repeat Penalty',
              tooltip: 'Discourages Octopus from repeating the same words or phrases in a loop. 1.00 applies no penalty; 1.10 - 1.20 keeps writing fresh without sounding unnatural.',
              min: 1,
              max: 2,
              step: 0.05,
              value: settings.repeatPenalty ?? 1.1,
              display: (settings.repeatPenalty ?? 1.1).toFixed(2)
            }
          ] as const).map((control) => (
            <div key={control.key} className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-zinc-300">
                <SettingTooltip
                  id={`sampling-${control.key}`}
                  label={control.label}
                  tooltip={control.tooltip}
                  activeId={activeTooltipId}
                  onToggle={setActiveTooltipId}
                />
                <output className="font-mono text-accent">{control.display}</output>
              </div>
              <input
                type="range"
                aria-label={control.label}
                min={control.min}
                max={control.max}
                step={control.step}
                value={control.value}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setSettings((previous) => ({ ...previous, [control.key]: value }));
                }}
                className="w-full accent-slider"
              />
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-4 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h5 className="text-xs font-semibold text-zinc-200 flex items-center gap-2">
              <Brain className="w-3.5 h-3.5 text-accent" /> Reasoning &amp; Output
            </h5>
            <span className="text-[11px] text-zinc-400">8 GB baseline: {GENERATION_DEFAULTS.thinkingBudget.toLocaleString()} reasoning tokens</span>
          </div>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-zinc-200">Reasoning Mode</span>
            <select
              aria-label="Global reasoning mode"
              value={settings.enableThinking ? settings.reasoningEffort ?? 'medium' : 'off'}
              onChange={(event) => {
                const value = event.target.value;
                setSettings((previous) => ({
                  ...previous,
                  enableThinking: value !== 'off',
                  reasoningEffort: value === 'off' ? previous.reasoningEffort ?? 'medium' : value as 'low' | 'medium' | 'high'
                }));
              }}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-xs font-medium text-zinc-100 focus-accent"
            >
              <option value="off">Off</option>
              <option value="low">Low</option>
              <option value="medium">Balanced</option>
              <option value="high">High</option>
            </select>
          </label>
          {settings.enableThinking && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2 text-xs text-zinc-300">
                <SettingTooltip
                  id="reasoning-budget"
                  label="Reasoning Token Budget"
                  tooltip={`How much of the response budget can be used for reasoning before the answer. The 8 GB baseline starts at ${GENERATION_DEFAULTS.thinkingBudget.toLocaleString()} tokens to leave room for both retrieved context and the final response.`}
                  activeId={activeTooltipId}
                  onToggle={setActiveTooltipId}
                />
                <input
                  type="number"
                  aria-label="Global reasoning token budget value"
                  min={GENERATION_DEFAULTS.minThinkingBudget}
                  max={GENERATION_DEFAULTS.maxThinkingBudget}
                  step={1}
                  value={clampedThinkingBudget}
                  onChange={(event) => {
                    const parsed = Math.round(Number(event.target.value));
                    if (!Number.isFinite(parsed)) return;
                    const clamped = Math.max(GENERATION_DEFAULTS.minThinkingBudget, Math.min(GENERATION_DEFAULTS.maxThinkingBudget, parsed));
                    setSettings((previous) => ({ ...previous, thinkingBudget: clamped }));
                  }}
                  className="w-28 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-right font-mono text-xs text-accent focus-accent"
                />
              </div>
              <input
                type="range"
                aria-label="Global reasoning token budget"
                min={GENERATION_DEFAULTS.minThinkingBudget}
                max={GENERATION_DEFAULTS.maxThinkingBudget}
                step={64}
                value={clampedThinkingBudget}
                onChange={(event) => setSettings((previous) => ({
                  ...previous,
                  thinkingBudget: Number(event.target.value)
                }))}
                className="w-full accent-slider"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs text-zinc-300">
              <SettingTooltip
                id="max-response-tokens"
                label="Maximum Response Tokens"
                tooltip="The longest answer Octopus can write in a single reply (about 750 words per 1,000 tokens). 2,048 - 4,096 tokens fits comfortably within an 8 GB VRAM context window."
                activeId={activeTooltipId}
                onToggle={setActiveTooltipId}
              />
              <input
                type="number"
                aria-label="Global maximum response tokens value"
                min={GENERATION_DEFAULTS.minMaxTokens}
                max={GENERATION_DEFAULTS.maxMaxTokens}
                step={1}
                value={clampedMaxOutput}
                onChange={(event) => {
                  const parsed = Math.round(Number(event.target.value));
                  if (!Number.isFinite(parsed)) return;
                  const clamped = Math.max(GENERATION_DEFAULTS.minMaxTokens, Math.min(GENERATION_DEFAULTS.maxMaxTokens, parsed));
                  setSettings((previous) => ({ ...previous, maxOutputTokens: clamped }));
                }}
                className="w-28 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-right font-mono text-xs text-accent focus-accent"
              />
            </div>
            <input
              type="range"
              aria-label="Global maximum response tokens"
              min={GENERATION_DEFAULTS.minMaxTokens}
              max={GENERATION_DEFAULTS.maxMaxTokens}
              step={64}
              value={clampedMaxOutput}
              onChange={(event) => setSettings((previous) => ({
                ...previous,
                maxOutputTokens: Number(event.target.value)
              }))}
              className="w-full accent-slider"
            />
          </div>
        </div>
      </div>
    </section>
  );
};

