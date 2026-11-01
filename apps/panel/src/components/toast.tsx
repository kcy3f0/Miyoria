import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

type ToastTone = "ok" | "danger" | "info";
interface Toast {
  id: number;
  tone: ToastTone;
  text: string;
}

const ToastContext = createContext<((tone: ToastTone, text: string) => void) | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const push = useCallback(
    (tone: ToastTone, text: string) => {
      const id = nextId++;
      setToasts((t) => [...t.slice(-3), { id, tone, text }]);
      window.setTimeout(() => dismiss(id), tone === "danger" ? 8000 : 4000);
    },
    [dismiss],
  );

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => {
          const Icon = t.tone === "ok" ? CircleCheck : t.tone === "danger" ? CircleAlert : Info;
          return (
            <div className="toast" data-tone={t.tone} key={t.id}>
              <Icon aria-hidden />
              <span className="toast__text">{t.text}</span>
              <button type="button" className="btn btn--ghost btn--sm btn--icon" aria-label="關閉通知" onClick={() => dismiss(t.id)}>
                <X aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastContext);
  if (!push) throw new Error("useToast outside ToastProvider");
  return push;
}
