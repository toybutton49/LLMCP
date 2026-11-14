import { useCallback, useRef, useState } from 'react';

export type StatusNoticeKind = 'info' | 'success' | 'warning' | 'error';

export interface StatusNotice {
  id: number;
  message: string;
  kind: StatusNoticeKind;
}

export function useStatusNotices() {
  const [statusNotices, setStatusNotices] = useState<StatusNotice[]>([]);
  const nextId = useRef(0);

  const setStatusNotice = useCallback((message: string | null, kind: StatusNoticeKind = 'info') => {
    if (message === null) {
      setStatusNotices([]);
      return;
    }
    const notice = { id: ++nextId.current, message, kind };
    setStatusNotices((current) => [
      ...current.filter((item) => item.message !== message || item.kind !== kind),
      notice
    ]);
  }, []);

  const dismissStatusNotice = useCallback((id: number) => {
    setStatusNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  return { statusNotices, setStatusNotice, dismissStatusNotice };
}
