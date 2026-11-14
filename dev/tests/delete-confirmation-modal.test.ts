import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();

test('Delete Confirmation Modal: Component exists, is accessible, and adheres to strict hygiene', () => {
  const modalPath = path.join(
    ROOT_DIR,
    'src',
    'components',
    'modals',
    'ConfirmDeleteModal.tsx'
  );
  assert.equal(fs.existsSync(modalPath), true, 'ConfirmDeleteModal.tsx must exist');

  const content = fs.readFileSync(modalPath, 'utf-8');
  const lines = content.split('\n').length;
  assert.ok(lines <= 500, `ConfirmDeleteModal lines (${lines}) must be <= 500`);

  // Accessibility and dialog semantics
  assert.ok(content.includes('role="dialog"'), 'Must have role="dialog"');
  assert.ok(content.includes('aria-modal="true"'), 'Must have aria-modal="true"');
  assert.ok(content.includes('aria-labelledby'), 'Must have aria-labelledby');
  assert.ok(content.includes('aria-describedby'), 'Must have aria-describedby');
  assert.ok(content.includes("e.key === 'Escape'"), 'Must close on Escape key');
  assert.ok(content.includes('onClose'), 'Must handle onClose');
  assert.ok(content.includes('onConfirm'), 'Must handle onConfirm');
  assert.ok(content.includes('Are you sure?'), 'Default title must ask Are you sure?');
  assert.ok(
    content.includes('Are you sure you want to delete this item?'),
    'Default description must contain Are you sure you want to delete this item?'
  );
});

test('Delete Confirmation Modal: Integrated into all application delete and clear actions', () => {
  const deleteActions: Array<{
    fileRelPath: string;
    descriptionKeyword: string;
    titleKeyword: string;
  }> = [
    {
      fileRelPath: 'src/components/layout/Sidebar.tsx',
      titleKeyword: 'Delete Conversation?',
      descriptionKeyword: 'Are you sure you want to delete this conversation?'
    },
    {
      fileRelPath: 'src/components/chat/ChatMessageList.tsx',
      titleKeyword: 'Delete Message?',
      descriptionKeyword: 'Are you sure you want to delete this message?'
    },
    {
      fileRelPath: 'src/components/chat/ChatHeader.tsx',
      titleKeyword: 'Clear chat?',
      descriptionKeyword: 'Are you sure you want to clear all messages'
    },
    {
      fileRelPath: 'src/components/memory/MemoryCard.tsx',
      titleKeyword: 'Delete Directive?',
      descriptionKeyword: 'Are you sure you want to delete this memory directive?'
    },
    {
      fileRelPath: 'src/components/memory/PersonasAndMacrosPanel.tsx',
      titleKeyword: 'Delete Persona?',
      descriptionKeyword: 'Are you sure you want to delete this persona?'
    },
    {
      fileRelPath: 'src/components/rag/FileRepoInspectorAndSearch.tsx',
      titleKeyword: 'Delete Repository Item?',
      descriptionKeyword: 'Are you sure you want to delete this item?'
    },
    {
      fileRelPath: 'src/components/tools/ChatToolsTab.tsx',
      titleKeyword: 'Delete Custom Tool?',
      descriptionKeyword: 'Are you sure you want to delete this custom tool?'
    },
    {
      fileRelPath: 'src/components/analytics/RuntimeLogsPanel.tsx',
      titleKeyword: 'Clear Runtime Logs?',
      descriptionKeyword: 'Are you sure you want to clear all runtime event logs?'
    },
    {
      fileRelPath: 'src/components/orchestrator/OrchestratorSettingsSection.tsx',
      titleKeyword: 'Clear Execution Traces?',
      descriptionKeyword: 'Are you sure you want to clear execution trace history?'
    }
  ];

  for (const item of deleteActions) {
    const fullPath = path.join(ROOT_DIR, ...item.fileRelPath.split('/'));
    assert.equal(
      fs.existsSync(fullPath),
      true,
      `Target component ${item.fileRelPath} must exist`
    );

    const content = fs.readFileSync(fullPath, 'utf-8');
    assert.ok(
      content.includes('ConfirmDeleteModal'),
      `${item.fileRelPath} must import and use ConfirmDeleteModal`
    );
    assert.ok(
      content.includes(item.titleKeyword),
      `${item.fileRelPath} must specify title "${item.titleKeyword}"`
    );
    assert.ok(
      content.includes(item.descriptionKeyword),
      `${item.fileRelPath} must specify description "${item.descriptionKeyword}"`
    );
  }
});

