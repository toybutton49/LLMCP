import React, { useState } from 'react';
import {
  Shield,
  User,
  Cpu,
  Lock,
  Compass,
  Pin,
  Pencil,
  Check,
  X,
  Trash2,
  CheckCircle2,
  Circle,
  Tag,
  Sparkles
} from 'lucide-react';
import type { MemoryFactInput, MemoryCategory } from '../../utils/rag/ragTypes';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';

interface MemoryCardProps {
  memory: MemoryFactInput;
  onUpdate: (id: string, updates: Partial<Omit<MemoryFactInput, 'id'>>) => void;
  onToggle: (id: string) => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
}

export const MemoryCard: React.FC<MemoryCardProps> = ({
  memory,
  onUpdate,
  onToggle,
  onTogglePin,
  onDelete
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editKey, setEditKey] = useState(memory.key);
  const [editFact, setEditFact] = useState(memory.fact);
  const [editCategory, setEditCategory] = useState<MemoryCategory>(memory.category);
  const [editType, setEditType] = useState<'system' | 'user'>(memory.promptType || 'system');
  const [editImportance, setEditImportance] = useState(memory.importance || 3);
  const [editTagsText, setEditTagsText] = useState((memory.tags || []).join(', '));
  const [isConfirmDeleteOpen, setIsConfirmDeleteOpen] = useState(false);

  const handleSave = () => {
    if (!editKey.trim() || !editFact.trim()) return;
    const cleanTags = editTagsText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    onUpdate(memory.id, {
      key: editKey.trim(),
      fact: editFact.trim(),
      category: editCategory,
      promptType: editType,
      importance: editImportance,
      tags: cleanTags
    });
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditKey(memory.key);
    setEditFact(memory.fact);
    setEditCategory(memory.category);
    setEditType(memory.promptType || 'system');
    setEditImportance(memory.importance || 3);
    setEditTagsText((memory.tags || []).join(', '));
    setIsEditing(false);
  };

  const getCategoryBadge = (category: MemoryCategory) => {
    switch (category) {
      case 'constraint':
        return {
          icon: <Lock className="w-3 h-3 text-rose-400" />,
          label: 'Constraint',
          classes: 'bg-rose-950/40 text-rose-300 border-rose-800/40'
        };
      case 'architecture':
        return {
          icon: <Cpu className="w-3 h-3 text-violet-400" />,
          label: 'Architecture',
          classes: 'bg-violet-950/40 text-violet-300 border-violet-800/40'
        };
      case 'project':
        return {
          icon: <Compass className="w-3 h-3 text-emerald-400" />,
          label: 'Project',
          classes: 'bg-emerald-950/40 text-emerald-300 border-emerald-800/40'
        };
      case 'preference':
        return {
          icon: <User className="w-3 h-3 text-sky-400" />,
          label: 'Preference',
          classes: 'bg-sky-950/40 text-sky-300 border-sky-800/40'
        };
      case 'system_directive':
      default:
        return {
          icon: <Shield className="w-3 h-3 text-accent" />,
          label: 'Directive',
          classes: 'bg-accent/10 text-accent border-accent/20'
        };
    }
  };

  const badge = getCategoryBadge(memory.category);

  if (isEditing) {
    return (
      <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/90 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <input
            type="text"
            value={editKey}
            onChange={(e) => setEditKey(e.target.value)}
            placeholder="Topic Key"
            className="px-2.5 py-1 text-xs rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
          />
          <div className="flex items-center gap-2">
            <select
              value={editCategory}
              onChange={(e) => setEditCategory(e.target.value as MemoryCategory)}
              className="flex-1 px-2.5 py-1 text-xs rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
            >
              <option value="system_directive">System Directive</option>
              <option value="constraint">Constraint / Guardrail</option>
              <option value="architecture">Architecture Rule</option>
              <option value="preference">User Preference</option>
              <option value="project">Project Context</option>
            </select>
            <select
              value={editImportance}
              onChange={(e) => setEditImportance(Number(e.target.value))}
              className="w-20 px-2 py-1 text-xs rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
            >
              <option value={1}>Pri 1</option>
              <option value={2}>Pri 2</option>
              <option value={3}>Pri 3</option>
              <option value={4}>Pri 4</option>
              <option value={5}>Pri 5 (Max)</option>
            </select>
          </div>
        </div>

        <textarea
          rows={3}
          value={editFact}
          onChange={(e) => setEditFact(e.target.value)}
          placeholder="Detailed instruction or fact..."
          className="w-full p-2.5 text-xs rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
        />

        <div className="flex items-center justify-between gap-2">
          <input
            type="text"
            value={editTagsText}
            onChange={(e) => setEditTagsText(e.target.value)}
            placeholder="Tags (comma-separated, e.g. strict, typescript)"
            className="flex-1 px-2.5 py-1 text-xs rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
          />
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={handleSave}
              className="px-3 py-1 rounded bg-accent text-zinc-950 font-semibold text-xs flex items-center gap-1 cursor-pointer"
            >
              <Check className="w-3 h-3" />
              <span>Save</span>
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="px-2.5 py-1 rounded border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-400 cursor-pointer"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`p-3.5 rounded-xl border transition-all ${
        memory.isActive
          ? 'bg-white dark:bg-zinc-900/90 border-zinc-200 dark:border-zinc-800 shadow-sm'
          : 'bg-zinc-100/50 dark:bg-zinc-950/40 border-zinc-200 dark:border-zinc-800 opacity-60'
      }`}
    >
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate">
            {memory.key}
          </span>
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${badge.classes}`}
          >
            {badge.icon}
            <span>{badge.label}</span>
          </span>
          {memory.pinned && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent/20 text-accent border border-accent/30">
              <Pin className="w-2.5 h-2.5 fill-current" />
              <span>Pinned</span>
            </span>
          )}
          {typeof memory.importance === 'number' && memory.importance >= 4 && (
            <span className="text-[10px] text-zinc-400 font-mono">
              [P{memory.importance}]
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => onTogglePin(memory.id)}
            title={memory.pinned ? 'Unpin directive' : 'Pin directive (Always inject)'}
            className={`p-1 rounded cursor-pointer transition-colors ${
              memory.pinned ? 'text-accent' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Pin className={`w-3.5 h-3.5 ${memory.pinned ? 'fill-current' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => onToggle(memory.id)}
            title={memory.isActive ? 'Deactivate directive' : 'Activate directive'}
            className={`p-1 rounded cursor-pointer transition-colors ${
              memory.isActive ? 'text-accent' : 'text-zinc-400'
            }`}
          >
            {memory.isActive ? (
              <CheckCircle2 className="w-3.5 h-3.5" />
            ) : (
              <Circle className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            title="Edit directive"
            className="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer"
          >
            <Pencil className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => setIsConfirmDeleteOpen(true)}
            title="Delete directive"
            className="p-1 text-zinc-400 hover:text-rose-500 cursor-pointer"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed break-words">
        {memory.fact}
      </p>

      {(Boolean(memory.tags?.length) || (memory.accessCount ?? 0) > 0) && (
        <div className="mt-2.5 pt-2 border-t border-zinc-100 dark:border-zinc-800/80 flex items-center justify-between text-[11px] text-zinc-400">
          <div className="flex items-center gap-1.5 flex-wrap">
            {(memory.tags || []).map((tag, idx) => (
              <span
                key={idx}
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800/70 text-zinc-500 dark:text-zinc-400 text-[10px]"
              >
                <Tag className="w-2.5 h-2.5" />
                <span>#{tag}</span>
              </span>
            ))}
          </div>
          {typeof memory.accessCount === 'number' && memory.accessCount > 0 && (
            <span className="font-mono text-[10px] text-zinc-400">
              Probed {memory.accessCount}x
            </span>
          )}
        </div>
      )}

      <ConfirmDeleteModal
        isOpen={isConfirmDeleteOpen}
        onClose={() => setIsConfirmDeleteOpen(false)}
        onConfirm={() => {
          setIsConfirmDeleteOpen(false);
          onDelete(memory.id);
        }}
        title="Delete Directive?"
        description="Are you sure you want to delete this memory directive? This will remove the directive from persistent storage."
        itemName={memory.key}
        confirmLabel="Delete"
      />
    </div>
  );
};

