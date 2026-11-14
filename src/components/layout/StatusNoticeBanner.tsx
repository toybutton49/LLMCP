import React, { useEffect } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { StatusNotice } from '../../hooks/useStatusNotices';

const styles = {
  info: { label: 'Info', icon: Info, className: 'bg-accent-subtle border-accent text-zinc-800 dark:text-zinc-200' },
  success: { label: 'Success', icon: CheckCircle2, className: 'bg-emerald-50 border-emerald-300 text-emerald-900 dark:bg-emerald-950 dark:border-emerald-800 dark:text-emerald-100' },
  warning: { label: 'Warning', icon: AlertTriangle, className: 'bg-orange-50 border-orange-300 text-orange-900 dark:bg-orange-950 dark:border-orange-800 dark:text-orange-100' },
  error: { label: 'Error', icon: AlertCircle, className: 'bg-red-50 border-red-300 text-red-900 dark:bg-red-950 dark:border-red-800 dark:text-red-100' }
};

export function scheduleStatusDismissal(notice: StatusNotice, onDismiss: (id: number) => void) {
  const timeout = setTimeout(() => onDismiss(notice.id), notice.kind === 'warning' || notice.kind === 'error' ? 12000 : 5000);
  return () => clearTimeout(timeout);
}

export function StatusNoticeBanner({ notice, onDismiss }: {
  notice: StatusNotice;
  onDismiss: (id: number) => void;
}) {
  useEffect(() => scheduleStatusDismissal(notice, onDismiss), [notice, onDismiss]);

  const { label, icon: Icon, className } = styles[notice.kind];
  return (
    <div role={notice.kind === 'error' ? 'alert' : 'status'} className={`px-6 py-2 border-b flex items-start gap-2 text-xs ${className}`}>
      <Icon aria-hidden="true" className="w-4 h-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words"><strong>{label}:</strong> {notice.message}</span>
      <button type="button" onClick={() => onDismiss(notice.id)} aria-label={`Dismiss ${label.toLowerCase()} notification`} className="underline font-medium ml-4 cursor-pointer">
        Dismiss
      </button>
    </div>
  );
}
