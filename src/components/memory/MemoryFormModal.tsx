import React, { useState } from 'react';
import {
  Plus,
  X,
  Shield,
  User,
  Cpu,
  Lock,
  Compass,
  Pin
} from 'lucide-react';
import type { MemoryFactInput, MemoryCategory } from '../../utils/rag/ragTypes';

interface MemoryFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddMemory: (mem: Omit<MemoryFactInput, 'id'>) => void;
}

export const MemoryFormModal: React.FC<MemoryFormModalProps> = ({
  isOpen,
  onClose,
  onAddMemory
}) => {
  const [promptType, setPromptType] = useState<'system' | 'user'>('system');
  const [category, setCategory] = useState<MemoryCategory>('system_directive');
  const [memKey, setMemKey] = useState('');
  const [memFact, setMemFact] = useState('');
  const [pinned, setPinned] = useState(false);
  const [importance, setImportance] = useState(3);
  const [tagsText, setTagsText] = useState('');
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!memKey.trim() || !memFact.trim()) {
      setError('Please provide both a directive topic and instructions.');
      return;
    }
    setError('');

    const cleanTags = tagsText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    onAddMemory({
      key: memKey.trim(),
      fact: memFact.trim(),
      category,
      promptType,
      isActive: true,
      pinned,
      importance,
      tags: cleanTags,
      source: 'manual',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    setPromptType('system');
    setCategory('system_directive');
    setMemKey('');
    setMemFact('');
    setPinned(false);
    setImportance(3);
    setTagsText('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
      <div className="w-full max-w-lg rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-accent/10 text-accent">
              <Plus className="w-4 h-4" />
            </div>
            <h2 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
              Create Persistent Memory Directive
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 sm:p-5 space-y-4">
          {error && <div className="text-xs text-rose-500">{error}</div>}

          {/* Prompt Type Radio */}
          <div className="flex items-center gap-4 text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="modalPromptType"
                checked={promptType === 'system'}
                onChange={() => {
                  setPromptType('system');
                  setCategory('system_directive');
                }}
                className="text-accent"
              />
              <span>System Directive</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="modalPromptType"
                checked={promptType === 'user'}
                onChange={() => {
                  setPromptType('user');
                  setCategory('preference');
                }}
                className="text-accent"
              />
              <span>User Preference</span>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                Directive Topic
              </label>
              <input
                type="text"
                value={memKey}
                onChange={(e) => setMemKey(e.target.value)}
                placeholder="e.g. Code Formatting"
                className="w-full px-3 py-1.5 text-xs rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                Category
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as MemoryCategory)}
                className="w-full px-3 py-1.5 text-xs rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
              >
                <option value="system_directive">System Directive</option>
                <option value="constraint">Constraint / Guardrail</option>
                <option value="architecture">Architecture Rule</option>
                <option value="preference">User Preference</option>
                <option value="project">Project Context</option>
                <option value="workflow">Workflow Habit</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-zinc-400 mb-1">
              Instructions / Fact Content
            </label>
            <textarea
              rows={3}
              value={memFact}
              onChange={(e) => setMemFact(e.target.value)}
              placeholder="What the AI must remember or adhere to..."
              className="w-full p-2.5 text-xs rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                Importance Level
              </label>
              <select
                value={importance}
                onChange={(e) => setImportance(Number(e.target.value))}
                className="w-full px-3 py-1.5 text-xs rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
              >
                <option value={1}>1 - Low Priority</option>
                <option value={2}>2 - Standard</option>
                <option value={3}>3 - Important</option>
                <option value={4}>4 - High Priority</option>
                <option value={5}>5 - Maximum (Always honored)</option>
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                Tags (Comma-separated)
              </label>
              <input
                type="text"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder="e.g. strict, ts, api"
                className="w-full px-3 py-1.5 text-xs rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <label className="flex items-center gap-2 cursor-pointer text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={pinned}
                onChange={(e) => setPinned(e.target.checked)}
                className="rounded text-accent"
              />
              <span className="flex items-center gap-1">
                <Pin className="w-3 h-3 text-accent" />
                <span>Pin Directive (Always inject into context window)</span>
              </span>
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-400 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 rounded-lg bg-accent text-zinc-950 font-semibold text-xs flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Save Directive</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

