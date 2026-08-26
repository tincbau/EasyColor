import { useCallback, useRef, useState } from 'react';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface ToastApi {
  toasts: Toast[];
  notify: (message: string, kind?: ToastKind) => void;
  dismiss: (id: number) => void;
}

const DURATION: Record<ToastKind, number> = {
  info: 3200,
  success: 3200,
  // Errors stay long enough to actually be read; several of them carry
  // instructions the user needs to act on.
  error: 8000,
};

export function useToasts(): ToastApi {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-3), { id, kind, message }]);
      window.setTimeout(() => dismiss(id), DURATION[kind]);
    },
    [dismiss],
  );

  return { toasts, notify, dismiss };
}
