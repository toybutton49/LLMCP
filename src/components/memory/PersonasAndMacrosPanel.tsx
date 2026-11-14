import React, { useState } from 'react';
import {
  Sparkles,
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  ArrowRight
} from 'lucide-react';
import { SystemPromptTemplate } from '../../data/seedData';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';

interface PersonasAndMacrosPanelProps {
  promptTemplates: SystemPromptTemplate[];
  activeSystemPrompt: string;
  onAddPromptTemplate: (tpl: Omit<SystemPromptTemplate, 'id'>) => void;
  onUpdatePromptTemplate: (id: string, updates: Partial<Omit<SystemPromptTemplate, 'id'>>) => void;
  onDeletePromptTemplate: (id: string) => void;
  onApplyTemplateToActiveSession: (tpl: SystemPromptTemplate) => void;
}

export const PersonasAndMacrosPanel: React.FC<PersonasAndMacrosPanelProps> = ({
  promptTemplates,
  activeSystemPrompt,
  onAddPromptTemplate,
  onUpdatePromptTemplate,
  onDeletePromptTemplate,
  onApplyTemplateToActiveSession
}) => {
  const [tplName, setTplName] = useState('');
  const [tplCategory, setTplCategory] = useState('Engineering');
  const [tplPrompt, setTplPrompt] = useState('');
  const [tplTemp, setTplTemp] = useState(0.3);
  const [tplError, setTplError] = useState('');

  const [editingTplId, setEditingTplId] = useState<string | null>(null);
  const [editTplName, setEditTplName] = useState('');
  const [editTplCat, setEditTplCat] = useState('');
  const [editTplPrompt, setEditTplPrompt] = useState('');
  const [editTplTemp, setEditTplTemp] = useState(0.3);
  const [personaToDelete, setPersonaToDelete] = useState<SystemPromptTemplate | null>(null);

  const handleCreateTemplate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tplName.trim() || !tplPrompt.trim()) {
      setTplError('Please provide both a persona name and system instructions.');
      return;
    }
    setTplError('');
    onAddPromptTemplate({
      name: tplName.trim(),
      category: tplCategory.trim() || 'Engineering',
      roleCategory: tplCategory.trim() || 'Engineering',
      systemPrompt: tplPrompt.trim(),
      defaultTemperature: tplTemp
    });
    setTplName('');
    setTplPrompt('');
  };

  const startEditingTemplate = (tpl: SystemPromptTemplate) => {
    setEditingTplId(tpl.id);
    setEditTplName(tpl.name);
    setEditTplCat(tpl.roleCategory || tpl.category || 'Engineering');
    setEditTplPrompt(tpl.systemPrompt);
    setEditTplTemp(tpl.defaultTemperature);
  };

  const saveEditedTemplate = (id: string) => {
    if (!editTplName.trim() || !editTplPrompt.trim()) return;
    onUpdatePromptTemplate(id, {
      name: editTplName.trim(),
      category: editTplCat.trim() || 'Engineering',
      roleCategory: editTplCat.trim() || 'Engineering',
      systemPrompt: editTplPrompt.trim(),
      defaultTemperature: editTplTemp
    });
    setEditingTplId(null);
  };

  return (
    <div className="space-y-6">
      {/* Create Persona Form */}
      <form
        onSubmit={handleCreateTemplate}
        className="p-5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 space-y-4"
      >
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-accent" />
            <span>Create Custom Persona</span>
          </div>
          <span className="text-[11px] text-zinc-400 font-mono">
            Full control over model behavior
          </span>
        </div>

        {tplError && <div className="text-xs text-rose-500">{tplError}</div>}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input
            type="text"
            value={tplName}
            onChange={(e) => setTplName(e.target.value)}
            placeholder="Persona Name (e.g. Senior Security Auditor)"
            className="px-3 py-1.5 text-xs rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
          />
          <input
            type="text"
            value={tplCategory}
            onChange={(e) => setTplCategory(e.target.value)}
            placeholder="Role Category (e.g. Architecture)"
            className="px-3 py-1.5 text-xs rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
          />
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-zinc-400 whitespace-nowrap">
              Temp: {tplTemp.toFixed(2)}
            </span>
            <input
              type="range"
              min="0"
              max="1.5"
              step="0.05"
              value={tplTemp}
              onChange={(e) => setTplTemp(Number(e.target.value))}
              className="flex-1 accent-slider"
            />
          </div>
        </div>

        <textarea
          rows={4}
          value={tplPrompt}
          onChange={(e) => setTplPrompt(e.target.value)}
          placeholder="System prompt instructions for this persona..."
          className="w-full p-2.5 text-xs font-mono rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100"
        />

        <button
          type="submit"
          className="px-4 py-1.5 rounded-lg bg-accent text-zinc-950 text-xs font-semibold flex items-center gap-1.5 cursor-pointer ml-auto"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Save Persona</span>
        </button>
      </form>

      {/* Persona Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {promptTemplates.map((tpl) => {
          const isApplied = activeSystemPrompt.trim() === tpl.systemPrompt.trim();
          const isEditing = editingTplId === tpl.id;

          return (
            <div
              key={tpl.id}
              className={`p-4 rounded-xl border transition-all flex flex-col justify-between ${
                isApplied
                  ? 'border-accent bg-accent-subtle'
                  : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900'
              }`}
            >
              {isEditing ? (
                <div className="space-y-2.5">
                  <input
                    type="text"
                    value={editTplName}
                    onChange={(e) => setEditTplName(e.target.value)}
                    className="w-full px-2.5 py-1 text-xs rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800"
                  />
                  <input
                    type="text"
                    value={editTplCat}
                    onChange={(e) => setEditTplCat(e.target.value)}
                    className="w-full px-2.5 py-1 text-xs rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800"
                  />
                  <textarea
                    rows={4}
                    value={editTplPrompt}
                    onChange={(e) => setEditTplPrompt(e.target.value)}
                    className="w-full p-2 text-xs font-mono rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800"
                  />
                  <div className="flex justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => saveEditedTemplate(tpl.id)}
                      className="px-2.5 py-1 rounded bg-accent text-zinc-950 text-xs font-semibold"
                    >
                      <Check className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingTplId(null)}
                      className="px-2.5 py-1 rounded border border-zinc-200 dark:border-zinc-800 text-xs"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div>
                        <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                          <span>{tpl.name}</span>
                          {isApplied && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-accent-subtle text-accent border border-accent">
                              Active in Chat
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-zinc-400 font-mono mt-0.5">
                          {tpl.roleCategory || tpl.category || 'General'} · Temp {tpl.defaultTemperature}
                        </div>
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => startEditingTemplate(tpl)}
                          className="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setPersonaToDelete(tpl)}
                          className="p-1 text-zinc-400 hover:text-rose-500 cursor-pointer"
                          title="Delete Persona"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>

                    <p className="text-xs text-zinc-600 dark:text-zinc-400 line-clamp-3 leading-relaxed mb-3">
                      {tpl.systemPrompt}
                    </p>
                  </div>

                  <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800">
                    <button
                      type="button"
                      onClick={() => onApplyTemplateToActiveSession(tpl)}
                      className="w-full py-1.5 px-3 rounded-lg text-xs font-medium border border-zinc-200 dark:border-zinc-800 hover:border-accent text-zinc-700 dark:text-zinc-300 hover:text-accent flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <span>Apply to Current Chat</span>
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDeleteModal
        isOpen={!!personaToDelete}
        onClose={() => setPersonaToDelete(null)}
        onConfirm={() => {
          if (personaToDelete) {
            onDeletePromptTemplate(personaToDelete.id);
            setPersonaToDelete(null);
          }
        }}
        title="Delete Persona?"
        description="Are you sure you want to delete this persona? This action cannot be undone."
        itemName={personaToDelete?.name}
        confirmLabel="Delete"
      />
    </div>
  );
};
