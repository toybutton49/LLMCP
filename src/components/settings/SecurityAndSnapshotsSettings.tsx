import React, { useState } from 'react';
import {
  HardDrive,
  Save,
  Download,
  Upload,
  Lock,
  Unlock,
  ShieldCheck
} from 'lucide-react';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';

interface SecurityAndSnapshotsSettingsProps {
  storagePath: string;
  databaseFilePath: string;
  hasMasterPassphrase?: boolean;
  vaultLocked?: boolean;
  onSaveDatabasePath: (databaseFilePath: string) => Promise<void>;
  onExportWorkspaceJson: () => void;
  onImportWorkspaceJson: (jsonText: string) => void;
  onRestoreEncryptedWorkspace: (envelope: unknown, passphrase: string) => Promise<void>;
  onExportEncryptedWorkspace: (passphrase: string) => Promise<unknown>;
}

export const SecurityAndSnapshotsSettings: React.FC<SecurityAndSnapshotsSettingsProps> = ({
  storagePath,
  databaseFilePath,
  vaultLocked = false,
  onSaveDatabasePath,
  onExportWorkspaceJson,
  onImportWorkspaceJson,
  onRestoreEncryptedWorkspace,
  onExportEncryptedWorkspace
}) => {
  const [dbPathInput, setDbPathInput] = useState(databaseFilePath || storagePath || '.local-data/llmcp-db.json');
  const [storageNotice, setStorageNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [importNotice, setImportNotice] = useState<string | null>(null);

  // AES-256-GCM Encrypted Snapshot State
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [encryptedFile, setEncryptedFile] = useState<File | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [cryptoNotice, setCryptoNotice] = useState<string | null>(null);
  const [vaultPassphrase, setVaultPassphrase] = useState('');
  const [isVaultLocked, setIsVaultLocked] = useState(vaultLocked);

  const handleSaveStorage = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setStorageNotice(null);
    try {
      await onSaveDatabasePath(dbPathInput.trim());
      setStorageNotice('Database file path saved.');
    } catch {
      setStorageNotice('Failed to persist database path.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      if (!text) return;
      try {
        onImportWorkspaceJson(text);
        setImportNotice(`Restored local database snapshot from ${file.name}`);
      } catch {
        setImportNotice('Invalid JSON snapshot file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleEncryptExport = async () => {
    if (exportPassphrase.trim().length < 8 || exportPassphrase.trim().length > 128) {
      setCryptoNotice('Passphrase must be between 8 and 128 characters.');
      return;
    }
    setIsExporting(true);
    try {
      const envelope = await onExportEncryptedWorkspace(exportPassphrase.trim());
      const blob = new Blob([JSON.stringify(envelope, null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `llmcp-encrypted-vault-${new Date().toISOString().slice(0, 10)}.aes.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setCryptoNotice('Generated and downloaded AES-256-GCM encrypted backup envelope.');
      setExportPassphrase('');
    } catch (error) {
      setCryptoNotice(error instanceof Error ? error.message : 'Export failed.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleEncryptedRestore = async () => {
    if (!encryptedFile) return;
    setIsRestoring(true);
    setCryptoNotice(null);
    try {
      if (encryptedFile.size > 64 * 1024 * 1024) throw new Error('Encrypted snapshot exceeds the 64 MiB import limit.');
      const envelope: unknown = JSON.parse(await encryptedFile.text());
      await onRestoreEncryptedWorkspace(envelope, importPassphrase);
      setCryptoNotice(`Restored encrypted snapshot from ${encryptedFile.name}.`);
      setImportPassphrase('');
      setEncryptedFile(null);
    } catch (error) {
      setCryptoNotice(error instanceof Error ? error.message : 'Encrypted snapshot restore failed.');
    } finally {
      setIsRestoring(false);
    }
  };

  const handleToggleVaultLock = async () => {
    if (!vaultPassphrase.trim()) return;
    try {
      const res = await fetch('/api/local-auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          passphrase: vaultPassphrase.trim(),
          action: isVaultLocked ? 'unlock' : 'lock'
        })
      });
      const data = await res.json();
      if (res.ok) {
        setIsVaultLocked(data.vaultLocked);
        setVaultPassphrase('');
        setCryptoNotice(
          data.vaultLocked
            ? 'Vault locked with PBKDF2 hash.'
            : 'Vault unlocked successfully.'
        );
      } else {
        setCryptoNotice(data.error || 'Invalid passphrase.');
      }
    } catch {
      setCryptoNotice('Auth verification failed.');
    }
  };

  return (
    <div className="space-y-6">
      {/* Database Path Form */}
      <form
        onSubmit={handleSaveStorage}
        className="p-5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50 space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-accent" />
              <span>Local Database Storage</span>
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              JSON file storing chats, memories, personas, and settings. File Repo settings are located under Knowledge.
            </p>
          </div>
        </div>

        {storageNotice && (
          <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-700 dark:text-emerald-300">
            {storageNotice}
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <div className="flex-1">
            <label htmlFor="settings-local-db-path" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              Local Database File Path
            </label>
            <input
              id="settings-local-db-path"
              type="text"
              value={dbPathInput}
              onChange={(e) => setDbPathInput(e.target.value)}
              className="w-full px-3.5 py-2.5 text-xs font-mono rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 focus-accent"
            />
          </div>
          <button
            type="submit"
            disabled={isSaving}
            className="px-4 py-2.5 rounded-lg bg-accent text-zinc-950 text-xs font-semibold flex items-center gap-1.5 cursor-pointer shrink-0"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{isSaving ? 'Saving...' : 'Save Database Path'}</span>
          </button>
        </div>
      </form>

      {/* Snapshot Backup & AES-256-GCM Export */}
      <div className="p-5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50 space-y-4">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-500" />
          <span>Database Snapshots &amp; AES-256-GCM Encryption</span>
        </h3>

        {cryptoNotice && (
          <div className="p-3 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-xs text-zinc-800 dark:text-zinc-200">
            {cryptoNotice}
          </div>
        )}

        {importNotice && (
          <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-700 dark:text-emerald-300">
            {importNotice}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 space-y-3">
            <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
              Plain JSON Snapshot
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Export complete database state as an unencrypted .json file, or restore from a previous backup.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onExportWorkspaceJson}
                className="px-3.5 py-1.5 rounded-lg bg-accent text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export JSON</span>
              </button>
              <label className="px-3.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs font-medium flex items-center gap-1.5 cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <Upload className="w-3.5 h-3.5" />
                <span>Import JSON</span>
                <input
                  type="file"
                  accept=".json"
                  onChange={handleImportFile}
                  className="hidden"
                />
              </label>
            </div>
          </div>

          <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 space-y-3">
            <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
              AES-256-GCM Encrypted Snapshot
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Encrypt your entire database with an AES-256-GCM key derived via PBKDF2 (100,000 rounds).
            </p>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={exportPassphrase}
                onChange={(e) => setExportPassphrase(e.target.value)}
                placeholder="Passphrase (min 8 chars)"
                className="flex-1 px-3.5 py-2 text-xs rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 focus-accent"
              />
              <button
                type="button"
                onClick={handleEncryptExport}
                disabled={isExporting}
                className="px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold cursor-pointer shrink-0"
              >
                Encrypt &amp; Download
              </button>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Restore replaces the database. Original File Repo files are not included in the snapshot.
            </p>
            <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Encrypted Snapshot File
              <input
                type="file"
                accept=".json,application/json"
                disabled={isRestoring}
                onChange={(event) => {
                  setEncryptedFile(event.target.files?.[0] || null);
                  event.target.value = '';
                }}
                className="block w-full mt-1.5 text-xs"
              />
              {encryptedFile && <span>Selected: {encryptedFile.name}</span>}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="password"
                aria-label="Encrypted snapshot passphrase"
                value={importPassphrase}
                onChange={(event) => setImportPassphrase(event.target.value)}
                placeholder="Snapshot passphrase"
                disabled={isRestoring}
                className="flex-1 px-3.5 py-2 text-xs rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 focus-accent"
              />
              <button
                type="button"
                disabled={isRestoring || !encryptedFile || importPassphrase.trim().length < 4}
                onClick={() => setConfirmRestore(true)}
                className="px-3.5 py-2 rounded-lg bg-accent text-zinc-950 text-xs font-semibold cursor-pointer disabled:opacity-50 shrink-0"
              >
                {isRestoring ? 'Restoring...' : 'Restore Encrypted'}
              </button>
            </div>
          </div>
        </div>
      </div>
      <ConfirmDeleteModal
        isOpen={confirmRestore}
        onClose={() => setConfirmRestore(false)}
        onConfirm={() => { void handleEncryptedRestore(); }}
        title="Restore encrypted snapshot?"
        description="This replaces the current database. Back up current changes first. Original File Repo files are not restored."
        itemName={encryptedFile?.name}
        confirmLabel="Restore"
      />
    </div>
  );
};
