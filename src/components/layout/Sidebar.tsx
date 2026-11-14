import React from 'react';
import {
  MessageSquare, HardDrive, Brain, Wrench, BarChart2, Settings,
  Plus, Pencil, Check, Trash2, Search, X, PanelLeftClose, PanelLeftOpen, HelpCircle
} from 'lucide-react';
import { WorkspaceSession } from '../../data/seedData';
import { LocalProviderId, WorkbenchAccentId, WorkspaceBranding } from '../../utils/rag';
import { LlmcpLogo } from './LlmcpLogo';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';

export type WorkspaceTab = 'chat' | 'rag' | 'memory' | 'tools' | 'plugins' | 'analytics' | 'gateway';

export interface SidebarProps {
  branding: WorkspaceBranding;
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  sessions: WorkspaceSession[];
  activeSessionId: string;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onRenameSession?: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  accentTheme: WorkbenchAccentId;
  onSelectAccentTheme: (accent: WorkbenchAccentId) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  vaultFileCount: number;
  ragDocCount: number;
  activeMemoryCount: number;
  activeProviderId: LocalProviderId;
  activeModelId: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onOpenQuickStart?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  branding,
  activeTab,
  onSelectTab,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onRenameSession,
  onDeleteSession,
  searchQuery,
  onSearchChange,
  mobileOpen,
  onCloseMobile,
  vaultFileCount,
  ragDocCount,
  activeMemoryCount,
  activeModelId,
  collapsed = false,
  onToggleCollapse,
  onOpenQuickStart
}) => {
  const [sessionToDelete, setSessionToDelete] = React.useState<WorkspaceSession | null>(null);
  const [renamingSessionId, setRenamingSessionId] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState('');
  const navItems: Array<{
    id: WorkspaceTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badgeCount?: number;
    description: string;
  }> = [
    {
      id: 'chat',
      label: 'Chat',
      icon: MessageSquare,
      badgeCount: sessions.length,
      description: 'Chat with your local AI model'
    },
    {
      id: 'rag',
      label: branding.ragLabel || 'File Repo',
      icon: HardDrive,
      badgeCount: vaultFileCount + ragDocCount,
      description: 'Unified document & file context'
    },
    {
      id: 'memory',
      label: 'Memory & Personas',
      icon: Brain,
      badgeCount: activeMemoryCount,
      description: 'Global directives & AI roles'
    },
    {
      id: 'tools',
      label: 'Tools & Plugins',
      icon: Wrench,
      description: 'Callable AI tools, MCP filesystem & web search'
    },
    {
      id: 'analytics',
      label: 'Usage & Logs',
      icon: BarChart2,
      description: 'Granular token graphs, context allocation & pipeline logs'
    },
    {
      id: 'gateway',
      label: 'Settings',
      icon: Settings,
      description: 'Engine routing, appearance & storage'
    }
  ];

  const desktopWidthClass = collapsed ? 'lg:w-16' : 'lg:w-64';
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredSessions = normalizedSearch
    ? sessions.filter((s) => s.title.toLowerCase().includes(normalizedSearch))
    : sessions;

  const sidebarContent = (
    <aside
      data-testid="app-sidebar"
      data-collapsed={collapsed ? 'true' : 'false'}
      className={`flex flex-col h-full w-64 ${desktopWidthClass} bg-zinc-50 dark:bg-zinc-950 border-r border-zinc-200 dark:border-zinc-800/80 select-none shrink-0 transition-[width] duration-200`}
    >
      {/* Brand Header (Octopus Emblem) */}
      <div
        className={`h-14 px-3 flex items-center ${
          collapsed ? 'justify-center' : 'justify-between'
        } border-b border-zinc-200 dark:border-zinc-800/80`}
      >
        {!collapsed && (
          <div className="flex items-center gap-2.5 min-w-0">
            {/* Octopus Emblem Logo */}
            <LlmcpLogo variant="mark" size="md" />
          </div>
        )}

        <div className="flex items-center gap-1">
          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              data-testid="sidebar-collapse-toggle"
              title={collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="hidden lg:inline-flex p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              {collapsed ? (
                <PanelLeftOpen className="w-4 h-4" />
              ) : (
                <PanelLeftClose className="w-4 h-4" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Close navigation menu"
            className="lg:hidden p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Collapsed Mark Emblem when Sidebar is Collapsed */}
      {collapsed && (
        <div className="hidden lg:flex flex-col items-center py-2.5 border-b border-zinc-200 dark:border-zinc-800/80 gap-2">
          <LlmcpLogo variant="mark" size="sm" />
          <button
            type="button"
            onClick={() => {
              onNewSession();
              onSelectTab('chat');
            }}
            title="Start New Chat"
            aria-label="Start New Chat"
            className="p-2 rounded-lg bg-accent text-zinc-950 shadow-xs transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Primary Workspace Navigation */}
      <div className="p-2 space-y-0.5 border-b border-zinc-200 dark:border-zinc-800/80">
        {!collapsed && (
          <div className="px-2 py-1 flex items-center justify-between">
            <span className="kicker-label text-zinc-400 dark:text-zinc-500">
              Workspaces
            </span>
            {onOpenQuickStart && (
              <button
                type="button"
                onClick={onOpenQuickStart}
                className="inline-flex items-center gap-1 text-[10px] font-medium text-accent hover:underline cursor-pointer"
                title="Open Quick Start Guide"
              >
                <HelpCircle className="w-3 h-3" />
                <span>Guide</span>
              </button>
            )}
          </div>
        )}
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectTab(item.id);
                onCloseMobile();
              }}
              title={`${item.label}: ${item.description}`}
              aria-label={item.label}
              className={`w-full flex items-center ${
                collapsed ? 'lg:justify-center lg:px-0' : 'justify-between px-2.5'
              } py-2 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                isActive
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 shadow-xs'
                  : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/70 dark:hover:bg-zinc-900 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              <span className="flex items-center gap-2.5 truncate">
                <Icon
                  className={`w-4 h-4 shrink-0 ${
                    isActive
                      ? 'text-accent'
                      : 'text-zinc-400 dark:text-zinc-500'
                  }`}
                />
                <span className={`truncate ${collapsed ? 'lg:hidden' : ''}`}>{item.label}</span>
              </span>
              {typeof item.badgeCount === 'number' && !collapsed && (
                <span
                  className={`text-[11px] tabular-nums px-1.5 py-0.5 rounded ${
                    isActive
                      ? 'bg-zinc-800 text-zinc-200 dark:bg-zinc-200 dark:text-zinc-800'
                      : 'bg-zinc-200/70 dark:bg-zinc-800/80 text-zinc-600 dark:text-zinc-400'
                  }`}
                >
                  {item.badgeCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Chat Sessions List (Hidden on Desktop when Collapsed) */}
      <div
        className={`flex-1 flex flex-col min-h-0 p-2.5 ${
          collapsed ? 'lg:hidden' : ''
        }`}
      >
        <div className="flex items-center justify-between mb-2 px-1">
          <span className="kicker-label text-zinc-400 dark:text-zinc-500">
            Conversations ({sessions.length})
          </span>
          <button
            type="button"
            onClick={() => {
              onNewSession();
              onSelectTab('chat');
              onCloseMobile();
            }}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:opacity-80 transition-opacity cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Chat</span>
          </button>
        </div>

        {/* Search Input */}
        <div className="relative mb-2">
          <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            id="sidebar-chat-filter-input"
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Filter chats (Ctrl+K)..."
            aria-label="Filter chats"
            className="w-full pl-8 pr-7 py-1.5 text-xs rounded-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 focus-accent"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              aria-label="Clear chat filter"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Scrollable Session List */}
        <div className="flex-1 overflow-y-auto space-y-1 pr-0.5">
          {filteredSessions.length === 0 ? (
            <div className="text-center py-6 px-2 text-xs text-zinc-400 dark:text-zinc-500">
              No matching chats.
            </div>
          ) : (
            filteredSessions.map((session) => {
              const isSelected = session.id === activeSessionId && activeTab === 'chat';
              const isRenaming = renamingSessionId === session.id;
              return (
                <div
                  key={session.id}
                  onClick={() => {
                    if (isRenaming) return;
                    onSelectSession(session.id);
                    onSelectTab('chat');
                    onCloseMobile();
                  }}
                  className={`group flex items-center justify-between px-2.5 py-2 rounded-md cursor-pointer transition-colors ${
                    isSelected
                      ? 'bg-zinc-200/80 dark:bg-zinc-800/90 text-zinc-900 dark:text-zinc-100'
                      : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/40 dark:hover:bg-zinc-900/60 hover:text-zinc-900 dark:hover:text-zinc-200'
                  }`}
                >
                  {isRenaming ? (
                    <div className="flex items-center gap-1 min-w-0 flex-1" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        aria-label="Rename conversation"
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            if (renameDraft.trim()) onRenameSession?.(session.id, renameDraft.trim());
                            setRenamingSessionId(null);
                          } else if (e.key === 'Escape') {
                            setRenamingSessionId(null);
                          }
                        }}
                        autoFocus
                        className="min-w-0 flex-1 px-1.5 py-0.5 text-xs rounded border border-accent bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 focus:outline-none"
                      />
                      <button
                        type="button"
                        aria-label="Save conversation name"
                        onClick={() => {
                          if (renameDraft.trim()) onRenameSession?.(session.id, renameDraft.trim());
                          setRenamingSessionId(null);
                        }}
                        className="p-1 rounded text-accent hover:bg-zinc-300/40 dark:hover:bg-zinc-700/50 cursor-pointer"
                      >
                        <Check className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        aria-label="Cancel rename"
                        onClick={() => setRenamingSessionId(null)}
                        className="p-1 rounded text-zinc-400 hover:text-zinc-200 cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="min-w-0 flex-1 pr-2">
                        <div className="text-xs font-medium truncate">{session.title}</div>
                        <div className="flex items-center gap-1.5 mt-0.5 text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
                          <span className="truncate">{session.modelId || activeModelId || 'GGUF Brain'}</span>
                          <span>·</span>
                          <span>{session.messageCount} msgs</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {onRenameSession && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenameDraft(session.title);
                              setRenamingSessionId(session.id);
                            }}
                            title="Rename conversation"
                            aria-label={`Rename conversation ${session.title}`}
                            className="opacity-0 group-hover:opacity-100 p-1 rounded text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-300/40 dark:hover:bg-zinc-700/50 transition-all cursor-pointer"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSessionToDelete(session);
                          }}
                          title="Delete conversation"
                          aria-label={`Delete conversation ${session.title}`}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded text-zinc-400 hover:text-rose-500 hover:bg-zinc-300/40 dark:hover:bg-zinc-700/50 transition-all cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Spacer when collapsed on desktop */}
      {collapsed && <div className="hidden lg:block flex-1" />}

      {/* Footer: Active Brain Engine Status & Settings Link */}
      <div className="p-2.5 border-t border-zinc-200 dark:border-zinc-800/80 bg-zinc-100/60 dark:bg-zinc-900/40 space-y-1.5">
        {!collapsed ? (
          <div className="flex items-center justify-between px-1 text-xs gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
              <span className="text-zinc-600 dark:text-zinc-300 text-xs truncate">
                {activeModelId || 'Built-in server (.gguf)'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => onSelectTab('gateway')}
              className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:underline cursor-pointer"
              title="Open Settings"
            >
              Config
            </button>
          </div>
        ) : (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => onSelectTab('gateway')}
              title="Open Settings"
              className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </aside>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      <div className="hidden lg:block h-full">{sidebarContent}</div>

      {/* Mobile Drawer Overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-xs"
            onClick={onCloseMobile}
          />
          <div className="relative z-10 h-full">{sidebarContent}</div>
        </div>
      )}

      <ConfirmDeleteModal
        isOpen={!!sessionToDelete}
        onClose={() => setSessionToDelete(null)}
        onConfirm={() => {
          if (sessionToDelete) {
            onDeleteSession(sessionToDelete.id);
            setSessionToDelete(null);
          }
        }}
        title="Delete Conversation?"
        description="Are you sure you want to delete this conversation? All messages in this session will be permanently removed."
        itemName={sessionToDelete?.title}
        confirmLabel="Delete"
      />
    </>
  );
};
